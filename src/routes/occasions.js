import { Router } from 'express';
import { Occasion } from '../models/Occasion.js';
import { Product } from '../models/Product.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export const occasionsRouter = Router();

occasionsRouter.get('/', asyncHandler(async (req, res) => {
  const items = await Occasion.find().sort({ order: 1, name: 1 }).lean();
  res.json({ items, total: items.length });
}));

// Create an occasion. Body: { name, parent?, image? }
// `_id` doubles as the name so renames flow through the PATCH path and propagate to products.
occasionsRouter.post('/', asyncHandler(async (req, res) => {
  const name = String(req.body.name || req.body._id || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const parent = req.body.parent ? String(req.body.parent).trim() : null;
  if (parent) {
    const parentDoc = await Occasion.findById(parent);
    if (!parentDoc) return res.status(400).json({ error: `Parent occasion "${parent}" does not exist` });
    if (parentDoc.parent) return res.status(400).json({ error: 'Sub-categories can only be one level deep' });
  }
  const _id = req.body._id || name;
  if (await Occasion.findById(_id)) return res.status(409).json({ error: `${name} already exists` });
  const doc = await Occasion.create({ _id, name, parent, order: req.body.order ?? 0, image: req.body.image || '' });
  res.status(201).json(doc.toObject());
}));

// Rename or reorder, optionally re-parent. Renaming re-links products AND any child occasions.
occasionsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const current = await Occasion.findById(req.params.id);
  if (!current) return res.status(404).json({ error: 'Occasion not found' });

  const nextName = req.body.name != null ? String(req.body.name).trim() : current.name;
  const nextOrder = req.body.order != null ? Number(req.body.order) : current.order;
  const reparent = Object.prototype.hasOwnProperty.call(req.body, 'parent');
  const nextParent = reparent
    ? (req.body.parent ? String(req.body.parent).trim() : null)
    : current.parent;
  const setImage = Object.prototype.hasOwnProperty.call(req.body, 'image');
  const nextImage = setImage ? (req.body.image || '') : current.image;

  if (nextParent) {
    const parentDoc = await Occasion.findById(nextParent);
    if (!parentDoc) return res.status(400).json({ error: `Parent occasion "${nextParent}" does not exist` });
    if (parentDoc.parent) return res.status(400).json({ error: 'Sub-categories can only be one level deep' });
    if (nextParent === (nextName !== current._id ? nextName : current._id)) return res.status(400).json({ error: 'An occasion cannot be its own parent' });
  }

  if (nextName && nextName !== current.name) {
    // _id changed → create new, delete old, re-link products and any children.
    const clash = await Occasion.findById(nextName);
    if (clash) return res.status(409).json({ error: `${nextName} already exists` });
    await Occasion.create({ _id: nextName, name: nextName, parent: nextParent, order: nextOrder, image: nextImage });
    await Occasion.deleteOne({ _id: current._id });
    await Product.updateMany({ occasion: current._id }, { $set: { occasion: nextName } });
    await Occasion.updateMany({ parent: current._id }, { $set: { parent: nextName } });
    const doc = await Occasion.findById(nextName).lean();
    return res.json(doc);
  }

  current.order = nextOrder;
  if (reparent) current.parent = nextParent;
  if (setImage) current.image = nextImage;
  await current.save();
  res.json(current.toObject());
}));

// Delete an occasion. Any sub-categories lose their parent (become top-level) and
// any product tagged with it gets its occasion cleared.
occasionsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const doc = await Occasion.findByIdAndDelete(req.params.id).lean();
  if (!doc) return res.status(404).json({ error: 'Occasion not found' });
  await Product.updateMany({ occasion: req.params.id }, { $set: { occasion: null } });
  await Occasion.updateMany({ parent: req.params.id }, { $set: { parent: null } });
  res.json({ ok: true });
}));
