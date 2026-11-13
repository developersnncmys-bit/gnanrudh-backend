import { Router } from 'express';
import { ShipEvent } from '../models/ShipEvent.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { callShiprocket, nextRetryAt, isExhausted, MAX_ATTEMPTS } from '../shiprocket.js';

const base = crudRouter(ShipEvent, {
  searchFields: ['oid', 'awb', 'type'],
  filterKeys: ['oid', 'courier', 'webhook', 'type'],
  defaultSort: { at: -1 },
});

export const shippingRouter = Router();

// SHIP-01: idempotent webhook ingest. Shiprocket may deliver the same event twice;
// we dedupe by `webhookEventId` (unique sparse index) so a replay is a no-op.
shippingRouter.post('/webhook', asyncHandler(async (req, res) => {
  const { eventId, oid, type, at, courier, awb, detail } = req.body || {};
  if (!eventId) return res.status(400).json({ error: 'eventId is required' });
  // Idempotency: upsert on eventId.
  const doc = await ShipEvent.findOneAndUpdate(
    { webhookEventId: eventId },
    {
      $setOnInsert: {
        _id: `SL${Date.now()}${Math.floor(Math.random() * 1000)}`,
        webhookEventId: eventId, oid, type, at: at || new Date().toISOString(),
        courier, awb, detail,
        webhook: 'Received',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  res.json({ ok: true, event: doc });
}));

// SHIP-01: "Sync now" — actually hit Shiprocket and update status/attempts.
// Replaces the old noop that just flipped webhook to Received.
shippingRouter.post('/:id/sync', asyncHandler(async (req, res) => {
  const s = await ShipEvent.findById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Event not found' });
  if (s.webhook === 'Received') return res.json(s.toObject());
  const next = s.webhookAttempts + 1;
  const r = await callShiprocket(s);
  if (r.ok) {
    s.webhook = 'Received';
    s.webhookAttempts = next;
    s.webhookNextAt = null;
    s.webhookLastErr = null;
  } else if (isExhausted(next)) {
    s.webhook = 'Failed';
    s.webhookAttempts = next;
    s.webhookNextAt = null;
    s.webhookLastErr = r.err;
  } else {
    s.webhook = 'Retrying';
    s.webhookAttempts = next;
    s.webhookNextAt = nextRetryAt(next);
    s.webhookLastErr = r.err;
  }
  await s.save();
  res.json(s.toObject());
}));

// SHIP-01: cron-callable. Picks up to `limit` events whose webhookNextAt is due,
// runs the Shiprocket call for each, updates state. Pointed at by a Vercel Cron
// (daily or every N minutes — see QA-FIXES-REPORT.md).
shippingRouter.post('/retry-due', asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 25));
  const now = new Date().toISOString();
  const due = await ShipEvent.find({
    webhook: 'Retrying',
    webhookNextAt: { $lte: now },
  }).limit(limit);
  const results = { processed: 0, succeeded: 0, failed: 0, retrying: 0 };
  for (const s of due) {
    const next = s.webhookAttempts + 1;
    const r = await callShiprocket(s);
    if (r.ok) { s.webhook = 'Received'; s.webhookNextAt = null; s.webhookLastErr = null; results.succeeded += 1; }
    else if (isExhausted(next)) { s.webhook = 'Failed'; s.webhookNextAt = null; s.webhookLastErr = r.err; results.failed += 1; }
    else { s.webhook = 'Retrying'; s.webhookNextAt = nextRetryAt(next); s.webhookLastErr = r.err; results.retrying += 1; }
    s.webhookAttempts = next;
    await s.save();
    results.processed += 1;
  }
  res.json({ ...results, maxAttempts: MAX_ATTEMPTS });
}));

shippingRouter.use('/', base);
