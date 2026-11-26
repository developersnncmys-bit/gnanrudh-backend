// Shared colour-name → hex lookup used by the bulk-create flow so admins
// can type "Red" in the CSV and the backend fills in the hex automatically.
// Mirrors STANDARD_COLORWAYS in House-of-Granrudh-frontend/lib/sarees.ts so
// what admins see in the storefront's colour filter matches what bulk
// imports resolve to.
//
// Keep in sync with the frontend list — if you add a swatch there, add it
// here too. The alternative (shipping JSON from one place) wasn't worth the
// build-step complexity for a ~30-entry table that changes maybe twice a year.

const COLOURS = [
  // Reds
  { name: 'Red',       hex: '#DC2626', aliases: [] },
  { name: 'Maroon',    hex: '#7E1D1D', aliases: ['dark red'] },
  { name: 'Wine',      hex: '#4A0815', aliases: ['burgundy'] },
  // Pinks
  { name: 'Pink',      hex: '#DB2777', aliases: ['rose'] },
  { name: 'Magenta',   hex: '#A21CAF', aliases: [] },
  // Oranges / rust
  { name: 'Orange',    hex: '#F97316', aliases: [] },
  { name: 'Rust',      hex: '#C2410C', aliases: ['terracotta'] },
  // Yellows / golds
  { name: 'Yellow',    hex: '#EAB308', aliases: [] },
  { name: 'Mustard',   hex: '#A16207', aliases: [] },
  { name: 'Gold',      hex: '#DAA520', aliases: ['golden'] },
  // Neutrals
  { name: 'Cream',     hex: '#FEF3C7', aliases: [] },
  { name: 'Ivory',     hex: '#F2E9D8', aliases: ['off-white', 'off white'] },
  { name: 'Beige',     hex: '#D6BD8C', aliases: ['tan'] },
  { name: 'White',     hex: '#FFFFFF', aliases: [] },
  // Greens
  { name: 'Mint',      hex: '#34D399', aliases: [] },
  { name: 'Green',     hex: '#16A34A', aliases: [] },
  { name: 'Olive',     hex: '#65A30D', aliases: [] },
  { name: 'Forest',    hex: '#166534', aliases: ['dark green'] },
  // Blue-greens
  { name: 'Teal',      hex: '#0D9488', aliases: [] },
  { name: 'Peacock',   hex: '#0E7490', aliases: ['peacock blue', 'peacock green'] },
  // Blues
  { name: 'Sky Blue',  hex: '#0EA5E9', aliases: ['sky', 'light blue'] },
  { name: 'Blue',      hex: '#2563EB', aliases: [] },
  { name: 'Navy',      hex: '#1E40AF', aliases: ['navy blue'] },
  { name: 'Midnight',  hex: '#1E1B4B', aliases: ['midnight blue'] },
  // Purples
  { name: 'Lavender',  hex: '#C4B5FD', aliases: ['lilac'] },
  { name: 'Purple',    hex: '#9333EA', aliases: ['violet'] },
  // Browns / blacks / greys
  { name: 'Brown',     hex: '#92400E', aliases: [] },
  { name: 'Grey',      hex: '#6B7280', aliases: ['gray'] },
  { name: 'Black',     hex: '#000000', aliases: [] },
];

// Flattened lookup: every primary name and every alias → hex. Keys are
// lower-cased so matches are case-insensitive. Also strips surrounding
// whitespace on the way in so a sloppy CSV cell ("  red ") still matches.
const LOOKUP = new Map();
for (const c of COLOURS) {
  LOOKUP.set(c.name.toLowerCase(), c.hex);
  for (const a of c.aliases) LOOKUP.set(a.toLowerCase(), c.hex);
}

// Default hex for colour names we don't recognise. Neutral grey — picked
// so a typo or obscure name doesn't paint the storefront with an alarming
// placeholder colour. The admin can edit the variant's hex from the
// product drawer later.
const DEFAULT_HEX = '#D6BD8C';

/**
 * Resolve a colour name to a hex string. Matching rules, in order:
 *   1. If `raw` is already a valid hex (`#rrggbb` or `#rgb`), return it as-is.
 *   2. Lowercased exact match against the primary name or any alias.
 *   3. DEFAULT_HEX fallback.
 *
 * Never throws — always returns a string admins can safely store.
 */
export function resolveColourHex(raw) {
  const v = String(raw || '').trim();
  if (!v) return DEFAULT_HEX;
  // Already a hex? Pass through, normalising to lowercase for consistency.
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return v.toLowerCase();
  const hit = LOOKUP.get(v.toLowerCase());
  return hit || DEFAULT_HEX;
}
