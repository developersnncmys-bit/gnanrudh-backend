import { Router } from 'express';
import { Category } from '../models/Category.js';
import { PriceRange } from '../models/PriceRange.js';
import { Occasion } from '../models/Occasion.js';
import { CmsPage } from '../models/CmsPage.js';
import { HeroSlide } from '../models/HeroSlide.js';
import { HomeBanner } from '../models/HomeBanner.js';
import { Product } from '../models/Product.js';
import { Piece } from '../models/Piece.js';
import { Singleton } from '../models/Singleton.js';
import { Coupon } from '../models/Coupon.js';
import { Customer } from '../models/Customer.js';
import { validateCoupon } from '../coupons.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

// Overwrites each variant's stored `stock` with the live count of pieces
// in status "In stock" for that variant. The stored `variant.stock` field
// is a stale denormalisation (never updated when pieces are received or
// shipped), so the storefront's Out-of-Stock gate and "N in stock" chips
// need this live count to agree with the admin's Inventory page.
async function overlayLiveStock(products) {
  const vids = [];
  for (const p of products) {
    for (const v of p.variants || []) if (v?.id) vids.push(v.id);
  }
  if (!vids.length) return products;
  const rows = await Piece.aggregate([
    { $match: { vid: { $in: vids }, status: 'In stock' } },
    { $group: { _id: '$vid', count: { $sum: 1 } } },
  ]);
  const counts = new Map(rows.map((r) => [r._id, r.count]));
  for (const p of products) {
    for (const v of p.variants || []) {
      if (v?.id) v.stock = counts.get(v.id) || 0;
    }
  }
  return products;
}

// Pagination guard. Storefront list calls don't need the full admin cap;
// anything above 100 is almost certainly a bug or a crawler fishing the
// catalogue — clamp hard.
const PUBLIC_PAGE_DEFAULT = 24;
const PUBLIC_PAGE_MAX = 100;
function parsePublicPaging(query) {
  let limit = Number(query.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = PUBLIC_PAGE_DEFAULT;
  if (limit > PUBLIC_PAGE_MAX) limit = PUBLIC_PAGE_MAX;
  let skip = 0;
  if (query.skip !== undefined) {
    const s = Number(query.skip);
    if (Number.isFinite(s) && s >= 0) skip = Math.floor(s);
  }
  return { limit, skip };
}

// Unauthenticated read-only endpoints consumed by the storefront.
// Kept in a single router so the auth-protected admin endpoints stay
// insulated from anything the public bundle can hit.
export const publicRouter = Router();

publicRouter.get('/categories', asyncHandler(async (req, res) => {
  const filter = { visible: true };
  if (req.query.saree === '1' || req.query.saree === 'true') filter.saree = true;
  const items = await Category.find(filter).sort({ name: 1 }).lean();
  res.json({ items, total: items.length, limit: items.length, skip: 0 });
}));

// Storefront "Shop by price" buckets. Only returns rows the admin has flagged
// `visible`, ordered the same way as the admin list.
publicRouter.get('/price-ranges', asyncHandler(async (req, res) => {
  const items = await PriceRange.find({ visible: true }).sort({ order: 1, min: 1 }).lean();
  res.json({ items, total: items.length, limit: items.length, skip: 0 });
}));

// Storefront homepage hero carousel slides. Only rows the admin has flagged
// visible, ordered by `order` then creation time so ties are deterministic.
publicRouter.get('/hero-slides', asyncHandler(async (req, res) => {
  const items = await HeroSlide.find({ visible: true }).sort({ order: 1, createdAt: 1 }).lean();
  res.json({ items, total: items.length, limit: items.length, skip: 0 });
}));

// Storefront homepage promotional banners — the "Explore Collections" strip
// (PromoBanner) and the "Bridal Edit" strip (CraftStory). Keyed by `slot`
// so the frontend components can look up their specific row by name.
publicRouter.get('/home-banners', asyncHandler(async (req, res) => {
  const items = await HomeBanner.find({}).lean();
  res.json({ items });
}));

// Public product list. Always scoped to status:'Active' so Drafts / Hidden
// rows the admin is still working on never leak to the storefront. Supports
// the same filter/search/sort/pagination query params the admin list uses:
//   ?q=silk&cat=silk&weave=Kanjivaram&occasion=Wedding&limit=24&skip=0&sort=price&dir=asc
publicRouter.get('/products', asyncHandler(async (req, res) => {
  const filter = { status: 'Active' };
  // Coerce to String — blocks ?cat[$ne]=... operator-injection that Express
  // would otherwise leave as an object for Mongo to honour.
  for (const key of ['cat', 'weave', 'occasion']) {
    const v = req.query[key];
    if (v === undefined || v === '' || typeof v === 'object') continue;
    filter[key] = String(v);
  }
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { name: rx }, { weave: rx }, { 'variants.sku': rx }, { 'variants.colour': rx },
    ];
  }
  const sortKey = typeof req.query.sort === 'string' ? req.query.sort.replace(/[.$]/g, '') : '';
  const sort = sortKey ? { [sortKey]: req.query.dir === 'asc' ? 1 : -1 } : { created: -1 };
  const { limit, skip } = parsePublicPaging(req.query);
  const [items, total] = await Promise.all([
    Product.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);
  await overlayLiveStock(items);
  res.json({ items, total, limit, skip });
}));

