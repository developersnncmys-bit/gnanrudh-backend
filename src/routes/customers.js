import { Router } from 'express';
import { Customer } from '../models/Customer.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const base = crudRouter(Customer, {
  searchFields: ['name', 'phone', 'email', 'city'],
  filterKeys: ['segment', 'city', 'state'],
  defaultSort: { ltv: -1 },
});

export const customersRouter = Router();

// Append a note: POST /customers/:id/notes  { text, at }
customersRouter.post('/:id/notes', asyncHandler(async (req, res) => {
  const { text, at } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const doc = await Customer.findByIdAndUpdate(
    req.params.id,
    { $push: { notes: { $each: [{ text, at: at || new Date().toISOString().slice(0, 10) }], $position: 0 } } },
    { new: true },
  ).lean();
  if (!doc) return res.status(404).json({ error: 'Customer not found' });
  res.json(doc);
}));

// Bulk note: POST /customers/notes  { ids, text }
customersRouter.post('/notes', asyncHandler(async (req, res) => {
  const { ids, text } = req.body;
  if (!Array.isArray(ids) || !ids.length || !text) return res.status(400).json({ error: 'ids[] and text required' });
  const at = new Date().toISOString().slice(0, 10);
  await Customer.updateMany(
    { _id: { $in: ids } },
    { $push: { notes: { $each: [{ text, at }], $position: 0 } } },
  );
  res.json({ ok: true });
}));

customersRouter.use('/', base);
