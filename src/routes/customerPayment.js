import { Router } from 'express';
import crypto from 'crypto';
import { Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { Customer } from '../models/Customer.js';
import { Singleton } from '../models/Singleton.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { reservePiecesForOrder, releasePiecesForOrder } from './pieces.js';
import { newForwardAwb } from '../awb.js';
import { nextInvoiceNo, formatInvoice } from '../invoicing.js';
import { settingsReady } from '../validators.js';
import { recomputeCustomer } from '../crm.js';
import { config } from '../config.js';
import { Return } from '../models/Return.js';
import { checkReturnEligibility } from './returns.js';
import { Coupon } from '../models/Coupon.js';
import { validateCoupon } from '../coupons.js';

// Customer-side order + payment routes. Lives separately from customerAuth
// so the Razorpay wiring and the order-persistence layer stay readable.
// Mounted under /api/customer-auth/ so the storefront can use one base path.

export const customerPaymentRouter = Router();

// Reuse the requireCustomer guard pattern from customerAuth — ensures the
// bearer token belongs to an actual Customer doc and isn't past its
// tokenInvalidBefore timestamp. Duplicated here to keep this file
// self-contained; identical semantics.
const requireCustomer = asyncHandler(async (req, res, next) => {
  if (req.user?.role !== 'customer') return res.status(401).json({ error: 'Not a customer token' });
  const customer = await Customer.findById(req.user.sub);
  if (!customer) return res.status(401).json({ error: 'Account no longer exists' });
  if (customer.tokenInvalidBefore && req.user.iat) {
    const iatMs = req.user.iat * 1000;
    if (iatMs < customer.tokenInvalidBefore.getTime()) {
      return res.status(401).json({ error: 'Session ended, please sign in again' });
    }
  }
  req.customer = customer;
  next();
});

// Lazy Razorpay client — constructed once per process, but only when the
// keys are configured AND the npm package is actually installed. Routes
// that need it should await `getRazorpay()` and fail with 503 when it
// returns null, so (a) dev environments without keys get a clear error
// instead of a confusing stacktrace from inside the SDK, and (b) a fresh
// checkout without `npm install razorpay` still boots the server — only
// the /payment/order route surfaces the missing dep.
let rzpClient = null;
let rzpImportFailed = false;
async function getRazorpay() {
  if (rzpClient) return rzpClient;
  const { keyId, keySecret } = config.razorpay;
  if (!keyId || !keySecret) return null;
  if (rzpImportFailed) return null;
  try {
    const { default: Razorpay } = await import('razorpay');
    rzpClient = new Razorpay({ key_id: keyId, key_secret: keySecret });
    return rzpClient;
  } catch (err) {
    console.warn('[razorpay] npm package not installed — payment routes will 503. Run `npm install razorpay` in backend/ to enable.', err?.message || '');
    rzpImportFailed = true;
    return null;
  }
}

// Short, sortable, URL-safe order id. Prefix `GR` matches the seed data
// convention so admin lists don't need to distinguish customer-placed
// orders from seed rows.
function newOrderId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `GR-${ts}${rand}`;
}

// ─── Customer orders ──────────────────────────────────────────────────

