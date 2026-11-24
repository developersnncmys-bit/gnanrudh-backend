// One-shot fix for the ShipEvent `webhookEventId_1` index.
//
// The old schema had `{ default: null, unique: true, sparse: true }` on
// webhookEventId. The `default: null` wrote the field into every doc,
// defeating `sparse` — the second non-webhook ShipEvent (admin
// markDelivered, returns approve, seed) crashed with E11000 on the
// duplicate `null` key. The schema is now fixed to use a partial unique
// index that only enforces uniqueness on string-typed webhookEventIds,
// but Mongoose does NOT rewrite indexes that already exist in Mongo —
// so the old unique+sparse index has to be dropped manually. That's what
// this script does, along with stripping the lingering null values so
// the new partial index can build cleanly.
//
// Usage:
//   node scripts/fix-shipevent-webhook-index.js
//
// Safe to run more than once — each step no-ops if the DB is already
// in the desired state.

import 'dotenv/config';
import mongoose from 'mongoose';
import { config } from '../src/config.js';

async function main() {
  console.log(`[fix] connecting to ${config.mongoUri}`);
  await mongoose.connect(config.mongoUri);
  const coll = mongoose.connection.db.collection('shipevents');

  const indexes = await coll.indexes();
  const stale = indexes.find((i) => i.name === 'webhookEventId_1');
  if (stale) {
    console.log('[fix] dropping stale index webhookEventId_1', stale);
    await coll.dropIndex('webhookEventId_1');
  } else {
    console.log('[fix] no stale webhookEventId_1 index to drop');
  }

  const stripRes = await coll.updateMany(
    { webhookEventId: null },
    { $unset: { webhookEventId: 1 } },
  );
  console.log(`[fix] stripped null webhookEventId from ${stripRes.modifiedCount} document(s)`);

  console.log('[fix] done. Start the server normally — Mongoose will rebuild the partial index on boot.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[fix] failed:', err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
