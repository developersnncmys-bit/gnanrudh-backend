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
import { piecesRouter, movementsRouter } from './routes/pieces.js';
import { authRouter } from './routes/auth.js';
import { requireAuth } from './middleware/auth.js';
import { seedPiecesFromStock } from './seedPieces.js';
import { CmsPage } from './models/CmsPage.js';

const app = express();

// SEC-04: trust the Vercel proxy so req.ip and X-Forwarded-For hold the real client IP.
app.set('trust proxy', 1);

app.use(cors({
  origin: config.corsOrigins,
  credentials: true,
  // SEC-03: expose the refreshed-token header so the admin can pick it up.
  exposedHeaders: ['X-Refreshed-Token'],
}));
app.use(express.json({ limit: '2mb' }));

// Ensure DB is connected before handling any request (safe for serverless cold starts)
app.use(async (req, res, next) => {
  try { await connectDB(); next(); } catch (e) { next(e); }
});

// Serve uploaded files publicly (no CORS needed — <img>/<video> tags don't check CORS)
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));

// Public endpoints
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/auth', authRouter);

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
app.use('/api/pieces', requireAuth, piecesRouter);
app.use('/api/movements', requireAuth, movementsRouter);

app.use(notFound);
app.use(errorHandler);

export default app;

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
    app.listen(config.port, () => {
      console.log(`[server] listening on http://localhost:${config.port}`);
    });
  })().catch((err) => {
    console.error('[server] fatal', err);
    process.exit(1);
  });
}
