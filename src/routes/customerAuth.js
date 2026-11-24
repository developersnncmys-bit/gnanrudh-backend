import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Customer } from '../models/Customer.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';

export const customerAuthRouter = Router();

// Customer-only session guard. Runs after requireAuth. Rejects (a) tokens
// minted for a non-customer role, (b) customers whose doc has been deleted,
// and (c) tokens issued before the customer's last logout (see Customer
// .tokenInvalidBefore). Attaches `req.customer` so routes don't re-query.
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

// Serialize a Customer doc into the shape the storefront expects
// (lib/api.ts Customer type). Kept as a helper so login/signup/me all
// return identical payloads.
function toPublicCustomer(c) {
  return {
    id: c._id,
    name: c.name || '',
    firstName: c.firstName || null,
    lastName: c.lastName || null,
    email: c.email || null,
    phone: c.phone || null,
    dob: c.dob || null,
    city: c.city || null,
    state: c.state || null,
    addressBook: Array.isArray(c.addressBook) ? c.addressBook : [],
    wishlist: Array.isArray(c.wishlist) ? c.wishlist : [],
  };
}

// Generate a short, sortable customer id. Collisions are astronomically
// unlikely within the same millisecond; add a 3-char random suffix to
// cover the edge case of concurrent signups.
function newCustomerId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `C-${ts}${rand}`;
}

// Sign a token with role='customer' so requireAuth works but requireRole
// (admin-only) excludes shoppers from staff routes.
function signCustomerToken(customer) {
  return jwt.sign(
    { sub: customer._id, email: customer.email || '', role: 'customer' },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

// POST /api/customer-auth/signup
customerAuthRouter.post('/signup', asyncHandler(async (req, res) => {
  const { firstName, lastName = '', email, phone, password, dob = '' } = req.body || {};
  if (!firstName || !email || !phone || !password) {
    return res.status(400).json({ error: 'First name, email, phone and password are required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const normalisedEmail = String(email).toLowerCase().trim();
  const existing = await Customer.findOne({ email: normalisedEmail });
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const passwordHash = await bcrypt.hash(String(password), 10);
  const fullName = [firstName, lastName].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  const customer = await Customer.create({
    _id: newCustomerId(),
    name: fullName || String(firstName).trim(),
    firstName: String(firstName).trim(),
    lastName: String(lastName || '').trim(),
    email: normalisedEmail,
    phone: String(phone).trim(),
    dob: String(dob || '').trim(),
    passwordHash,
    since: new Date().toISOString().slice(0, 10),
    source: 'Storefront signup',
  });
  const token = signCustomerToken(customer);
  res.status(201).json({ token, customer: toPublicCustomer(customer) });
}));

// POST /api/customer-auth/login
customerAuthRouter.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const customer = await Customer.findOne({ email: String(email).toLowerCase().trim() }).select('+passwordHash');
  if (!customer || !customer.passwordHash) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  const ok = await bcrypt.compare(String(password), customer.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password' });
  const token = signCustomerToken(customer);
  res.json({ token, customer: toPublicCustomer(customer) });
}));

// GET /api/customer-auth/me — validates the current token
customerAuthRouter.get('/me', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  res.json({ customer: toPublicCustomer(req.customer) });
}));

// POST /api/customer-auth/logout — server-side logout. Stamps the customer's
// tokenInvalidBefore so this token (and any other still-valid ones) is
// rejected by requireCustomer from now on. Idempotent: hitting it twice is
// harmless. The client clears its local token after this returns.
customerAuthRouter.post('/logout', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  req.customer.tokenInvalidBefore = new Date();
  await req.customer.save();
  res.json({ ok: true });
}));

// GET /api/customer-auth/wishlist — server-side wishlist for the signed-in
// customer. Mirror of Customer.wishlist. Storefront uses this on every
// sign-in to union with its local (localStorage) wishlist before writing
// back, so items saved while signed-out still land on the account.
customerAuthRouter.get('/wishlist', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  res.json({ items: Array.isArray(req.customer.wishlist) ? req.customer.wishlist : [] });
}));

// PUT /api/customer-auth/wishlist  { ids: string[] } — full replace.
// The Customer model's `set` on `wishlist` collapses dupes/falsy values.
customerAuthRouter.put('/wishlist', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === 'string') : [];
  req.customer.wishlist = ids;
  await req.customer.save();
  res.json({ items: Array.isArray(req.customer.wishlist) ? req.customer.wishlist : [] });
}));

// GET /api/customer-auth/cart — server-stored cart lines for the signed-in
// customer. Used by the storefront's sign-in sync to restore items on a
// fresh device (or after a clear-on-signout).
customerAuthRouter.get('/cart', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  res.json({ items: Array.isArray(req.customer.cart) ? req.customer.cart : [] });
}));

