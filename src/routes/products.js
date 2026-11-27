import { Router } from 'express';
import { Product } from '../models/Product.js';
import { Piece } from '../models/Piece.js';
import { Movement } from '../models/Movement.js';
import { Category } from '../models/Category.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { normaliseWeaveSpelling } from '../validators.js';
import { nextMoveId, syncProductStockFromPieces } from './pieces.js';
import { resolveColourHex } from '../colours.js';

// AUD-01 ties audit rows to the staff email, same convention the rest of
// the routes use.
const byFromReq = (req) => req.user?.email || 'System';

const base = crudRouter(Product, {
  searchFields: ['name', 'weave', 'variants.sku', 'variants.colour'],
  filterKeys: ['cat', 'status', 'zari', 'occasion', 'blousePiece'],
  defaultSort: { created: -1 },
});

export const productsRouter = Router();

// INV-02: variant.stock is derived from Piece documents and is NOT writable through
// the product API. Any incoming write that tries to set it is quietly dropped.
// CAT-05: fold common weave misspellings into the canonical name on every write path.
productsRouter.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
    if (Array.isArray(req.body.variants)) {
      req.body.variants = req.body.variants.map((v) => { const { stock, ...rest } = v; return rest; });
    }
    if (typeof req.body.weave === 'string') req.body.weave = normaliseWeaveSpelling(req.body.weave);
  }
  next();
});

