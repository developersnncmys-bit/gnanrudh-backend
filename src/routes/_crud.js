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
export function crudRouter(Model, {
  searchFields = [],
  filterKeys = [],
  defaultSort = { createdAt: -1 },
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
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : limitDefault;
    const skip = Number(req.query.skip) || 0;
    const [items, total] = await Promise.all([
      Model.find(filter).sort(sort).skip(skip).limit(limit > 0 ? limit : 0).lean(),
      Model.countDocuments(filter),
    ]);
    res.json({ items, total });
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