// PUT /api/customer-auth/cart  { items: [{productId, variantId?, quantity}] }
// — full replace. We sanitize each item so bad payloads can't corrupt the
// doc: non-string productIds get dropped, non-finite quantities floor to 1,
// and anything negative is clamped. Dedupes repeated (productId, variantId)
// pairs by summing quantities — a `(pid, null)` and a `(pid, "v1")` line
// are DIFFERENT keys and both survive the dedupe, matching how the
// frontend keys variant-aware cart rows.
customerAuthRouter.put('/cart', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const raw = Array.isArray(req.body?.items) ? req.body.items : [];
  const byKey = new Map();
  for (const it of raw) {
    if (!it || typeof it.productId !== 'string') continue;
    const variantId = typeof it.variantId === 'string' && it.variantId ? it.variantId : null;
    const qty = Number(it.quantity);
    const safeQty = Number.isFinite(qty) ? Math.max(1, Math.floor(qty)) : 1;
    const key = `${it.productId}::${variantId || ''}`;
    const prev = byKey.get(key);
    if (prev) prev.quantity += safeQty;
    else byKey.set(key, { productId: it.productId, variantId, quantity: safeQty });
  }
  req.customer.cart = Array.from(byKey.values());
  await req.customer.save();
  res.json({ items: req.customer.cart });
}));

// ── Address book ───────────────────────────────────────────────────────
// addressBook is a subdocument array keyed by the client-supplied `id`
// string (NOT Mongo _id). Storefront generates ids like `addr-<ts>-<n>`
// optimistically so the UI can render instantly; we accept those ids
// here and the server becomes the canonical mirror. Shape of each item
// matches AddressSchema in models/Customer.js.

function sanitizeAddressBody(body = {}) {
  const pick = (k) => (typeof body[k] === 'string' ? body[k].trim() : undefined);
  const out = {};
  const keys = ['label', 'name', 'phone', 'line1', 'line2', 'city', 'state', 'pin', 'country'];
  for (const k of keys) {
    const v = pick(k);
    if (v !== undefined) out[k] = v;
  }
  if (typeof body.isDefault === 'boolean') out.isDefault = body.isDefault;
  return out;
}

function newAddressId() {
  return `addr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// GET /api/customer-auth/addresses — list the signed-in customer's book.
customerAuthRouter.get('/addresses', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  res.json({ items: Array.isArray(req.customer.addressBook) ? req.customer.addressBook : [] });
}));

// POST /api/customer-auth/addresses — create. Accepts a client-supplied
// `id` so optimistic UI ids survive the round-trip; if duplicate or
// missing, we mint a fresh one. Returns the created address plus the
// full book so the client can reconcile in one hop.
customerAuthRouter.post('/addresses', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const fields = sanitizeAddressBody(req.body);
  const incomingId = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  const taken = req.customer.addressBook.some((a) => a.id === incomingId);
  const id = incomingId && !taken ? incomingId : newAddressId();
  const address = { id, label: 'Home', name: '', phone: '', line1: '', line2: '', city: '', state: '', pin: '', country: 'India', isDefault: false, ...fields };
  // If this is the first address and no isDefault supplied, mark it default.
  if (!req.customer.addressBook.length && address.isDefault === false) {
    address.isDefault = true;
  }
  // Ensure only one default at a time.
  if (address.isDefault) {
    req.customer.addressBook.forEach((a) => { a.isDefault = false; });
  }
  req.customer.addressBook.push(address);
  await req.customer.save();
  res.status(201).json({ address, items: req.customer.addressBook });
}));

// PATCH /api/customer-auth/addresses/:id — partial update by client id.
customerAuthRouter.patch('/addresses/:id', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const id = req.params.id;
  const row = req.customer.addressBook.find((a) => a.id === id);
  if (!row) return res.status(404).json({ error: 'Address not found' });
  const fields = sanitizeAddressBody(req.body);
  Object.assign(row, fields);
  if (fields.isDefault === true) {
    req.customer.addressBook.forEach((a) => { if (a.id !== id) a.isDefault = false; });
  }
  await req.customer.save();
  res.json({ address: row, items: req.customer.addressBook });
}));

// DELETE /api/customer-auth/addresses/:id
customerAuthRouter.delete('/addresses/:id', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const id = req.params.id;
  const before = req.customer.addressBook.length;
  req.customer.addressBook = req.customer.addressBook.filter((a) => a.id !== id);
  if (req.customer.addressBook.length === before) {
    return res.status(404).json({ error: 'Address not found' });
  }
  // If we just removed the default and others remain, promote the first.
  if (req.customer.addressBook.length && !req.customer.addressBook.some((a) => a.isDefault)) {
    req.customer.addressBook[0].isDefault = true;
  }
  await req.customer.save();
  res.json({ ok: true, items: req.customer.addressBook });
}));