// Bulk create: POST /products/bulk  { rows: [{name, category, price, weave, occasions, colour, hex, size, sku}] }
// Creates one Product + one initial Variant per row. Images are blank —
// the admin uploads them later from each product's drawer. Status
// defaults to 'Draft' so no partial products leak onto the storefront
// before they have a photo. Unknown / missing category names are
// reported back per-row rather than failing the whole batch.
productsRouter.post('/bulk', asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'rows[] required' });
  // Pre-fetch categories once; match on both _id (slug) and name
  // (case-insensitive) so admins can type whichever they remember.
  const cats = await Category.find({}).lean();
  const byCat = new Map();
  for (const c of cats) {
    byCat.set(String(c._id).toLowerCase(), c);
    if (c.name) byCat.set(String(c.name).toLowerCase(), c);
  }
  // Seed the next product id from the current catalogue max (P<N>).
  // Start at 1000 so a fresh DB opens at P1001, matching the admin's
  // own numbering rule in actions.js.
  const existing = await Product.find({}).select('_id').lean();
  let nextNum = existing.reduce((m, p) => {
    const n = parseInt(String(p._id || '').replace(/^P/, ''), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 1000);
  const results = [];
  const by = req.user?.email || 'System';
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || {};
    const name = String(r.name || '').trim();
    const categoryRaw = String(r.category || '').trim();
    // Accept either `selling_price` (preferred, mirrors Indian e-com)
    // or the legacy `price` alias so a template from an earlier release
    // keeps working.
    const sellingPrice = Number(r.selling_price ?? r.price);
    // MRP maps to the product's `compareAt` strikethrough. Optional —
    // when present it must be greater than the selling price (schema
    // enforces this on save).
    const mrpRaw = r.mrp ?? r.compareAt;
    const mrp = mrpRaw === undefined || mrpRaw === '' ? null : Number(mrpRaw);
    // Multi-colour support: colour / hex / size / sku / qty accept
    // pipe-separated values that line up positionally — one variant per
    // colour. A comma is also accepted as a separator so admins who
    // think in commas don't trip on the pipe convention.
    const splitList = (s) => String(s || '').split(/[|,]/).map((x) => x.trim()).filter((x) => x.length > 0);
    // Accept "None" (case-insensitive) as a shorthand for "no colour"
    // so admins who pick it from the Excel dropdown end up with the
    // same zero-variant shell as leaving the cell blank.
    const coloursRaw = splitList(r.colour);
    const colours = coloursRaw.length === 1 && coloursRaw[0].toLowerCase() === 'none'
      ? []
      : coloursRaw.filter((c) => c.toLowerCase() !== 'none');
    const hexListRaw = splitList(r.hex);
    const sizeList = splitList(r.size);
    const skuListRaw = splitList(r.sku);
    const qtyList = splitList(r.qty).map((q) => Math.max(0, parseInt(q, 10) || 0));
    const occasions = String(r.occasions || '').split('|').map((s) => s.trim()).filter(Boolean);
    const weave = String(r.weave || '').trim();
    const statusRaw = String(r.status || '').trim();
    // Default to Active so bulk-uploaded sarees appear on the storefront
    // immediately. Admins who want a staging buffer can still set the row
    // to Draft explicitly in the CSV status column.
    const status = ['Draft', 'Active', 'Hidden'].includes(statusRaw) ? statusRaw : 'Active';
    if (!name) { results.push({ line: i + 1, ok: false, error: 'name is empty' }); continue; }
    if (!categoryRaw) { results.push({ line: i + 1, name, ok: false, error: 'category is empty' }); continue; }
    if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) { results.push({ line: i + 1, name, ok: false, error: 'selling_price must be a positive number' }); continue; }
    if (mrp !== null && (!Number.isFinite(mrp) || mrp <= sellingPrice)) { results.push({ line: i + 1, name, ok: false, error: 'mrp must be greater than selling_price' }); continue; }
    // colour is optional — a row without it creates a product shell
    // (no variants, no SKU, no stock). Admin adds colour variants from
    // the drawer later. The storefront's filter rail shows these under
    // the "None" chip; shoppers see the card but can't buy until a
    // variant is added.
    const cat = byCat.get(categoryRaw.toLowerCase());
    if (!cat) { results.push({ line: i + 1, name, ok: false, error: `unknown category: ${categoryRaw}` }); continue; }
    // Align the per-variant lists to the colour count. Missing entries
    // repeat the LAST supplied value — so `qty=500` with 3 colours gives
    // 500 to every variant, while `qty=500|300|200` sets each one.
    const pad = (list, fallback) => colours.map((_, idx) => (list[idx] !== undefined ? list[idx] : (list.length ? list[list.length - 1] : fallback)));
    const hexList = pad(hexListRaw, '').map((h, idx) => resolveColourHex(h || colours[idx]));
    const sizesPadded = pad(sizeList, '');
    const skusPadded = pad(skuListRaw, '');
    const qtysPadded = qtyList.length ? pad(qtyList, 0) : colours.map(() => 0);
    try {
      // Reserve a fresh P-id. If the computed pid collides with an
      // existing row (prior bulk run, leftover from a partial failure,
      // concurrent write), bump and retry up to a sane cap so we never
      // silently skip a row over a numbering collision. `nextNum` is
      // never rolled back — once we've probed a number, treat it as
      // taken for the rest of this batch so subsequent rows don't land
      // on the same collision.
      let prod = null;
      let pid = '';
      let variants = [];
      let createPidError = null;
      for (let attempt = 0; attempt < 50 && !prod; attempt += 1) {
        nextNum += 1;
        pid = `P${nextNum}`;
        const catPrefix = String(cat._id).slice(0, 3).toUpperCase();
        // One variant per colour; each gets its own vid and SKU.
        // Auto-SKU mirrors the admin's own convention
        // (CAT-prefix + <numeric suffix of product id> + variant index).
        variants = colours.map((col, idx) => ({
          id: `v-${pid}-${idx}`,
          colour: col,
          hex: hexList[idx],
          size: sizesPadded[idx] || null,
          sku: (skusPadded[idx] || '') || `${catPrefix}-${pid.slice(1)}${idx}`,
          imageUrls: [],
        }));
        try {
          prod = await Product.create({
            _id: pid,
            cat: cat._id,
            weave: weave || undefined,
            name,
            price: sellingPrice,
            compareAt: mrp,
            occasions,
            occasion: occasions[0] || undefined,
            variants,
            // Product-level hex still reads from the first variant so
            // the admin's product-card swatch has something to show
            // before a shopper picks a colour. When colour was omitted
            // entirely from the CSV (no variants created), fall back to
            // a neutral grey so the swatch doesn't render as invisible.
            hex: variants[0]?.hex || '#d8cfbf',
            // zariHex drives the stripe in the admin's colour swatch.
            // The swatch CSS is a linear-gradient of `var(--b) / var(--z)`
            // — if --z is unset the whole gradient is invalid and the
            // swatch renders transparent. Default to the "No zari" tone
            // the admin drawer uses for the same case so bulk-imported
            // products show the same visual as hand-added ones.
            zariHex: '#d8cfbf',
            imageUrls: [],
            images: 0,
            status,
            created: new Date().toISOString().slice(0, 10),
          });
        } catch (err) {
          // Duplicate _id → remember the error and probe the next number.
          // Any other error (validation, cast, Mongo down) is real and
          // bubbles to the outer catch so the admin sees the message.
          if (err?.code === 11000 && String(err.message || '').includes('_id')) {
            createPidError = err;
            continue;
          }
          throw err;
        }
      }
      if (!prod) {
        results.push({ line: i + 1, name, ok: false, error: createPidError ? `could not reserve a free product id after 50 attempts (${createPidError.message})` : 'could not reserve a free product id' });
        continue;
      }
      let createdPieces = 0;
      // Receive initial stock if the row has a qty. Mirrors the per-
      // variant receive endpoint: pre-scan existing pieces with the same
      // SKU prefix so numbering picks up PAST any written-off leftovers
      // from a previous delete (cascade write-off keeps the Piece docs
      // around for audit, which is why a naive -001 start collides and
      // every piece throws E11000). Piece failures are non-fatal — the
      // product stays saved and the admin can receive stock manually.
      const totalQty = qtysPadded.reduce((a, q) => a + q, 0);
      if (totalQty > 0) {
        try {
          const at = new Date().toISOString();
          // Movement-id base is read ONCE and incremented per-piece
          // across all variants so numbering stays contiguous even when
          // one row creates variants with mixed qty.
          const CHUNK = 500;
          let moveBase = await Movement.estimatedDocumentCount();
          const batchStamp = Date.now().toString(36);
          const allPieceDocs = [];
          const allMoveDocs = [];
          let globalK = 0;
          for (let vIdx = 0; vIdx < variants.length; vIdx += 1) {
            const v = variants[vIdx];
            const vQty = qtysPadded[vIdx] || 0;
            if (vQty <= 0) continue;
            // Pre-scan existing pieces for this variant's SKU so numbering
            // picks up PAST any written-off leftovers from a previous
            // delete (cascade write-off keeps the Piece docs around for
            // audit, which is why a naive -001 start collides).
            const existing = await Piece.find({ _id: new RegExp(`^${v.sku.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}-\\d{3,}$`) }).select('_id').lean();
            let seq = existing.reduce((m, p) => {
              const match = /-(\d{3,})$/.exec(p._id);
              return match ? Math.max(m, Number(match[1])) : m;
            }, 0);
            for (let k = 0; k < vQty; k += 1) {
              seq += 1;
              const code = `${v.sku}-${String(seq).padStart(3, '0')}`;
              allPieceDocs.push({ _id: code, pid, vid: v.id, status: 'In stock', at, received: at, printed: false });
              // Movement _id combines the running sequence base, the batch
              // timestamp and the running index so it's unique within this
              // batch AND across concurrent uploads in the same second.
              const moveId = `MV${moveBase + globalK + 1}${batchStamp}${globalK.toString(36)}`;
              allMoveDocs.push({
                _id: moveId,
                code, pid, vid: v.id,
                from: '—', to: 'In stock',
                note: 'Received from the weaver (bulk product import)',
                oid: null, by, at,
              });
              globalK += 1;
            }
          }
          for (let off = 0; off < allPieceDocs.length; off += CHUNK) {
            const pieceSlice = allPieceDocs.slice(off, off + CHUNK);
            const moveSlice = allMoveDocs.slice(off, off + CHUNK);
            // ordered: false — a lone collision (e.g. a legacy piece
            // number sneaked in between our scan and insert) keeps the
            // rest of the batch moving. Count only the pieces that
            // actually landed by inspecting insertedCount.
            const pRes = await Piece.insertMany(pieceSlice, { ordered: false, rawResult: true });
            createdPieces += pRes.insertedCount ?? pieceSlice.length;
            await Movement.insertMany(moveSlice, { ordered: false });
          }
          await syncProductStockFromPieces(pid);
        } catch (pieceErr) {
          console.warn(`[products.bulk] piece creation failed for ${pid}:`, pieceErr.message);
          results.push({ line: i + 1, name, ok: true, pid: prod._id, variants: variants.length, pieces: createdPieces, warning: `pieces partially created (${createdPieces}/${totalQty}): ${pieceErr.message}` });
          continue;
        }
      }
      results.push({ line: i + 1, name, ok: true, pid: prod._id, variants: variants.length, pieces: createdPieces });
    } catch (err) {
      results.push({ line: i + 1, name, ok: false, error: err.message || 'save failed' });
    }
  }
  const totals = results.reduce((a, r) => {
    if (r.ok) { a.ok += 1; a.pieces += (r.pieces || 0); } else a.failed += 1;
    return a;
  }, { ok: 0, failed: 0, pieces: 0 });
  res.status(201).json({ results, totals });
}));

