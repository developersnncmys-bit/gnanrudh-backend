import express from 'express';
import cors from 'cors';
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

const app = express();

app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '2mb' }));

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

async function main() {
  await connectDB();
  try {
    const r = await seedPiecesFromStock();
    if (!r.skipped) console.log(`[server] seeded ${r.seeded} pieces from existing stock`);
  } catch (e) { console.warn('[server] piece seed failed:', e.message); }
  app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal', err);
  process.exit(1);
});
