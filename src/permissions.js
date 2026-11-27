// SEC-05: role-based access control.
//
// The permission *catalogue* (PERMISSIONS) and the *default* role → permissions
// matrix (DEFAULT_ROLE_PERMISSIONS) live here as code. The *active* matrix is
// persisted in the `role-permissions` Singleton document so an owner can edit
// it live from Settings > Team.
//
// On first boot ensureMatrix() seeds the Singleton from the defaults. The
// cached matrix drives requirePerm(); setMatrix() validates + persists + busts
// the cache. The `owner` role is always granted every permission — enforced on
// write so a bad edit can't lock the admin out.

import { getSingleton, setSingleton } from './models/Singleton.js';

export const PERMISSIONS = Object.freeze({
  dashboard: 'Dashboard — the home summary cards + queue.',
  analytics: 'Analytics — sales, traffic and conversion charts.',
  insights: 'Product insights — per-SKU performance.',
  orders: 'Orders — view, update status, cancel, mark delivered, refund.',
  packing: 'Packing bench — scan pieces into packed orders.',
  returns: 'Returns — review, approve, mark refunded.',
  shipping: 'Shipping — rates, label pushes, tracking, NDR.',
  products: 'Products — create, edit, publish and delete products.',
  categories: 'Categories — manage the catalogue categories.',
  occasions: 'Occasions — manage occasion tags shown on the storefront.',
  priceRanges: 'Shop by price — manage the price buckets.',
  inventory: 'Inventory — view and adjust on-hand stock.',
  barcodes: 'Barcodes and stock — scan, print labels, view movements.',
  customers: 'Customers — view the CRM, add notes, see order history.',
  reviews: 'Reviews — moderate, reply, hide.',
  coupons: 'Coupons — create, update and disable discount codes.',
  journal: 'Journal — publish long-form content on the storefront.',
  storefront: 'Storefront pages — edit CMS pages, hero slides, home banners.',
  settings: 'Settings — store details, shipping, GST, returns policy.',
  team: 'Team — invite, edit, disable and remove admin users.',
});

const ALL_PERMISSIONS = Object.freeze(Object.keys(PERMISSIONS));

// Seed defaults used on first boot and as fallbacks for missing roles.
export const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  owner: ALL_PERMISSIONS,
  manager: Object.freeze([
    'dashboard', 'analytics', 'insights',
    'orders', 'packing', 'returns', 'shipping',
    'products', 'categories', 'occasions', 'priceRanges', 'inventory', 'barcodes',
    'customers', 'reviews',
    'coupons', 'journal', 'storefront',
    'settings',
  ]),
  packer: Object.freeze([
    'orders', 'packing', 'barcodes', 'inventory', 'products',
  ]),
  support: Object.freeze([
    'orders', 'returns', 'reviews', 'customers',
  ]),
});

const ROLES = Object.keys(DEFAULT_ROLE_PERMISSIONS);
const SINGLETON_ID = 'role-permissions';

// Active matrix, loaded from the DB. Null until ensureMatrix() runs. On null,
// requirePerm() falls back to DEFAULT_ROLE_PERMISSIONS so a cold request
// still gets a sane answer — the connectDB middleware calls ensureMatrix()
// before any handler runs, so this only matters for unit tests.
let cachedMatrix = null;

// Normalise whatever the DB handed back: drop unknown permissions, drop
// unknown roles, backfill missing roles from defaults, force owner = all.
function normaliseMatrix(raw) {
  const matrix = {};
  for (const role of ROLES) {
    const fromDb = Array.isArray(raw?.[role]) ? raw[role] : null;
    const src = fromDb || DEFAULT_ROLE_PERMISSIONS[role] || [];
    const filtered = [...new Set(src.filter((p) => ALL_PERMISSIONS.includes(p)))];
    matrix[role] = filtered;
  }
  // Owner is always all — enforce on read so a bad DB write can't lock
  // the admin out.
  matrix.owner = [...ALL_PERMISSIONS];
  return matrix;
}

export async function ensureMatrix() {
  const data = await getSingleton(SINGLETON_ID, null);
  if (!data) {
    // First boot: seed with the defaults so the Settings > Team table has
    // something to display immediately and future updates have a doc to
    // $set against.
    const seeded = normaliseMatrix(DEFAULT_ROLE_PERMISSIONS);
    await setSingleton(SINGLETON_ID, seeded);
    cachedMatrix = seeded;
  } else {
    cachedMatrix = normaliseMatrix(data);
  }
  return cachedMatrix;
}

export async function setMatrix(next) {
  if (!next || typeof next !== 'object') {
    const err = new Error('Matrix must be an object keyed by role.');
    err.status = 400; throw err;
  }
  const clean = normaliseMatrix(next);
  await setSingleton(SINGLETON_ID, clean);
  cachedMatrix = clean;
  return cachedMatrix;
}

export function getMatrix() {
  return cachedMatrix || normaliseMatrix(DEFAULT_ROLE_PERMISSIONS);
}

export function hasPerm(role, perm) {
  const matrix = cachedMatrix || DEFAULT_ROLE_PERMISSIONS;
  const list = matrix[role];
  if (!list) return false;
  return list.includes(perm);
}

export function permsFor(role) {
  const matrix = cachedMatrix || DEFAULT_ROLE_PERMISSIONS;
  return matrix[role] ? [...matrix[role]] : [];
}

// Express middleware: reject with 403 if the signed-in user's role doesn't
// grant `perm`. Must run AFTER requireAuth (which populates req.user).
export function requirePerm(perm) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ error: 'Not authenticated' });
    if (!hasPerm(role, perm)) {
      return res.status(403).json({
        error: `Your role (${role}) doesn't have access to ${perm}.`,
      });
    }
    next();
  };
}