// POST /api/customer-auth/orders
// Body: { items: [{ pid, vid?, qty }], shipping?, coupon?, discount?,
//         paymentMethod: 'upi'|'card'|'netbanking'|'cod', address }
// Creates an Order in Mongo with status='Payment pending'. Reserves pieces
// so the user's variants aren't sold under them while they're on the
// Razorpay modal. On COD the order is created in 'Payment pending' too;
// a separate confirm route flips it since no gateway callback fires.
customerPaymentRouter.post('/orders', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Cart is empty' });
  const paymentMethod = String(body.paymentMethod || 'upi').toLowerCase();
  const address = body.address || {};
  if (!address.pin) return res.status(400).json({ error: 'Delivery address missing a pincode' });

  // Price every line against the live catalogue so a tampered cart can't
  // undercharge. The client's qty is trusted; prices are not.
  const pids = [...new Set(items.map((i) => String(i.pid)).filter(Boolean))];
  const products = await Product.find({ _id: { $in: pids }, status: 'Active' }).lean();
  const byId = new Map(products.map((p) => [p._id, p]));
  const lines = [];
  let sub = 0;
  for (const raw of items) {
    const p = byId.get(String(raw.pid));
    if (!p) return res.status(400).json({ error: `Unknown product ${raw.pid}` });
    const qty = Math.max(1, Math.floor(Number(raw.qty) || 1));
    const price = Number(p.price) || 0;
    lines.push({ pid: p._id, vid: raw.vid || null, qty, price });
    sub += price * qty;
  }
  const shipping = Math.max(0, Number(body.shipping) || 0);

  // CPN-03: when a coupon is attached, recompute the discount server-side
  // against the live catalogue + the signed-in customer's history. The
  // client is NOT trusted — a tampered payload that sends a coupon code
  // with a fabricated discount is caught here and either corrected (if
  // the coupon is still valid) or rejected (if it's expired / off / not
  // eligible). If no coupon is attached the discount must be zero.
  const couponCode = typeof body.coupon === 'string' ? body.coupon.trim() : '';
  let discount = 0;
  if (couponCode) {
    const coupon = await Coupon.findById(couponCode);
    if (!coupon) return res.status(400).json({ error: 'Coupon not found' });
    const productsMap = Object.fromEntries(products.map((p) => [p._id, p]));
    const result = validateCoupon({
      coupon: coupon.toObject(),
      customer: req.customer?.toObject ? req.customer.toObject() : req.customer,
      items: lines,
      products: productsMap,
    });
    if (!result.ok) return res.status(400).json({ error: result.reason || 'Coupon not applicable' });
    discount = Math.max(0, Number(result.discount) || 0);
  }

  // GST — kept server-side so the Razorpay amount can't be short-charged
  // by a tampered client. Must match the GST_RATE constant in
  // CheckoutPopup.tsx (0.05 = 5%); changing this requires updating both.
  // Tax is applied to (sub - discount + shipping), i.e. the amount the
  // customer actually pays, matching the storefront's displayed total.
  const GST_RATE = 0.05;
  const taxable = Math.max(0, sub - discount + shipping);
  const tax = Math.round(taxable * GST_RATE);
  const total = taxable + tax;

  const order = await Order.create({
    _id: newOrderId(),
    placed: new Date().toISOString(),
    cid: req.customer._id,
    items: lines,
    sub,
    coupon: body.coupon || null,
    discount,
    shipping,
    tax,
    total,
    payment: {
      method: paymentMethod === 'cod' ? 'Cash on delivery' : 'Prepaid',
      status: 'Payment pending',
      rzp: null,
    },
    status: 'Payment pending',
    ship: {
      pin: String(address.pin),
      courier: null,
      awb: null,
    },
    source: 'Storefront',
  });

  // Reserve pieces now so the user's variants aren't sold during the
  // Razorpay modal. If reservation fails (409) release nothing and bail —
  // the user hasn't been charged. The order stays with status='Payment
  // pending' and no pieces so a subsequent retry starts clean.
  try {
    await reservePiecesForOrder(order, { by: `customer:${req.customer._id}` });
  } catch (e) {
    await Order.deleteOne({ _id: order._id });
    if (e.status === 409) return res.status(409).json({ error: 'Not enough stock to fulfil the order', details: e.details });
    throw e;
  }

  // Mirror onto the customer doc's `orders` array so /account/orders can
  // list without a join.
  req.customer.orders = Array.from(new Set([...(req.customer.orders || []), order._id]));
  await req.customer.save();

  res.status(201).json(order.toObject());
}));

// GET /api/customer-auth/orders — list orders for the signed-in customer.
customerPaymentRouter.get('/orders', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const items = await Order.find({ cid: req.customer._id }).sort({ placed: -1 }).lean();
  res.json({ items, total: items.length });
}));

// GET /api/customer-auth/orders/:id — one order, scoped to the signed-in
// customer so another customer's order can't be fetched by guessing the id.
customerPaymentRouter.get('/orders/:id', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, cid: req.customer._id }).lean();
  if (!o) return res.status(404).json({ error: 'Order not found' });
  res.json(o);
}));

