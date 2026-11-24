import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { Order } from '../models/Order.js';
import { Singleton } from '../models/Singleton.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { nextInvoiceNo, formatInvoice } from '../invoicing.js';
import { settingsReady } from '../validators.js';
import { recomputeCustomer } from '../crm.js';
import { newForwardAwb } from '../awb.js';

// Public, no-auth webhook endpoints called by third-party gateways. The
// request body is the gateway's HMAC-signed JSON; we verify the signature
// against a secret shared between us and the gateway (set in their
// dashboard). On signature failure we reject with 400 so the gateway
// retries with backoff.
//
// IMPORTANT: webhook signature verification requires the EXACT raw body
// bytes. If express.json() runs first, the body is parsed and re-stringified
// which can reorder keys / drop whitespace, breaking HMAC. The router is
// mounted BEFORE express.json() in server.js and uses express.raw() so the
// Buffer survives intact.

export const webhooksRouter = Router();

// POST /api/webhooks/razorpay
// Razorpay sends every payment event (payment.captured, payment.failed,
// payment.authorized, refund.* etc.) here when configured in the dashboard.
// We only need `payment.captured` and `payment.failed` for storefront
// orders — the admin's existing refund flow handles the rest.
webhooksRouter.post(
  '/razorpay',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    if (!secret) {
      console.warn('[webhooks] RAZORPAY_WEBHOOK_SECRET not set — webhook rejected');
      return res.status(503).json({ error: 'Webhook secret not configured' });
    }
    const signature = req.headers['x-razorpay-signature'];
    if (!signature || typeof signature !== 'string') {
      return res.status(400).json({ error: 'Missing signature header' });
    }
    // req.body here is a Buffer because of express.raw() above.
    const rawBody = req.body instanceof Buffer ? req.body : Buffer.from('');
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (expected !== signature) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const event = String(payload?.event || '');
    const entity = payload?.payload?.payment?.entity || {};
    // Razorpay's `notes` object was supplied when we created the order; we
    // stashed our internal order id there so we can map back without a lookup.
    const ourOrderId = entity?.notes?.ourOrderId || '';
    const rzpPaymentId = entity?.id || '';
    const rzpOrderId = entity?.order_id || '';

    if (!ourOrderId) {
      // Nothing to reconcile — webhook was for an entity we didn't create.
      // Return 200 so Razorpay doesn't retry; log for visibility.
      console.warn(`[webhooks/razorpay] ${event} with no ourOrderId in notes`, { rzpPaymentId });
      return res.json({ ok: true, ignored: true });
    }

    const order = await Order.findById(ourOrderId);
    if (!order) {
      console.warn(`[webhooks/razorpay] order ${ourOrderId} not found for ${event}`);
      return res.json({ ok: true, ignored: true });
    }

    if (event === 'payment.captured') {
      // Idempotent — the client-side verify may have already marked the
      // order Paid. If so, no-op and acknowledge so Razorpay stops retrying.
      if (order.payment?.status === 'Paid') {
        return res.json({ ok: true, alreadyPaid: true });
      }
      order.payment.status = 'Paid';
      order.payment.rzp = rzpPaymentId;
      order.status = 'Label generated';
      order.ship.courier = order.ship.courier || 'Delhivery';
      order.ship.awb = order.ship.awb || newForwardAwb();
      if (!order.invoice) {
        const sett = await Singleton.findById('settings').lean();
        const ready = settingsReady(sett?.data);
        if (ready.ok) {
          const now = new Date();
          order.invoice = formatInvoice(now, await nextInvoiceNo(now));
        }
      }
      await order.save();
      await recomputeCustomer(order.cid);
      return res.json({ ok: true, captured: true });
    }

    if (event === 'payment.failed') {
      // Don't flip the order to Cancelled here — the client-side onFailure
      // / onDismiss in CheckoutPopup already does that and releases pieces.
      // Just record the attempt for the audit trail. If the order IS still
      // pending by the time this webhook fires, the next-run reconciliation
      // can act on it.
      console.warn(`[webhooks/razorpay] payment.failed on ${ourOrderId}`, {
        rzpPaymentId, reason: entity?.error_description || entity?.error_reason,
      });
      return res.json({ ok: true, logged: true });
    }

    // Unhandled event — acknowledge so Razorpay stops retrying, but don't
    // touch the order.
    return res.json({ ok: true, unhandled: event });
  }),
);
