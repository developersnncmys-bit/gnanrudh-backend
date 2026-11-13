import { Router } from 'express';
import { ShipEvent } from '../models/ShipEvent.js';
import { crudRouter } from './_crud.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const base = crudRouter(ShipEvent, {
  searchFields: ['oid', 'awb', 'type'],
  filterKeys: ['oid', 'courier', 'webhook', 'type'],
  defaultSort: { at: -1 },
});

export const shippingRouter = Router();

// Mark a webhook event as Received (the "Sync now" action).
shippingRouter.post('/:id/sync', asyncHandler(async (req, res) => {
  const s = await ShipEvent.findByIdAndUpdate(req.params.id, { $set: { webhook: 'Received' } }, { new: true }).lean();
  if (!s) return res.status(404).json({ error: 'Event not found' });
  res.json(s);
}));

shippingRouter.use('/', base);