// POST /api/customer-auth/orders/:id/cancel — customer-initiated cancel of
// an unpaid order. Releases reserved pieces. Already-paid orders can't be
// cancelled here; those go through the admin's refund flow.
customerPaymentRouter.post('/orders/:id/cancel', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, cid: req.customer._id });
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.payment?.status === 'Paid') {
    return res.status(409).json({ error: 'Paid orders cannot be self-cancelled. Contact support for a refund.' });
  }
  await releasePiecesForOrder(o, 'Customer cancelled before payment', { by: `customer:${req.customer._id}` });
  o.status = 'Cancelled';
  o.payment.status = 'Cancelled';
  await o.save();
  res.json(o.toObject());
}));

// ─── Razorpay ─────────────────────────────────────────────────────────

// POST /api/customer-auth/payment/order
// Body: { orderId }
// Scopes the lookup to the customer, then asks Razorpay to create an order
// on their side. Returns the Razorpay order id + our key id so the Checkout
// Standard modal can be opened on the client. Amounts are always in paise
// (Razorpay convention: smallest currency unit).
customerPaymentRouter.post('/payment/order', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const rzp = await getRazorpay();
  if (!rzp) return res.status(503).json({ error: 'Payment gateway not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the backend env.' });
  const ourOrderId = String(req.body?.orderId || '');
  if (!ourOrderId) return res.status(400).json({ error: 'orderId is required' });
  const o = await Order.findOne({ _id: ourOrderId, cid: req.customer._id });
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.payment?.status === 'Paid') return res.status(409).json({ error: 'Order is already paid' });
  if (o.payment?.method === 'Cash on delivery') return res.status(400).json({ error: 'COD orders do not use Razorpay' });

  // receipt is a short free-form string the gateway stores alongside its
  // own id — use our order id so refunds / disputes can be traced back.
  const rzpOrder = await rzp.orders.create({
    amount: Math.round(Number(o.total) * 100), // paise
    currency: 'INR',
    receipt: o._id,
    notes: { ourOrderId: o._id, customerEmail: req.customer.email || '' },
  });

  res.json({
    rzpOrderId: rzpOrder.id,
    amount: rzpOrder.amount,
    currency: rzpOrder.currency,
    keyId: config.razorpay.keyId,
    customer: {
      name: req.customer.name || '',
      email: req.customer.email || '',
      phone: req.customer.phone || '',
    },
  });
}));

// POST /api/customer-auth/payment/verify
// Body: { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Validates the HMAC Razorpay signs with our secret, then marks the order
// Paid + generates an invoice if the seller details are complete. Pieces
// are already reserved from the create-order step, so this just flips the
// status + records the Razorpay payment id for the audit trail.
customerPaymentRouter.post('/payment/verify', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!orderId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment verification fields' });
  }
  if (!config.razorpay.keySecret) {
    return res.status(503).json({ error: 'Payment gateway not configured' });
  }

  // Signature is HMAC-SHA256 of `<rzp_order_id>|<rzp_payment_id>` keyed by
  // our Razorpay secret. Reject on any mismatch — never trust the client's
  // claim that the payment succeeded.
  const expected = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment signature verification failed' });
  }

  const o = await Order.findOne({ _id: orderId, cid: req.customer._id });
  if (!o) return res.status(404).json({ error: 'Order not found' });
  // Idempotent: a double-fire from the browser (user refreshes) should
  // return the same success rather than error out.
  if (o.payment?.status === 'Paid') return res.json(o.toObject());

  o.payment.status = 'Paid';
  o.payment.rzp = razorpay_payment_id;
  o.status = 'Label generated';
  o.ship.courier = o.ship.courier || 'Delhivery';
  o.ship.awb = o.ship.awb || newForwardAwb();

  // Invoice number is assigned only when seller details on Settings are
  // complete — mirrors the admin's confirm-payment behaviour. If the admin
  // hasn't filled GSTIN / name etc., the order still records as paid; the
  // invoice can be issued later from the admin retry route.
  if (!o.invoice) {
    const sett = await Singleton.findById('settings').lean();
    const ready = settingsReady(sett?.data);
    if (ready.ok) {
      const now = new Date();
      o.invoice = formatInvoice(now, await nextInvoiceNo(now));
    }
  }
  await o.save();
  await recomputeCustomer(o.cid);
  res.json(o.toObject());
}));

// ─── Refund / return requests ─────────────────────────────────────────

