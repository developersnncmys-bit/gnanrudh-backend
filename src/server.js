import express from 'express';
import cors from 'cors';
import { pathToFileURL } from 'url';
import mongoose from 'mongoose';
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
import { requirePerm, ensureMatrix } from './permissions.js';
import { seedPiecesFromStock } from './seedPieces.js';
import { isShiprocketConfigured } from './shiprocket.js';

// SHIP-02 startup visibility: this silently skipped once (orders placed but
// never pushed) because the running process had been started before the
// SHIPROCKET_* env vars existed. Log the state on every boot so the next
// time the creds are missing it's obvious from the first line of the log.
(() => {
  if (isShiprocketConfigured()) {
    const email = process.env.SHIPROCKET_EMAIL;
    const pickup = process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary';
    console.log(`[shiprocket] ENABLED — account=${email}, pickup=${pickup}`);
  } else {
    const explicitlyOff = ['false', '0', 'off'].includes(String(process.env.SHIPROCKET_ENABLED || '').toLowerCase());
    const reason = explicitlyOff
      ? 'SHIPROCKET_ENABLED is false'
      : 'SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD not set in this process env';
    console.warn(`[shiprocket] DISABLED — ${reason}. Storefront orders will NOT auto-push.`);
  }
})();
import { CmsPage } from './models/CmsPage.js';
import { Order } from './models/Order.js';
import { Singleton } from './models/Singleton.js';

const app = express();

// SEC-04: trust the Vercel proxy so req.ip and X-Forwarded-For hold the real client IP.
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const started = Date.now();
  const path = req.path;
  console.log(`[request] ${req.method} ${path} START`);
  res.once('finish', () => console.log(`[request] ${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`));
  next();
});

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
app.use('/api/webhooks', async (req, res, next) => {
  try { await timed('webhook.connectDB', connectDB); next(); }
  catch (err) { console.error('[webhook database]', err.message); res.status(503).json({ error: 'Service temporarily unavailable' }); }
}, webhooksRouter);

app.use(express.json({ limit: '2mb' }));

// Liveness is independent of database and maintenance work.
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

async function timed(name, fn) {
  const start = Date.now();
  console.log(`[PERF] ${name} START`);
  try { return await fn(); }
  finally { console.log(`[PERF] ${name} END ${Date.now() - start}ms`); }
}

// Load persisted permissions once per instance, retry on failure.
// Do not continue with default permissions after a failed initialization.
let permissionsReady;
function initPermissions() {
  if (!permissionsReady) {
    permissionsReady = timed('ensureMatrix', ensureMatrix).catch(err => {
      permissionsReady = undefined;
      throw err;
    });
  }
  return permissionsReady;
}

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));

