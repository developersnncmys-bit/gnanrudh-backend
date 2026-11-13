import { Category } from '../models/Category.js';
import { crudRouter } from './_crud.js';

export const categoriesRouter = crudRouter(Category, {
  searchFields: ['name', 'weaves'],
  filterKeys: ['visible', 'saree'],
  defaultSort: { name: 1 },
});