// GET /api/customer-auth/orders/:id/refund-eligibility
// Lets the account page show "Request refund" only when the order was
// actually delivered inside the window. Returns the same shape the admin
// eligibility check uses so the UI can quote the window + days remaining.
customerPaymentRouter.get(
  '/orders/:id/refund-eligibility',
  requireAuth,
  requireCustomer,
  asyncHandler(async (req, res) => {
    const o = await Order.findOne({ _id: req.params.id, cid: req.customer._id }).lean();
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const result = await checkReturnEligibility(o._id);
    res.json(result);
  }),
);

// POST /api/customer-auth/orders/:id/refund-request
// Body: { reason, pid?, photos?: [string] }
// Creates a Return doc in 'Requested' status so the admin's queue picks
// it up. The admin's existing approve/pickup/refund workflow takes over
// from there — we don't duplicate any of that machinery here. Eligibility
// is re-checked server-side (don't trust the client's claim that the
// order is in-window). `pid` is optional; when a customer returns a
// specific line item, they identify which one. Omitted = whole-order refund.
customerPaymentRouter.post(
  '/orders/:id/refund-request',
  requireAuth,
  requireCustomer,
  asyncHandler(async (req, res) => {
    const o = await Order.findOne({ _id: req.params.id, cid: req.customer._id });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.payment?.status !== 'Paid') {
      return res.status(409).json({ error: 'Only paid orders can be refunded' });
    }
    const body = req.body || {};
    const reason = String(body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Please tell us why you want a refund' });

    const eligibility = await checkReturnEligibility(o._id);
    if (!eligibility.eligible) {
      return res.status(409).json({
        error: eligibility.reason || `Return window of ${eligibility.windowDays} days has passed`,
        ...eligibility,
      });
    }

    // Validate pid belongs to the order if provided; prevents a customer
    // from logging a refund against a product that was never in this order.
    const pid = body.pid ? String(body.pid) : '';
    const line = pid ? o.items.find((it) => it.pid === pid) : null;
    if (pid && !line) return res.status(400).json({ error: `Product ${pid} is not in this order` });

    // Guard against duplicate Requested rows for the same order+pid pair
    // (user clicks the button twice; stale tab resubmits).
    const existing = await Return.findOne({
      oid: o._id,
      pid: pid || { $in: [null, ''] },
      status: { $in: ['Requested', 'Pickup scheduled', 'Picked up', 'Received'] },
    });
    if (existing) {
      return res.status(409).json({
        error: 'A refund request for this order is already in progress',
        return: existing.toObject(),
      });
    }

    const photos = Array.isArray(body.photos)
      ? body.photos.filter((u) => typeof u === 'string' && u.trim()).slice(0, 6)
      : [];

    const retId = `RT-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
    const amount = line ? line.price * line.qty : o.total;
    const doc = await Return.create({
      _id: retId,
      oid: o._id,
      pid: pid || null,
      cid: o.cid,
      reason,
      requested: new Date().toISOString().slice(0, 10),
      amount,
      status: 'Requested',
      deliveredAt: eligibility.deliveredAt,
      windowDays: eligibility.windowDays,
      photos,
    });
    res.status(201).json(doc.toObject());
  }),
);

// GET /api/customer-auth/orders/:id/returns
// Lists refund requests the customer has filed against an order so the
// account page can show their current status without a second roundtrip.
customerPaymentRouter.get(
  '/orders/:id/returns',
  requireAuth,
  requireCustomer,
  asyncHandler(async (req, res) => {
    const o = await Order.findOne({ _id: req.params.id, cid: req.customer._id }).lean();
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const items = await Return.find({ oid: o._id, cid: req.customer._id })
      .sort({ requested: -1 })
      .lean();
    res.json({ items, total: items.length });
  }),
);

// POST /api/customer-auth/payment/cancel
// Body: { orderId }
// Called when the user dismisses the Razorpay modal without paying, or the
// modal errors. Releases the reserved pieces and marks the order as
// Cancelled so the customer sees a clean state and the stock becomes
// available again.
customerPaymentRouter.post('/payment/cancel', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const o = await Order.findOne({ _id: String(req.body?.orderId || ''), cid: req.customer._id });
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.payment?.status === 'Paid') return res.status(409).json({ error: 'Order is already paid' });
  await releasePiecesForOrder(o, 'Payment cancelled by customer', { by: `customer:${req.customer._id}` });
  o.status = 'Cancelled';
  o.payment.status = 'Cancelled';
  await o.save();
  res.json({ ok: true });
}));
