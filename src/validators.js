// VAL-01: shared regex validators used by Mongoose schemas and ad-hoc route checks.
// Patterns match the brief exactly.

export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const MOBILE_IN_RE = /^[6-9][0-9]{9}$/;
export const PINCODE_IN_RE = /^[1-9][0-9]{5}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isGSTIN = (v) => typeof v === 'string' && GSTIN_RE.test(v);
export const isMobileIN = (v) => typeof v === 'string' && MOBILE_IN_RE.test(v);
export const isPincodeIN = (v) => typeof v === 'string' && PINCODE_IN_RE.test(v);
export const isEmail = (v) => typeof v === 'string' && EMAIL_RE.test(v);

// Mongoose validator wrappers. `null`/empty is allowed where the field itself is optional —
// the `required: true` flag decides presence. These only check *shape* when a value is set.
export const optMobileValidator = {
  validator: (v) => v == null || v === '' || isMobileIN(v),
  message: 'Phone must be a 10-digit Indian mobile starting 6-9.',
};
export const optEmailValidator = {
  validator: (v) => v == null || v === '' || isEmail(v),
  message: 'Email must be a valid address.',
};
export const optPincodeValidator = {
  validator: (v) => v == null || v === '' || isPincodeIN(v),
  message: 'Pincode must be 6 digits and not start with 0.',
};
export const positivePriceValidator = {
  validator: (v) => typeof v === 'number' && v > 0,
  message: 'Price must be greater than 0.',
};
export const compareAtValidator = function validate(v) {
  if (v == null) return true;
  if (typeof v !== 'number') return false;
  // Mongoose binds `this` to the document on .save() and to the Query on
  // findOneAndUpdate/findByIdAndUpdate with runValidators. In the Query case
  // `this.price` is undefined, so read price from the update payload instead
  // (PUT overwrite puts fields at the top level; PATCH wraps them in $set).
  let price = this.price;
  if (typeof this.getUpdate === 'function') {
    const u = this.getUpdate() || {};
    const fromUpdate = u.$set?.price ?? u.price;
    if (fromUpdate !== undefined) price = fromUpdate;
  }
  // Partial PATCH that doesn't touch price can't be validated here — allow it
  // and rely on the next full save to catch a bad pairing.
  if (typeof price !== 'number') return true;
  return v > price;
};

// TAX-01: check whether seller details on Settings are real enough to print a tax invoice.
// Blocks the seeded placeholders (`29ABCDE1234F1Z5`, phone with x's, "Bengaluru, Karnataka
// 560001" bare address) from leaking onto a GST invoice.
const PLACEHOLDER_GSTIN = '29ABCDE1234F1Z5';
const PLACEHOLDER_ADDR_RE = /^Bengaluru,?\s*Karnataka\s*\d{6}$/i;

// CAT-05: canonical spellings for weaves. Keeps the catalogue filterable even
// when staff type "Kanjeevaram" or "Kanchipuram" instead of "Kanjivaram".
const SPELLING_NORMALISE = [
  [/\b(kanjeev[ae]ram|kanch[ei]puram|kanjivarm)\b/i, 'Kanjivaram'],
  [/\bbanarsi\b/i, 'Banarasi'],
  [/\bchand[ae]ri\b/i, 'Chanderi'],
];

export function normaliseWeaveSpelling(w) {
  if (!w || typeof w !== 'string') return w;
  let out = w.trim();
  for (const [re, canon] of SPELLING_NORMALISE) out = out.replace(re, canon);
  return out;
}

export function settingsReady(data) {
  const store = data?.store || {};
  const gst = data?.gst || {};
  const issues = [];
  const gstin = (gst.gstin || '').trim();
  if (!gstin) issues.push('GSTIN is empty');
  else if (gstin === PLACEHOLDER_GSTIN) issues.push('GSTIN is still the placeholder 29ABCDE1234F1Z5');
  else if (!isGSTIN(gstin)) issues.push('GSTIN format is invalid');
  const phone = (store.phone || '').trim();
  if (!phone) issues.push('Business phone is empty');
  else if (/x/i.test(phone)) issues.push('Business phone is still the placeholder (+91 98xxx xxxxx)');
  const addr = (store.address || '').trim();
  if (!addr) issues.push('Business address is empty');
  else if (addr.length < 20 || PLACEHOLDER_ADDR_RE.test(addr)) issues.push('Business address is too short or still the placeholder');
  const name = (store.name || '').trim();
  if (!name) issues.push('Business name is empty');
  return { ok: issues.length === 0, issues };
}
