import { Router } from 'express';
import { CmsPage } from '../models/CmsPage.js';
import { Singleton } from '../models/Singleton.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export const pagesRouter = Router();

// LEGAL-01: substitute policy tokens like {{returnWindow}} using current Settings,
// so the Returns policy page stays in sync when the window or rules are edited.
function substituteTokens(body, settings) {
  if (!body) return body;
  const policy = settings?.policy || {};
  const ship = settings?.ship || {};
  const tokens = {
    returnWindow: policy.window ? `${policy.window} days` : '',
    returnConditions: policy.conditions || '',
    reverseShippingRule: policy.reverseShipping || ship.returnPolicy || '',
  };
  return String(body).replace(/\{\{(\w+)\}\}/g, (full, key) => (key in tokens ? tokens[key] : full));
}

pagesRouter.get('/', asyncHandler(async (req, res) => {
  const items = await CmsPage.find().sort({ name: 1 }).lean();
  res.json({ items, total: items.length });
}));

pagesRouter.get('/:name', asyncHandler(async (req, res) => {
  const p = await CmsPage.findOne({ name: req.params.name }).lean();
  if (!p) return res.status(404).json({ error: 'Page not found' });
  // Only substitute for the rendered body — admin editor should see the raw tokens
  // so authors can edit them. ?raw=1 suppresses substitution.
  if (req.query.raw) return res.json(p);
  const settings = await Singleton.findById('settings').lean();
  p.body = substituteTokens(p.body, settings?.data);
  res.json(p);
}));

pagesRouter.put('/:name', asyncHandler(async (req, res) => {
  const body = { ...req.body, name: req.params.name, updated: new Date().toISOString().slice(0, 10) };
  // Keep banners[] and the legacy singular banner in sync so either caller shape works.
  if (Array.isArray(body.banners)) {
    body.banners = body.banners.filter((u) => typeof u === 'string' && u);
    body.banner = body.banners[0] || '';
  } else if (typeof body.banner === 'string') {
    body.banners = body.banner ? [body.banner] : [];
  }
  const p = await CmsPage.findOneAndUpdate({ name: req.params.name }, body, { new: true, upsert: true }).lean();
  res.json(p);
}));

pagesRouter.delete('/:name', asyncHandler(async (req, res) => {
  const r = await CmsPage.deleteOne({ name: req.params.name });
  if (!r.deletedCount) return res.status(404).json({ error: 'Page not found' });
  res.json({ ok: true });
}));
