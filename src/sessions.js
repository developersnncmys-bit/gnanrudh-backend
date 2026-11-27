// SEC-06: session helpers used by the auth flow. Parses the User-Agent into
// a short human label ("MacBook, Chrome") and generates short session ids.

import { randomBytes } from 'crypto';

export function newSessionId() {
  // 16 hex chars — fits inside JWT comfortably, collision-safe at admin scale.
  return randomBytes(8).toString('hex');
}

// Very small UA parser — just enough to produce a nice two-part label.
// We deliberately avoid a UA-parser dependency; the strings we care about
// (Chrome, Safari, Firefox, Edge, mac/windows/linux/iOS/Android) are stable
// substrings that have been consistent for a decade. Unknown shapes fall
// back to "Browser, Unknown".
export function parseUserAgent(uaRaw) {
  const ua = String(uaRaw || '');
  const device = (() => {
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'MacBook';
    if (/Windows NT/i.test(ua)) return 'Windows';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Browser';
  })();
  const browser = (() => {
    // Order matters — Chrome's UA contains "Safari", Edge's contains both,
    // Opera's contains Chrome. Match the most specific first.
    if (/Edg\//i.test(ua)) return 'Edge';
    if (/OPR\//i.test(ua)) return 'Opera';
    if (/Firefox\//i.test(ua)) return 'Firefox';
    if (/Chrome\//i.test(ua)) return 'Chrome';
    if (/Safari\//i.test(ua)) return 'Safari';
    return 'Unknown';
  })();
  return `${device}, ${browser}`;
}
