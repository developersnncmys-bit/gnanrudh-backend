// Reconciles pieces whose vid is no longer in the product's variants array.
//
// Problem: every time a variant is re-created in the admin, a new vid is
// generated instead of re-using the old one. Pieces stay tied to the old
// vid, so they become invisible in the admin (which only renders rows
// for current variants) but still occupy the DB. A customer order placed
// before the variant was edited keeps the Reserved piece pointing at a
// ghost vid — admin sees "3 in stock, 0 reserved" when reality is
// "3 In stock on current vid + 1 Reserved on an orphan vid".
//
// What this script does per orphaned piece (status 'In stock'):
//   - Deletes it. It's not reachable from the admin and will just inflate
//     the piece pool forever.
//
// What it does per orphaned piece in a non-terminal non-In-stock status
// (Reserved / Packed):
//   - Re-points to the product's FIRST current variant (preserves status).
//   - This way a Paid order's reservation becomes visible on the admin UI
//     so staff can pack + ship it.
//
// Terminal statuses (Sold / Shipped / Returned / Written off) are left
// alone — they're historical records.
//
// Usage:
//   MONGO_URI=... node scripts/reconcile-orphan-variants.js          # dry run
//   MONGO_URI=... node scripts/reconcile-orphan-variants.js --apply  # actually do it

import 'dotenv/config';
import mongoose from 'mongoose';
import { Piece } from '../src/models/Piece.js';
import { Product } from '../src/models/Product.js';
import { Movement } from '../src/models/Movement.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');

// Matches the generator in src/routes/pieces.js so ids follow the same
// MV<n><ts-suffix> pattern. The timestamp suffix makes collisions with
// other concurrent writers (admin bench, other scripts) extremely unlikely.
// A short cursor on top so the suffix changes even inside one loop iteration.
let moveSuffixCursor = 0;
async function nextMoveId() {
  const n = await Movement.estimatedDocumentCount();
  moveSuffixCursor += 1;
  const suffix = (Date.now() + moveSuffixCursor).toString(36).slice(-5);
  return `MV${n + moveSuffixCursor}${suffix}`;
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI env var is required.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const products = await Product.find({}).select('_id name variants').lean();
  const currentByPid = new Map(
    products.map((p) => [p._id, new Set((p.variants || []).map((v) => v.id))]),
  );
  const firstVariantByPid = new Map(
    products.map((p) => [p._id, (p.variants || [])[0]?.id || null]),
  );

  const allPieces = await Piece.find({}).sort({ pid: 1 }).lean();
  const orphans = allPieces.filter((p) => {
    const set = currentByPid.get(p.pid);
    if (!set) return false; // product itself is gone; separate problem
    return !set.has(p.vid);
  });

  if (!orphans.length) {
    console.log('No orphaned pieces. Everything matches current product variants.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${orphans.length} orphaned piece(s):\n`);
  const TERMINAL = new Set(['Sold', 'Shipped', 'Returned', 'Written off']);
  const plan = { delete: [], remap: [], skip: [] };
  for (const p of orphans) {
    const action = TERMINAL.has(p.status)
      ? 'skip'
      : p.status === 'In stock'
        ? 'delete'
        : 'remap';
    plan[action].push(p);
    const target = action === 'remap' ? firstVariantByPid.get(p.pid) : null;
    const tag = action === 'skip'
      ? `→ skip (terminal status)`
      : action === 'delete'
        ? `→ delete (orphan, nothing holding it)`
        : target
          ? `→ remap vid → ${target} (preserve ${p.status}, oid=${p.oid})`
          : `→ CANNOT REMAP (product has no current variants)`;
    console.log(`  ${p._id.padEnd(16)} pid=${p.pid} vid=${p.vid} status=${p.status.padEnd(10)} ${tag}`);
  }

  console.log(`\nSummary: ${plan.delete.length} to delete, ${plan.remap.length} to remap, ${plan.skip.length} to leave alone (terminal).`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to actually write.');
    await mongoose.disconnect();
    return;
  }

  // Apply.
  const at = new Date().toISOString();
  for (const p of plan.delete) {
    await Piece.deleteOne({ _id: p._id });
    await Movement.create({
      _id: await nextMoveId(),
      code: p._id, pid: p.pid, vid: p.vid,
      from: p.status, to: 'Written off',
      note: 'Orphaned variant cleanup (script)',
      by: 'System (reconcile)', at,
    });
  }
  for (const p of plan.remap) {
    const target = firstVariantByPid.get(p.pid);
    if (!target) continue;
    await Piece.updateOne({ _id: p._id }, { $set: { vid: target, at } });
    await Movement.create({
      _id: await nextMoveId(),
      code: p._id, pid: p.pid, vid: target,
      from: p.status, to: p.status,
      note: `Re-pointed from orphan vid ${p.vid} → ${target} (script)`,
      oid: p.oid, by: 'System (reconcile)', at,
    });
  }

  console.log(`\nApplied. Deleted ${plan.delete.length}, remapped ${plan.remap.length}.`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