// Single product by _id. 404 for anything the admin hasn't flagged Active
// so draft URLs can't be guessed from the storefront.
publicRouter.get('/products/:id', asyncHandler(async (req, res) => {
  const item = await Product.findOne({ _id: req.params.id, status: 'Active' }).lean();
  if (!item) return res.status(404).json({ error: 'Not found' });
  await overlayLiveStock([item]);
  res.json(item);
}));

// All occasions (parent + sub). The storefront decides which ones to show
// based on `parent`. Sorted by order then name so first-render is stable.
publicRouter.get('/occasions', asyncHandler(async (req, res) => {
  const items = await Occasion.find({}).sort({ order: 1, name: 1 }).lean();
  res.json({ items, total: items.length, limit: items.length, skip: 0 });
}));

// CPN-03: public list of currently-redeemable coupons for the checkout
// strip. Filters out admin-disabled, expired, and limit-reached rows so a
// scraper can't surface a coupon that's dead on the wire. Strips the
// internal `uses` counter — the storefront never needs it and exposing it
// leaks redemption volumes. The admin endpoint (`/api/coupons`) stays
// auth-gated for management; this one is read-only + safe to cache.
publicRouter.get('/coupons', asyncHandler(async (req, res) => {
  const todayIso = new Date().toISOString();
  const rows = await Coupon.find({
    on: true,
    $or: [{ ends: null }, { ends: { $gte: todayIso } }],
  }).sort({ value: -1, _id: 1 }).lean();
  const items = rows
    .filter((c) => c.limit == null || (c.uses || 0) < c.limit)
    .map((c) => ({
      code: c._id,
      kind: c.kind,
      value: c.value,
      min: c.min || 0,
      scope: c.scope || null,
      ends: c.ends || null,
    }));
  res.json({ items, total: items.length, limit: items.length, skip: 0 });
}));

// CPN-03: public coupon validation. Same business logic as the admin
// `/api/coupons/:code/validate` route — we deliberately share
// `validateCoupon` so a change to percent/flat math, min-order, or scope
// matching lands in both places at once. Un-auth because the storefront
// needs to show the live discount BEFORE the customer places the order.
// Order creation re-validates from the server too (see customerPayment),
// so a tampered response here can't actually under-charge.
publicRouter.post('/coupons/:code/validate', asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ ok: false, reason: 'Missing coupon code' });
  const coupon = await Coupon.findById(code);
  if (!coupon) return res.status(404).json({ ok: false, reason: 'Coupon not found' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ ok: false, reason: 'No items in cart' });
  const customer = req.body?.cid ? await Customer.findById(req.body.cid).lean() : null;
  const pidList = [...new Set(items.map((it) => it.pid).filter(Boolean))];
  const prods = await Product.find({ _id: { $in: pidList } }).lean();
  const products = Object.fromEntries(prods.map((p) => [p._id, p]));
  const result = validateCoupon({ coupon: coupon.toObject(), customer, items, products });
  res.json(result);
}));

// Single CMS page by exact name (e.g. "Privacy policy"). Substitutes policy
// tokens from Settings — same behaviour as the admin GET — so the Returns
// page stays in sync when the window or rules change. 404 when the page
// has not been created yet.
publicRouter.get('/pages/:name', asyncHandler(async (req, res) => {
  const p = await CmsPage.findOne({ name: req.params.name }).lean();
  if (!p) return res.status(404).json({ error: 'Page not found' });
  const settings = await Singleton.findById('settings').lean();
  const policy = settings?.data?.policy || {};
  const ship = settings?.data?.ship || {};
  const tokens = {
    returnWindow: policy.window ? `${policy.window} days` : '',
    returnConditions: policy.conditions || '',
    reverseShippingRule: policy.reverseShipping || ship.returnPolicy || '',
  };
  p.body = String(p.body || '').replace(/\{\{(\w+)\}\}/g, (full, key) => (key in tokens ? tokens[key] : full));
  res.json(p);
}));
