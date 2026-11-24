import crypto from 'crypto';
import { config } from './config.js';

// Shared Razorpay client. Lazy-initialised the first time any route calls
// getRazorpay() so a fresh checkout without `npm install razorpay` still
// boots the server; the relevant routes just 503 with a clear message.
// Mirrors the semantics customerPayment.js previously had — now exported
// so the admin "check with Razorpay" endpoint in routes/orders.js can
// reuse the same client instead of spinning up its own.

let rzpClient = null;
let rzpImportFailed = false;

export async function getRazorpay() {
  if (rzpClient) return rzpClient;
  const { keyId, keySecret } = config.razorpay;
  if (!keyId || !keySecret) return null;
  if (rzpImportFailed) return null;
  try {
    const { default: Razorpay } = await import('razorpay');
    rzpClient = new Razorpay({ key_id: keyId, key_secret: keySecret });
    return rzpClient;
  } catch (err) {
    console.warn(
      '[razorpay] npm package not installed — payment routes will 503. Run `npm install razorpay` in backend/ to enable.',
      err?.message || '',
    );
    rzpImportFailed = true;
    return null;
  }
}

// Verifies the HMAC Razorpay signs with our secret for a payment event.
// Returns true on match, false on mismatch or when no secret is configured
// (never silently "pass" a missing secret — callers should treat false as
// "cannot verify" and refuse the request).
export function verifyRazorpaySignature({ orderId, paymentId, signature }) {
  const secret = config.razorpay.keySecret;
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
}
