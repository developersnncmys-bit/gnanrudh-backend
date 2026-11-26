import express from 'express';
import cors from 'cors';
import { pathToFileURL } from 'url';
import { config } from './config.js';
import { connectDB } from './db.js';
import { errorHandler, notFound } from './middleware/asyncHandler.js';

import { categoriesRouter } from './routes/categories.js';
import { productsRouter } from './routes/products.js';
import { customersRouter } from './routes/customers.js';
import { ordersRouter } from './routes/orders.js';
import { returnsRouter } from './routes/returns.js';
import { shippingRouter } from './routes/shipping.js';
import { couponsRouter } from './routes/coupons.js';
import { reviewsRouter } from './routes/reviews.js';
import { journalRouter } from './routes/journal.js';
import { pagesRouter } from './routes/pages.js';
import { scenesRouter } from './routes/scenes.js';
import { featuredRouter } from './routes/featured.js';
import { settingsRouter } from './routes/settings.js';
import { statsRouter } from './routes/stats.js';
import { uploadsRouter, UPLOAD_DIR } from './routes/uploads.js';
import { occasionsRouter } from './routes/occasions.js';
import { priceRangesRouter } from './routes/priceRanges.js';
import { heroSlidesRouter } from './routes/heroSlides.js';
import { homeBannersRouter } from './routes/homeBanners.js';
import { piecesRouter, movementsRouter, recordMove } from './routes/pieces.js';
import { Piece } from './models/Piece.js';
import { Product } from './models/Product.js';
import { authRouter } from './routes/auth.js';
import { teamRouter } from './routes/team.js';
import { customerAuthRouter } from './routes/customerAuth.js';
import { customerPaymentRouter } from './routes/customerPayment.js';
import { webhooksRouter } from './routes/webhooks.js';
import { publicRouter } from './routes/public.js';
import { requireAuth } from './middleware/auth.js';
import { seedPiecesFromStock } from './seedPieces.js';
import { CmsPage } from './models/CmsPage.js';
import { Order } from './models/Order.js';
import { Singleton } from './models/Singleton.js';

const app = express();

// SEC-04: trust the Vercel proxy so req.ip and X-Forwarded-For hold the real client IP.
app.set('trust proxy', 1);

