// TAX-03 dry-run report. Lists every invoice (and credit note) whose number is
// out of chronological sequence within its Indian financial year.
//
// Usage:
//   MONGO_URI=... node scripts/report-out-of-sequence-invoices.js
// Add --json for machine-readable output.
//
// Read-only: never modifies data. Rule 3 of the QA brief forbids migrations here.

import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.js';
import { indianFY } from '../src/invoicing.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

function parseGrNumber(s) {
  // Expected shapes: GR/26-27/0167, GR-CN/26-27/0012
  const m = /^(GR(?:-CN)?)\/(\d{2})-(\d{2})\/(\d+)$/.exec(s || '');
  if (!m) return null;
  return { series: m[1], fy: `${m[2]}-${m[3]}`, seq: Number(m[4]) };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const orders = await Order.find({ invoice: { $ne: null } }).sort({ placed: 1 }).lean();

  // For each series+FY, walk in chronological order of `placed` and record any
  // row whose sequence number regresses (seq lower than the previous valid one),
  // or whose FY doesn't match the placed-date FY.
  const buckets = new Map();
  const issues = [];
  for (const o of orders) {
    const parsed = parseGrNumber(o.invoice);
    if (!parsed) { issues.push({ kind: 'malformed', id: o._id, invoice: o.invoice, placed: o.placed }); continue; }
    const expectedFY = indianFY(new Date(o.placed));
    if (parsed.fy !== expectedFY) {
      issues.push({ kind: 'wrong-fy', id: o._id, invoice: o.invoice, placed: o.placed, parsedFY: parsed.fy, expectedFY });
    }
    const key = `${parsed.series}|${parsed.fy}`;
    const prev = buckets.get(key) || { lastSeq: -Infinity, lastId: null };
    if (parsed.seq <= prev.lastSeq) {
      issues.push({ kind: 'out-of-order', id: o._id, invoice: o.invoice, placed: o.placed, seq: parsed.seq, prevSeq: prev.lastSeq, prevId: prev.lastId });
    }
    buckets.set(key, { lastSeq: Math.max(prev.lastSeq, parsed.seq), lastId: o._id });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ total: orders.length, issues }, null, 2));
  } else {
    console.log(`Scanned ${orders.length} invoiced orders.`);
    if (!issues.length) { console.log('No issues found.'); }
    else {
      console.log(`Found ${issues.length} issue(s):`);
      for (const i of issues) {
        if (i.kind === 'malformed') console.log(`  [malformed] ${i.id} placed ${i.placed}: "${i.invoice}"`);
        else if (i.kind === 'wrong-fy') console.log(`  [wrong-fy ] ${i.id} placed ${i.placed}: ${i.invoice} is in FY ${i.parsedFY}, should be FY ${i.expectedFY}`);
        else if (i.kind === 'out-of-order') console.log(`  [sequence ] ${i.id} placed ${i.placed}: seq ${i.seq} regresses from ${i.prevSeq} (prev order ${i.prevId})`);
      }
    }
  }
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
