import { Router } from 'express';
import { PriceRange } from '../models/PriceRange.js';
import { crudRouter } from './_crud.js';

// Standard CRUD, ordered by `order` then `min` so the storefront list is deterministic.
export const priceRangesRouter = crudRouter(PriceRange, {
  searchFields: ['label'],
  filterKeys: ['visible'],
  defaultSort: { order: 1, min: 1 },
});
