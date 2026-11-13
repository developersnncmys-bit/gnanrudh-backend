// TAX-02: GST slab recommended by HSN chapter + unit price.
// Source: CBIC notification effective 22 Sep 2025 (apparel threshold raised to Rs. 2,500).
//
// Rules:
//  - HSN chapters 61, 62, 63 (stitched apparel): 5% up to Rs. 2,500 per piece, 18% above.
//  - HSN chapters 50-55 (unstitched fabric incl. sarees): 5%.
//  - HSN 7117 (imitation jewellery): 3%.
//  - Anything else: null (caller decides, usually falls back to stored product.gst).
//
// Returns a number (percent) or null when the HSN isn't recognised.

export function computeGstRate(hsn, unitPrice) {
  const h = String(hsn || '').trim();
  if (!h) return null;
  const chapter = Number(h.slice(0, 2));
  const price = Number(unitPrice) || 0;
  if ([61, 62, 63].includes(chapter)) return price > 2500 ? 18 : 5;
  if (chapter >= 50 && chapter <= 55) return 5;
  if (h.startsWith('7117')) return 3;
  return null;
}