// Bulk status update: PATCH /products/bulk  { ids: [], status: '...' }
productsRouter.patch('/bulk', asyncHandler(async (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !ids.length || !status) return res.status(400).json({ error: 'ids[] and status required' });
  const result = await Product.updateMany({ _id: { $in: ids } }, { $set: { status } });
  res.json({ matched: result.matchedCount, modified: result.modifiedCount });
}));

// INV-03: cascade-write off Pieces when a Product is deleted. Mounted
// BEFORE `base` so this override wins the DELETE /:id match; the generic
// crudRouter handler would otherwise nuke the Product row and leave every
// Piece pointing at a now-missing pid — which is exactly how the Barcodes
// & stock page ended up showing "Deleted product · In stock" rows that
// inflated inventory counters without ever being sellable. The audit
// trail is preserved: each Piece transition is written to Movement with
// the deletion as the explicit reason, so staff can trace where the
// units went. We batch with insertMany + updateMany so a 2000-piece
// product deletes in two round-trips instead of 4000.
productsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const p = await Product.findById(id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  // Only outstanding pieces need transitioning — Sold / Returned / Written
  // off are already in a terminal state and should keep their current
  // audit history untouched. Snapshot them first so we can write the
  // audit trail with the correct `from` status before flipping.
  const outstanding = await Piece.find({
    pid: id,
    status: { $in: ['In stock', 'Reserved', 'Packed'] },
  }).lean();
  const by = byFromReq(req);
  const at = new Date().toISOString();
  const note = `Product deleted: ${p.name}`;
  if (outstanding.length) {
    // Bulk audit rows first — one insertMany instead of N Movement.create
    // calls. Unique _ids come from nextMoveId() which is DB-free.
    const moves = await Promise.all(outstanding.map(async (piece) => ({
      _id: await nextMoveId(),
      code: piece._id, pid: piece.pid, vid: piece.vid,
      from: piece.status, to: 'Written off', note, oid: null, by, at,
    })));
    try {
      await Movement.insertMany(moves, { ordered: false });
    } catch (err) {
      console.warn(`[products.delete] bulk audit write failed:`, err.message);
    }
    // Single updateMany flips all 2000 pieces to 'Written off' in one shot.
    await Piece.updateMany(
      { _id: { $in: outstanding.map((piece) => piece._id) } },
      { $set: { status: 'Written off', oid: null, at } },
    );
  }
  // Keep the denormalised variant.stock counters in sync so reports don't
  // keep showing a phantom "N in stock" on the (now deleted) product.
  try { await syncProductStockFromPieces(id); } catch { /* product row about to vanish */ }
  await Product.deleteOne({ _id: id });
  res.json({ ok: true, deletedProduct: id, piecesWrittenOff: outstanding.length });
}));

productsRouter.use('/', base);
