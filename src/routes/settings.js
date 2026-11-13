import { Router } from 'express';
import { getSingleton, mergeSingleton, setSingleton } from '../models/Singleton.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export const settingsRouter = Router();

// GET /settings → merged { store, pay, ship, gst, account, crm, policy }
settingsRouter.get('/', asyncHandler(async (req, res) => {
  const [settings, crm, policy] = await Promise.all([
    getSingleton('settings', {}),
    getSingleton('crm', {}),
    getSingleton('policy', {}),
  ]);
  res.json({ ...settings, crm, policy });
}));

// PATCH /settings/:section  — section ∈ store|pay|ship|gst|account|crm|policy
settingsRouter.patch('/:section', asyncHandler(async (req, res) => {
  const section = req.params.section;
  if (['crm', 'policy'].includes(section)) {
    const next = { ...(await getSingleton(section, {})), ...req.body };
    await setSingleton(section, next);
    return res.json(next);
  }
  if (!['store', 'pay', 'ship', 'gst', 'account'].includes(section)) {
    return res.status(400).json({ error: `Unknown section: ${section}` });
  }
  const current = await getSingleton('settings', {});
  current[section] = { ...(current[section] || {}), ...req.body };
  await setSingleton('settings', current);
  res.json(current[section]);
}));
