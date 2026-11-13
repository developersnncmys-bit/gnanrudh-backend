// One-time seed: if no pieces exist but products have stock, create pieces so the
// Barcodes & Stock page has something to show. Idempotent — exits immediately if
// pieces already exist.
import { Piece } from './models/Piece.js';
import { Movement } from './models/Movement.js';
import { Product } from './models/Product.js';

export async function seedPiecesFromStock() {
  const haveAny = await Piece.exists({});
  if (haveAny) return { seeded: 0, skipped: true };
  const products = await Product.find({}).lean();
  const now = new Date().toISOString();
  let seeded = 0;
  let moveCounter = 0;
  for (const p of products) {
    const bySku = {};
    for (const v of p.variants) {
      if (!v.sku || !(v.stock > 0)) continue;
      const seq = bySku[v.sku] || 0;
      for (let k = 0; k < v.stock; k++) {
        const n = seq + k + 1;
        const code = `${v.sku}-${String(n).padStart(3, '0')}`;
        await Piece.create({ _id: code, pid: p._id, vid: v.id, status: 'In stock', at: now, received: now, printed: true });
        moveCounter += 1;
        await Movement.create({
          _id: `MVS${moveCounter}${Date.now().toString(36).slice(-3)}`,
          code, pid: p._id, vid: v.id,
          from: '—', to: 'In stock', note: 'Seeded from existing stock count',
          oid: null, by: 'System', at: now,
        });
        seeded += 1;
      }
      bySku[v.sku] = seq + v.stock;
    }
  }
  return { seeded, skipped: false };
}
