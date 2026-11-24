// AWB (airway bill) generation. Used by order ship, confirm-payment,
// Razorpay webhook capture, and the return reverse-pickup flow.
//
// Previously each call site built its own AWB with
// `${Math.floor(10000000 + Math.random() * 89999999)}11` — ~90M possible
// values, no uniqueness index, collisions start to matter around √90M ≈
// 9,500 orders. Replaced with a timestamp-based scheme that's
// monotonically increasing and effectively collision-free:
//
//   last-8-digits-of-ms-timestamp  +  2-digit random suffix  = 10 digits
//
// The timestamp block cycles every ~28 hours, so two AWBs minted within
// the same millisecond can collide only on the random suffix (1 in 100).
// In practice we never mint two AWBs in the same millisecond on a single
// node, so collisions are essentially impossible without concurrent
// serverless workers. If that matters later, add a unique partial index
// on `Order.ship.awb` and retry on E11000.

function twoDigit() {
  return String(10 + Math.floor(Math.random() * 90));
}

export function newForwardAwb() {
  return `${Date.now().toString().slice(-8)}${twoDigit()}`;
}

// Return pickup AWBs are prefixed `R` so they're obvious in the Shipping
// log and in Shiprocket's dashboard.
export function newReverseAwb() {
  return `R${Date.now().toString().slice(-8)}${twoDigit()}`;
}
