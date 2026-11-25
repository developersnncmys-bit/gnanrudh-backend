import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';

/**
 * Build a standard REST router for a Mongoose model.
 *   GET    /           list (with query filters and optional ?q= text search)
 *   GET    /:id        read
 *   POST   /           create
 *   PATCH  /:id        partial update
 *   PUT    /:id        replace
 *   DELETE /:id        delete
 *
 * Options:
 *   searchFields: string[] — fields regex-matched by ?q=
 *   filterKeys:   string[] — query keys that become { field: value } in the Mongo filter
 *   defaultSort:  object   — default sort when none given
 *   limitDefault: number   — default page size (0 = no limit)
 */
// PERF-03/04 pagination constants. Default page size is 50; hard cap at 100.
// `limit=0` used to mean "everything" and the bootstrap used it on every list; now
// the server clamps and returns at most PAGE_MAX rows per request.
const PAGE_DEFAULT = 50;
// Raised from 100 → 500 so the admin's page-through-everything bootstrap
// finishes in a handful of parallel round-trips instead of dozens of
// sequential ones. Still leaves plenty of headroom — .lean() reads of
// 500 docs comfortably fit under Vercel's response size + timeout budget
// for every collection in this schema.
const PAGE_MAX = 500;

export function parsePaging(query) {
  let limit = Number(query.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = PAGE_DEFAULT;
  if (limit > PAGE_MAX) limit = PAGE_MAX;
  let skip = 0;
  if (query.skip !== undefined) {
    const s = Number(query.skip);
    if (Number.isFinite(s) && s >= 0) skip = Math.floor(s);
  } else if (query.page !== undefined) {
    const p = Number(query.page);
    if (Number.isFinite(p) && p >= 1) skip = (Math.floor(p) - 1) * limit;
  }
  return { limit, skip };
}

export function crudRouter(Model, {
  searchFields = [],
  filterKeys = [],
  defaultSort = { createdAt: -1 },
  // limitDefault is kept for signature compatibility but ignored — PERF-03 caps everyone at PAGE_MAX.
  // eslint-disable-next-line no-unused-vars
  limitDefault = 0,
} = {}) {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const filter = {};
    // Coerce every filter value to a string. Blocks ?status[$ne]=... operator-injection
    // where Express turns bracketed query params into objects that Mongo would honour.
    for (const k of filterKeys) {
      const v = req.query[k];
      if (v === undefined || v === '' || typeof v === 'object') continue;
      filter[k] = String(v);
    }
    if (req.query.q && searchFields.length) {
      const rx = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = searchFields.map((f) => ({ [f]: rx }));
    }
    // sort key is a model field name; strip any dotted or $ keys to kill prototype/operator abuse.
    const sortKey = typeof req.query.sort === 'string' ? req.query.sort.replace(/[.$]/g, '') : '';
    const sort = sortKey ? { [sortKey]: req.query.dir === 'asc' ? 1 : -1 } : defaultSort;
    const { limit, skip } = parsePaging(req.query);
    const [items, total] = await Promise.all([
      Model.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Model.countDocuments(filter),
    ]);
    res.json({ items, total, limit, skip });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const item = await Model.findById(req.params.id).lean();
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const doc = await Model.create(req.body);
    res.status(201).json(doc.toObject());
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const doc = await Model.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  }));

  router.put('/:id', asyncHandler(async (req, res) => {
    const body = { ...req.body }; delete body._id;
    const doc = await Model.findByIdAndUpdate(req.params.id, body, { new: true, upsert: true, runValidators: true, overwrite: true }).lean();
    res.json(doc);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const doc = await Model.findByIdAndDelete(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }));

  return router;
}
