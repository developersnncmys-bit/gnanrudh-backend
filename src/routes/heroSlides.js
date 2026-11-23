import { HeroSlide } from '../models/HeroSlide.js';
import { crudRouter } from './_crud.js';

// Standard CRUD, ordered by `order` then `createdAt` so the admin list and the
// storefront carousel agree. Admin-only; the storefront reads via
// /api/public/hero-slides (see routes/public.js).
export const heroSlidesRouter = crudRouter(HeroSlide, {
  searchFields: ['headline', 'eyebrow', 'ctaLabel'],
  filterKeys: ['visible'],
  defaultSort: { order: 1, createdAt: 1 },
});
