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
  // Mongoose runs validators as methods — `this` is the doc being saved.
  return v == null || (typeof v === 'number' && v > this.price);
};
