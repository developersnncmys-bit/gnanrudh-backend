import mongoose from 'mongoose';

const ShipEventSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  oid: { type: String, index: true },
  type: String,
  at: { type: String, index: true },
  courier: String,
  awb: String,
  // SHIP-01 webhook state:
  //  'Received' — delivered by the courier's system, nothing else to do
  //  'Retrying' — we failed to confirm; next attempt at `webhookNextAt`
  //  'Failed'   — attempts exhausted; a human needs to look
  webhook: { type: String, default: 'Received', enum: ['Received', 'Retrying', 'Failed'] },
  webhookAttempts: { type: Number, default: 0 },
  webhookNextAt: { type: String, default: null, index: true },
  webhookLastErr: { type: String, default: null },
  // Shiprocket's event id. Unique across ShipEvents that actually carry
  // one — the unique+partial index lives below the schema so Mongo only
  // enforces it on documents where the field is a string. Earlier we had
  // { default: null, unique: true, sparse: true } here, but `default: null`
  // writes the field (as null) into every doc, defeating `sparse` and
  // triggering an 11000 on the second non-webhook ShipEvent (admin
  // markDelivered, returns approve, seed, etc.).
  webhookEventId: { type: String },
  detail: { type: String, default: null },
}, { _id: false });

// RET-01: when a 'Delivered' event is saved, forward-populate Order.deliveredAt so
// the returns window can be computed without scanning the full shipping log.
// Uses the model registry late-lookup to avoid a top-level import cycle.
ShipEventSchema.post('save', async function postSave(doc) {
  if (doc?.type !== 'Delivered' || !doc.oid) return;
  try {
    const Order = mongoose.model('Order');
    await Order.updateOne({ _id: doc.oid, deliveredAt: null }, { $set: { deliveredAt: doc.at } });
  } catch (e) { /* non-fatal: next event will retry */ }
});

// PERF-01: compound index for order shipping timeline queries.
ShipEventSchema.index({ oid: 1, at: -1 });

// Unique only on documents that actually carry a Shiprocket event id, so
// a replayed webhook with the same event id collides but admin / seed
// / returns ShipEvents (no event id) coexist freely. Replaces the old
// `{ unique, sparse }` on the field itself — see comment on the field.
ShipEventSchema.index(
  { webhookEventId: 1 },
  { unique: true, partialFilterExpression: { webhookEventId: { $type: 'string' } } },
);

export const ShipEvent = mongoose.model('ShipEvent', ShipEventSchema);