// CORS allow-list:
//   1. Exact origins from CORS_ORIGIN env (prod domains + localhost).
//   2. Any Vercel preview / production URL belonging to one of OUR projects
//      — admin, storefront, and backend's own origin. This means a new PR
//      preview (gnanrudh-admin-git-some-branch-xyz.vercel.app) works out of
//      the box without anyone updating an env var.
//   3. A missing Origin header (server-to-server, curl, same-origin) passes
//      so health checks and the Shiprocket / Razorpay webhooks aren't blocked.
// Every other origin is refused with a clear error in the server logs.
const OUR_VERCEL_PROJECT = /^https:\/\/(gnanrudh-admin|gnanrudh-website|gnanrudh-backend)(-[a-z0-9-]+)?\.vercel\.app$/i;
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (config.corsOrigins.includes(origin)) return cb(null, true);
    if (OUR_VERCEL_PROJECT.test(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} is not allowed`));
  },
  credentials: true,
  // SEC-03: expose the refreshed-token header so the admin can pick it up.
  exposedHeaders: ['X-Refreshed-Token'],
}));
// Webhooks mount BEFORE express.json() because Razorpay's HMAC verification
// needs the EXACT raw body bytes — parsing and re-stringifying JSON breaks
// the signature. The webhook route uses its own express.raw() middleware.
app.use('/api/webhooks', webhooksRouter);

app.use(express.json({ limit: '2mb' }));

// Ensure DB is connected before handling any request (safe for serverless cold starts).
// Also run one-shot boot tasks (index sync + dev-seed patches) exactly once per
// process — `globalThis.__bootReady` is cached by the serverless runtime across requests.
app.use(async (req, res, next) => {
  try {
    await connectDB();
    if (!globalThis.__bootReady) {
      globalThis.__bootReady = (async () => {
        try { await Order.syncIndexes(); } catch (e) { console.warn('[boot] Order.syncIndexes failed:', e.message); }
        try { await ensureDevSellerDetails(); } catch (e) { console.warn('[boot] dev seller upsert failed:', e.message); }
        try { await ensureInvoiceCounters(); } catch (e) { console.warn('[boot] invoice counter alignment failed:', e.message); }
        try { await ensureHomeBanners(); } catch (e) { console.warn('[boot] home banners seed failed:', e.message); }
        try { await writeOffOrphanPieces(); } catch (e) { console.warn('[boot] orphan piece write-off failed:', e.message); }
      })();
    }
    await globalThis.__bootReady;
    next();
  } catch (e) { next(e); }
});

// Serve uploaded files publicly (no CORS needed — <img>/<video> tags don't check CORS)
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));

// Public endpoints
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/auth', authRouter);
app.use('/api/team', teamRouter);
app.use('/api/customer-auth', customerAuthRouter);
app.use('/api/customer-auth', customerPaymentRouter);
app.use('/api/public', publicRouter);

// Protected endpoints — require a valid Bearer token
app.use('/api/categories', requireAuth, categoriesRouter);
app.use('/api/products', requireAuth, productsRouter);
app.use('/api/customers', requireAuth, customersRouter);
app.use('/api/orders', requireAuth, ordersRouter);
app.use('/api/returns', requireAuth, returnsRouter);
app.use('/api/shipping', requireAuth, shippingRouter);
app.use('/api/coupons', requireAuth, couponsRouter);
app.use('/api/reviews', requireAuth, reviewsRouter);
app.use('/api/journal', requireAuth, journalRouter);
app.use('/api/pages', requireAuth, pagesRouter);
app.use('/api/scenes', requireAuth, scenesRouter);
app.use('/api/featured', requireAuth, featuredRouter);
app.use('/api/settings', requireAuth, settingsRouter);
app.use('/api/stats', requireAuth, statsRouter);
app.use('/api/uploads', requireAuth, uploadsRouter);
app.use('/api/occasions', requireAuth, occasionsRouter);
app.use('/api/price-ranges', requireAuth, priceRangesRouter);
app.use('/api/hero-slides', requireAuth, heroSlidesRouter);
app.use('/api/home-banners', requireAuth, homeBannersRouter);
app.use('/api/pieces', requireAuth, piecesRouter);
app.use('/api/movements', requireAuth, movementsRouter);

app.use(notFound);
app.use(errorHandler);

export default app;

// INV-03: one-shot historical cleanup. Scans every Piece whose pid no
// longer resolves to a live Product (left behind by pre-cascade deletes)
// and writes them off. Only touches outstanding states — Sold / Returned
// pieces stay in their terminal shape so revenue reports and refund
// windows keep their history. Runs once per process; subsequent restarts
// find nothing to do and exit in a single query.
async function writeOffOrphanPieces() {
  const pending = await Piece.find({ status: { $in: ['In stock', 'Reserved', 'Packed'] } }).lean();
  if (!pending.length) return;
  const uniquePids = [...new Set(pending.map((p) => p.pid).filter(Boolean))];
  const liveProducts = await Product.find({ _id: { $in: uniquePids } }).select('_id').lean();
  const livePidSet = new Set(liveProducts.map((p) => p._id));
  const orphanIds = pending
    .filter((p) => p.pid && !livePidSet.has(p.pid))
    .map((p) => p._id);
  if (!orphanIds.length) return;
  console.log(`[boot] writing off ${orphanIds.length} orphan piece(s) from deleted products…`);
  let done = 0;
  for (const code of orphanIds) {
    const piece = await Piece.findById(code);
    if (!piece) continue;
    try {
      await recordMove(piece, 'Written off', 'Product no longer in catalogue', { by: 'System', oid: null });
      done += 1;
    } catch (err) {
      console.warn(`[boot] piece ${code} write-off failed:`, err.message);
    }
  }
  console.log(`[boot] wrote off ${done} orphan piece(s).`);
}

// DEV-SEED: an already-seeded DB still holds the old placeholder seller details
// (`29ABCDE1234F1Z5`, `+91 98xxx xxxxx`, `Bengaluru, Karnataka 560001`), which
// `settingsReady` rejects — blocking manual-order invoice generation. Patch any
// field that still matches a known placeholder with a dev-usable value. Real
// values set through the admin UI are left alone.
async function ensureDevSellerDetails() {
  const s = await Singleton.findById('settings').lean();
  if (!s?.data) return;
  const store = s.data.store || {};
  const gst = s.data.gst || {};
  const set = {};
  if ((gst.gstin || '').trim() === '29ABCDE1234F1Z5') set['data.gst.gstin'] = '29GNRUD2026A1ZV';
  if (/x/i.test(store.phone || '') || !(store.phone || '').trim()) set['data.store.phone'] = '+91 98765 43210';
  const addr = (store.address || '').trim();
  if (!addr || addr.length < 20 || /^Bengaluru,?\s*Karnataka\s*\d{6}$/i.test(addr)) {
    set['data.store.address'] = 'No. 42, 3rd Cross, Indiranagar, Bengaluru, Karnataka 560038';
  }
  if (!(store.name || '').trim()) set['data.store.name'] = 'House of GnanRudh';
  if (Object.keys(set).length) {
    await Singleton.updateOne({ _id: 'settings' }, { $set: set });
    console.log(`[server] dev seller details patched: ${Object.keys(set).join(', ')}`);
  }
}

// The seed hand-assigns invoice numbers (GR/26-27/0001…) to existing orders,
// but the `counters` Singleton that `nextInvoiceNo` uses starts from 0. On the
// first real invoice issue the counter would reissue a number a seeded order
// already owns and collide with the `invoice_1` unique index. Fix: scan
// existing orders once, and $max-bump the counter past the highest used seq
// per financial year. $max is safe to re-run — it only raises, never lowers.
async function ensureInvoiceCounters() {
  const extract = (s) => {
    // Matches "GR/26-27/0042" or "GR-CN/26-27/0005" — capture (FY, seq).
    const m = String(s || '').match(/\/(\d{2}-\d{2})\/(\d+)$/);
    if (!m) return null;
    return { fy: m[1].replace('-', '_'), seq: Number(m[2]) };
  };
  const scan = async (field) => {
    const rows = await Order.find({ [field]: { $type: 'string' } }, { [field]: 1 }).lean();
    const max = {};
    for (const r of rows) {
      const p = extract(r[field]); if (!p) continue;
      if (!max[p.fy] || p.seq > max[p.fy]) max[p.fy] = p.seq;
    }
    return max;
  };
  const invMax = await scan('invoice');
  const cnMax = await scan('creditNote');
  const set = {};
  for (const [fy, seq] of Object.entries(invMax)) set[`data.inv.${fy}`] = seq;
  for (const [fy, seq] of Object.entries(cnMax)) set[`data.cn.${fy}`] = seq;
  if (!Object.keys(set).length) return;
  await Singleton.updateOne(
    { _id: 'counters' },
    { $max: set, $setOnInsert: { _id: 'counters' } },
    { upsert: true },
  );
  console.log(`[server] invoice/CN counters aligned to existing orders: ${JSON.stringify(set)}`);
}

// Insert the "Home" CMS page record for already-running DBs that were seeded
// before Home existed. Safe to run on every boot — $setOnInsert is a no-op
// when the record already exists.
async function ensureHomePage() {
  await CmsPage.updateOne(
    { name: 'Home' },
    {
      $setOnInsert: {
        name: 'Home',
        desc: 'The storefront landing page. Upload a hero banner shown at the top above the homepage story.',
        updated: new Date().toISOString().slice(0, 10),
        body: '',
      },
    },
    { upsert: true },
  );
}

// Seed the Bridal Edit banner row if it doesn't exist yet. Defaults match
// what the storefront's CraftStory.tsx currently hardcodes so the storefront
// shows the same copy on a fresh DB. Also drops any leftover 'explore' row
// from the brief window when Explore was also admin-controlled — the model
// enum rejects writes to that slot now, but a stray row would still read
// out via the public endpoint.
async function ensureHomeBanners() {
  const { HomeBanner } = await import('./models/HomeBanner.js');
  await HomeBanner.deleteOne({ slot: 'explore' });
  await HomeBanner.updateOne(
    { slot: 'bridal' },
    {
      $setOnInsert: {
        slot: 'bridal',
        image: '/homebanner/banner3.webp',
        eyebrow: 'The Bridal Edit',
        title: 'Heirloom Bridal Silks',
        description: 'Curated drapes for the bride and her moment.',
      },
    },
    { upsert: true },
  );
}

// Only start a listening HTTP server when run directly (local dev).
// On Vercel, the file is imported as a serverless function and this block is skipped.
// On Windows, import.meta.url is `file:///C:/...` (three slashes) while a
// hand-rolled `file://${argv[1]}` has two. Use pathToFileURL so the comparison
// works on both Windows and POSIX.
if (process.env.VERCEL !== '1' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    await connectDB();
    try {
      const r = await seedPiecesFromStock();
      if (!r.skipped) console.log(`[server] seeded ${r.seeded} pieces from existing stock`);
    } catch (e) { console.warn('[server] piece seed failed:', e.message); }
    try { await ensureHomePage(); } catch (e) { console.warn('[server] home page upsert failed:', e.message); }
    // Order.syncIndexes + ensureDevSellerDetails run from the connectDB middleware
    // on first request, so they cover both local dev and Vercel cold starts.
    app.listen(config.port, () => {
      console.log(`[server] listening on http://localhost:${config.port}`);
    });
  })().catch((err) => {
    console.error('[server] fatal', err);
    process.exit(1);
  });
}
