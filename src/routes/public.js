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
