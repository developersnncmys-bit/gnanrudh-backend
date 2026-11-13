import { Article } from '../models/Article.js';
import { crudRouter } from './_crud.js';

export const journalRouter = crudRouter(Article, {
  searchFields: ['title', 'body', 'slug'],
  filterKeys: ['status', 'type'],
  defaultSort: { date: -1 },
});
