// Reconcile orders ↔ pieces.
//
// Looks at every Paid or Label-generated order and, for each line item,
// confirms there's a Piece with oid === order._id and status in
// {Reserved, Packed, Sold}. If none exists, the script tries to claim one
// from the In-stock pool for the same variant (or, as a fallback, any
// in-stock piece of the same product).
//
// Fixes the state where an order went through a window when reservation
// wasn't wired: the order is Paid but no piece is held against it, so the
// admin's "in stock" count overstates reality.
//
// Usage:
//   MONGO_URI=... node scripts/reconcile-order-reservations.js          # dry run (default)
//   MONGO_URI=... node scripts/reconcile-order-reservations.js --apply  # actually reserve
//
// Read-only unless --apply is passed.

import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.js';
import { Piece } from '../src/models/Piece.js';
import { Movement } from '../src/models/Movement.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');

// Order statuses that imply the stock should be held. Matches what
// reservePiecesForOrder does on the live path.
const PAID_STATUSES = ['Label generated', 'In transit', 'Delivered'];

async function nextMoveId() {
  const last = await Movement.findOne().sort({ _id: -1 }).select('_id').lean();
  const n = last?._id ? parseInt(String(last._id).replace(/^M/, ''), 10) : 0;
  return `M${(Number.isFinite(n) ? n : 0) + 1}`;
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI env var is required. Copy it from backend/.env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  // Find every paid order the reservation system should be holding stock
  // against. Also includes orders with payment.status === 'Paid' even if
  // their top-level status is something else (edge case).
  const orders = await Order.find({
    $or: [
      { status: { $in: PAID_STATUSES } },
      { 'payment.status': 'Paid' },
    ],
  }).lean();
  console.log(`Scanning ${orders.length} paid order(s)…\n`);

  const plan = []; // { oid, pid, vid, piece | null }
  for (const o of orders) {
    for (let idx = 0; idx < (o.items || []).length; idx++) {
      const it = o.items[idx];
      // Is there already a piece held for this order+pid (optionally vid)?
      const heldFilter = { oid: o._id, pid: it.pid, status: { $in: ['Reserved', 'Packed', 'Sold'] } };
      if (it.vid) heldFilter.vid = it.vid;
      const already = await Piece.findOne(heldFilter).lean();
      if (already) continue;

      // Not held. Find a piece to claim. Vid-matched first, then any
      // in-stock piece of the product.
      const vidCandidate = it.vid
        ? await Piece.findOne({ vid: it.vid, status: 'In stock', oid: null }).sort({ received: 1 }).lean()
        : null;
      const anyCandidate = vidCandidate
        || await Piece.findOne({ pid: it.pid, status: 'In stock', oid: null }).sort({ received: 1 }).lean();
      plan.push({ oid: o._id, lineIdx: idx, pid: it.pid, vid: it.vid || null, piece: anyCandidate || null });
    }
  }

  if (!plan.length) {
    console.log('All paid orders already have pieces reserved. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  const fixable = plan.filter((p) => p.piece);
  const stuck = plan.filter((p) => !p.piece);

  console.log(`${plan.length} order line(s) with no piece held:`);
  for (const p of plan) {
    const tag = p.piece ? `→ will claim ${p.piece._id} (${p.piece.vid})` : '→ NO IN-STOCK PIECE AVAILABLE (needs manual receive)';
    console.log(`  oid=${p.oid}  pid=${p.pid}  vid=${p.vid || '-'}  ${tag}`);
  }
  console.log(`\n${fixable.length} fixable, ${stuck.length} stuck (no in-stock piece exists).`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to actually reserve pieces.');
    await mongoose.disconnect();
    return;
  }

  // Apply fixes.
  const at = new Date().toISOString();
  let moved = 0;
  for (const p of fixable) {
    // Re-fetch under the compound filter so another run can't double-claim.
    const claim = await Piece.findOneAndUpdate(
      { _id: p.piece._id, status: 'In stock', oid: null },
      { $set: { status: 'Reserved', oid: p.oid, at } },
      { new: true },
    );
    if (!claim) continue;
    await Movement.create({
      _id: await nextMoveId(),
      code: claim._id, pid: claim.pid, vid: claim.vid,
      from: 'In stock', to: 'Reserved',
      note: `Reconciled after missing reservation (script)`,
      oid: p.oid, by: 'System (reconcile)', at,
    });
    // Also update the order's item.piece pointer so the admin's packing
    // bench can scan against it.
    await Order.updateOne(
      { _id: p.oid },
      { $set: { [`items.${p.lineIdx}.piece`]: claim._id, [`items.${p.lineIdx}.vid`]: claim.vid } },
    );
    moved += 1;
  }
  console.log(`\nReserved ${moved} piece(s). ${stuck.length} line(s) still need a receive on the Inventory page.`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
