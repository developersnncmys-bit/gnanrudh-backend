// CPN-01/02: pure business-logic helpers for coupon application.
// Server-side so admin, storefront and any future checkout path all agree.

// Normalises the human-readable `scope` field into a predicate that decides
// whether a given line item is eligible for a discount.
//
// Currently supported scopes (match seeded values):
//   - "All products"          → every line is eligible
//   - "First order"           → eligibility checked at the order level, not per-line
//   - "Silk Sarees"           → product.cat === 'silk'
//   - "Cotton and Handloom"   → product.cat === 'cotton'
//
// Anything unrecognised falls back to "all lines eligible" plus a `warn` in the
// result so the admin UI can flag drift between what accountants expect and what
// the code enforces.
export function scopeMatcher(scope) {
  const s = String(scope || '').trim();
  if (!s || s === 'All products' || s === 'First order') return () => true;
  if (s === 'Silk Sarees') return (product) => product?.cat === 'silk';
  if (s === 'Cotton and Handloom') return (product) => product?.cat === 'cotton';
  return null; // caller treats null as "unknown scope"
}

// Compute the taxable subtotal of eligible lines. Each line uses item.price * item.qty.
export function eligibleSubtotal(items, products, matcher) {
  return items.reduce((a, it) => {
    const p = products[it.pid];
    return matcher(p) ? a + (it.price * (it.qty || 1)) : a;
  }, 0);
}

// Core validator. Returns { ok, discount, eligibleSub, reason, warn? }.
// Params:
//   coupon  — Mongoose Coupon doc (or plain object with same fields)
//   customer — { orderCount, phone, email } or null for guest
//   items   — [{ pid, qty, price }]
//   products — map of pid -> product doc (or just { cat })
//   now     — ISO string for "today", defaults to Date.now()
export function validateCoupon({ coupon, customer, items, products, now }) {
  if (!coupon) return { ok: false, reason: 'Coupon not found' };
  if (!coupon.on) return { ok: false, reason: 'Coupon is not active' };
  const today = now ? new Date(now) : new Date();
  if (coupon.ends && new Date(coupon.ends) < today) return { ok: false, reason: 'Coupon has expired' };
  if (coupon.limit != null && (coupon.uses || 0) >= coupon.limit) return { ok: false, reason: 'Coupon usage limit reached' };

  const matcher = scopeMatcher(coupon.scope);
  if (!matcher) return { ok: false, reason: `Coupon scope "${coupon.scope}" is not recognised` };

  if (coupon.scope === 'First order') {
    const prior = Number(customer?.orderCount || 0);
    if (prior > 0) return { ok: false, reason: 'First-order coupon; this customer has previous orders' };
  }

  const eligibleSub = eligibleSubtotal(items, products, matcher);
  if (eligibleSub <= 0) return { ok: false, reason: 'No eligible items in cart for this coupon' };
  if (coupon.min && eligibleSub < coupon.min) return { ok: false, reason: `Order below the minimum of ${coupon.min} for this coupon` };

  let discount = 0;
  if (coupon.kind === 'Percent') discount = Math.round(eligibleSub * (coupon.value / 100));
  else if (coupon.kind === 'Flat') discount = Math.min(coupon.value, eligibleSub);
  else return { ok: false, reason: `Unknown coupon kind "${coupon.kind}"` };

  return { ok: true, discount, eligibleSub };
}
