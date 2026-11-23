// Debug: print every piece + its status for a given product (and the order
// it's held against, if any). Used to diagnose stock-count mismatches
// between the admin UI and the actual DB.
//
// Usage:
//   MONGO_URI=... node scripts/inspect-pieces.js             # all products summary
//   MONGO_URI=... node scripts/inspect-pieces.js P1001       # one product in detail
//   MONGO_URI=... node scripts/inspect-pieces.js --vid KAN-10012   # one variant in detail

import 'dotenv/config';
import mongoose from 'mongoose';
import { Piece } from '../src/models/Piece.js';
import { Product } from '../src/models/Product.js';
import { Order } from '../src/models/Order.js';

const argv = process.argv.slice(2);
const vidFlag = argv.indexOf('--vid');
const filterVid = vidFlag >= 0 ? argv[vidFlag + 1] : null;
const filterPid = argv.find((a) => !a.startsWith('--') && a !== filterVid);

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI env var is required.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const query = {};
  if (filterPid) query.pid = filterPid;
  if (filterVid) query.vid = filterVid;

  const pieces = await Piece.find(query).sort({ pid: 1, vid: 1, _id: 1 }).lean();

  if (!pieces.length) {
    console.log(`No pieces found${filterPid || filterVid ? ' for the given filter' : ' in the DB'}.`);
    await mongoose.disconnect();
    return;
  }

  // Group by pid + vid for readable output.
  const byKey = new Map();
  for (const p of pieces) {
    const key = `${p.pid}::${p.vid}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }

  // Preload product names for context.
  const pids = [...new Set(pieces.map((p) => p.pid))];
  const products = await Product.find({ _id: { $in: pids } }).select('_id name variants').lean();
  const prodById = new Map(products.map((p) => [p._id, p]));

  for (const [key, group] of byKey) {
    const [pid, vid] = key.split('::');
    const prod = prodById.get(pid);
    const variant = prod?.variants?.find((v) => v.id === vid);
    const header = `${pid}  (${prod?.name || 'Unknown product'}) — ${vid}  (${variant?.colour || 'Unknown variant'})`;
    console.log('\n' + header);
    console.log('─'.repeat(header.length));

    // Status breakdown.
    const counts = group.reduce((m, p) => { m[p.status] = (m[p.status] || 0) + 1; return m; }, {});
    const summary = Object.entries(counts).map(([s, n]) => `${s}: ${n}`).join('  |  ');
    console.log(`  Total pieces: ${group.length}   (${summary})`);

    // Per-piece detail.
    for (const p of group) {
      const oidPart = p.oid ? `oid=${p.oid}` : 'oid=(none)';
      console.log(`    ${p._id.padEnd(16)} status=${p.status.padEnd(12)} ${oidPart}`);
    }

    // Cross-check: are the oid references valid?
    const oids = [...new Set(group.map((p) => p.oid).filter(Boolean))];
    if (oids.length) {
      const orders = await Order.find({ _id: { $in: oids } }).select('_id status payment').lean();
      const orderById = new Map(orders.map((o) => [o._id, o]));
      console.log('\n  Orders referenced by these pieces:');
      for (const oid of oids) {
        const o = orderById.get(oid);
        if (o) console.log(`    ${oid}  order_status=${o.status}  payment=${o.payment?.status}`);
        else console.log(`    ${oid}  ⚠ ORDER DOES NOT EXIST (piece is pointing at a deleted order)`);
      }
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
