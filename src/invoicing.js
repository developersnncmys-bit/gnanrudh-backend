import { Singleton } from './models/Singleton.js';

// TAX-03: Indian financial year runs 1 Apr to 31 Mar.
// indianFY(new Date('2026-11-13')) => "26-27"; new Date('2027-04-01') => "27-28".
// IST-anchored so a 23:45 UTC order on 31 Mar lands in the right FY.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
export function indianFY(date) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const start = m >= 3 ? y : y - 1;
  const pad2 = (n) => String(n % 100).padStart(2, '0');
  return `${pad2(start)}-${pad2(start + 1)}`;
}

// Each FY gets its own counter so numbering is sequential per series.
// kind: 'inv' or 'cn'. data.inv.<fy> / data.cn.<fy> hold the next number.
export async function nextSeq(kind, fy) {
  const path = `data.${kind}.${fy.replace(/-/g, '_')}`;
  const d = await Singleton.findByIdAndUpdate(
    'counters',
    { $inc: { [path]: 1 }, $setOnInsert: { _id: 'counters' } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  const parts = path.split('.');
  let cur = d; for (const p of parts) cur = cur?.[p];
  return cur || 1;
}

export const nextInvoiceNo = (date) => nextSeq('inv', indianFY(date));
export const nextCnNo = (date) => nextSeq('cn', indianFY(date));

export const formatInvoice = (date, seq, prefix = 'GR') => `${prefix}/${indianFY(date)}/${String(seq).padStart(4, '0')}`;
export const formatCreditNote = (date, seq, prefix = 'GR-CN') => `${prefix}/${indianFY(date)}/${String(seq).padStart(4, '0')}`;