// Readiness checks database connectivity without running migrations.
app.get('/api/ready', async (req, res) => {
  try {
    await timed('readiness.connectDB', connectDB);
    await mongoose.connection.db.command({ ping: 1 });
    res.json({ ok: true, database: 'connected' });
  } catch (err) {
    console.error('[ready]', err.message);
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

// Only essential initialization in API request path.
app.use('/api', async (req, res, next) => {
  try {
    await timed('connectDB', connectDB);
    await initPermissions();
    next();
  } catch (err) {
    console.error('[api initialization]', err.message);
    res.status(503).json({ error: 'Service temporarily unavailable' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/team', teamRouter);
app.use('/api/customer-auth', customerAuthRouter);
app.use('/api/customer-auth', customerPaymentRouter);
app.use('/api/public', publicRouter);

// Protected endpoints — require a valid Bearer token AND the role-based
// permission for the module. The permission key is the admin nav id for the
// section the route backs; see permissions.js for the catalogue and the
// role matrix. Uploads + stats aren't gated on a single permission (every
// authed role uses them) so they only require authentication.
app.use('/api/categories', requireAuth, requirePerm('categories'), categoriesRouter);
app.use('/api/products', requireAuth, requirePerm('products'), productsRouter);
app.use('/api/customers', requireAuth, requirePerm('customers'), customersRouter);
app.use('/api/orders', requireAuth, requirePerm('orders'), ordersRouter);
app.use('/api/returns', requireAuth, requirePerm('returns'), returnsRouter);
app.use('/api/shipping', requireAuth, requirePerm('shipping'), shippingRouter);
app.use('/api/coupons', requireAuth, requirePerm('coupons'), couponsRouter);
app.use('/api/reviews', requireAuth, requirePerm('reviews'), reviewsRouter);
app.use('/api/journal', requireAuth, requirePerm('journal'), journalRouter);
app.use('/api/pages', requireAuth, requirePerm('storefront'), pagesRouter);
app.use('/api/scenes', requireAuth, requirePerm('storefront'), scenesRouter);
app.use('/api/featured', requireAuth, requirePerm('storefront'), featuredRouter);
app.use('/api/settings', requireAuth, requirePerm('settings'), settingsRouter);
app.use('/api/stats', requireAuth, statsRouter);
app.use('/api/uploads', requireAuth, uploadsRouter);
app.use('/api/occasions', requireAuth, requirePerm('occasions'), occasionsRouter);
app.use('/api/price-ranges', requireAuth, requirePerm('priceRanges'), priceRangesRouter);
app.use('/api/hero-slides', requireAuth, requirePerm('storefront'), heroSlidesRouter);
app.use('/api/home-banners', requireAuth, requirePerm('storefront'), homeBannersRouter);
app.use('/api/pieces', requireAuth, requirePerm('barcodes'), piecesRouter);
app.use('/api/movements', requireAuth, requirePerm('barcodes'), movementsRouter);

app.use(notFound);
app.use(errorHandler);

export default app;

// INV-03: one-shot historical cleanup. Scans every Piece whose pid no
// longer resolves to a live Product (left behind by pre-cascade deletes)
// and writes them off. Only touches outstanding states — Sold / Returned
// pieces stay in their terminal shape so revenue reports and refund
// windows keep their history. Run explicitly during reviewed maintenance.
async function writeOffOrphanPieces() {
  const pending = await Piece.find({ status: { $in: ['In stock', 'Reserved', 'Packed'] } }).lean();
  if (!pending.length) return;
  const uniquePids = [...new Set(pending.map((p) => p.pid).filter(Boolean))];
  const liveProducts = await Product.find({ _id: { $in: uniquePids } }).select('_id').lean();
  const livePidSet = new Set(liveProducts.map((p) => String(p._id)));
  const orphanIds = pending
    .filter((p) => p.pid && !livePidSet.has(String(p.pid)))
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
      throw new Error(`Piece ${code} write-off failed`, { cause: err });
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
// enum rejects writes to that slot now. Removal is opt-in.
async function ensureHomeBanners() {
  const { HomeBanner } = await import('./models/HomeBanner.js');
  // Legacy explore removal is opt-in to avoid deleting production data.
  if (process.argv.includes('--remove-legacy-explore')) {
    await HomeBanner.deleteOne({ slot: 'explore' });
  }
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

// Explicit maintenance CLI. Run from backend directory against the intended DB.
// Never invoked when Vercel imports this module.
if (process.env.VERCEL !== '1' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    await connectDB();
    if (process.argv.includes('--maintenance')) {
      if (!process.argv.includes('--confirm-db')) {
        throw new Error('Review database target and back up data; pass --confirm-db to proceed');
      }
      if (process.argv.includes('--dev-seed') && process.env.NODE_ENV === 'production') {
        throw new Error('Dev seeding is forbidden in production');
      }
      // createIndexes does not drop unrelated existing indexes like syncIndexes can.
      await timed('Order.createIndexes', () => Order.createIndexes());
      await timed('ensureInvoiceCounters', ensureInvoiceCounters);
      await timed('ensureHomePage', ensureHomePage);
      await timed('ensureHomeBanners', ensureHomeBanners);
      await timed('ensureMatrix', ensureMatrix);
      if (process.argv.includes('--cleanup-orphans')) {
        await timed('writeOffOrphanPieces', writeOffOrphanPieces);
      }
      if (process.argv.includes('--dev-seed')) {
        if (process.env.NODE_ENV === 'production') throw new Error('Dev seeding is forbidden in production');
        await timed('ensureDevSellerDetails', ensureDevSellerDetails);
        await timed('seedPiecesFromStock', seedPiecesFromStock);
      }
      await mongoose.disconnect();
      console.log('[maintenance] complete');
      return;
    }
    await initPermissions();
    app.listen(config.port, () => {
      console.log(`[server] listening on http://localhost:${config.port}`);
    });
  })().catch(async err => {
    console.error('[server] fatal', err);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}
