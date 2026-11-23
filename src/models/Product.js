import mongoose from 'mongoose';
import { positivePriceValidator, compareAtValidator, normaliseWeaveSpelling } from '../validators.js';

const VariantSchema = new mongoose.Schema({
  id: String,
  colour: String,
  hex: String,
  size: { type: String, default: null },
  stock: { type: Number, default: 0 },
  sku: String,
  // Per-variant photographs. When empty, the storefront falls back to the
  // product-level `imageUrls` so admins can skip variant-specific photos
  // and reuse one gallery across colours. Same URL rules as product.imageUrls
  // apply (https in prod, localhost allowed in dev).
  imageUrls: { type: [String], default: [] },
}, { _id: false });

const ProductSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  cat: { type: String, required: true, index: true },
  weave: String,
  name: { type: String, required: true },
  price: { type: Number, required: true, validate: positivePriceValidator },
  compareAt: { type: Number, default: null, validate: { validator: compareAtValidator, message: 'Compare-at price must be greater than price.' } },
  variants: { type: [VariantSchema], default: [] },
  hex: String,
  zariHex: String,
  fabric: String,
  zari: { type: String, default: null },
  border: { type: String, default: null },
  // CAT-04: occasions is the canonical multi-value field. `occasion` (singular) is kept
  // as a mirror of occasions[0] for backwards compatibility with storefront/admin reads.
  occasions: {
    type: [String],
    default: [],
    validate: { validator: (v) => Array.isArray(v) && v.length > 0, message: 'At least one occasion is required.' },
  },
  occasion: String,
  length: { type: String, default: null },
  width: { type: String, default: null },
  blousePiece: { type: Boolean, default: false },
  blouseLength: { type: String, default: '' },
  // PDP Identity card admin fields. Empty-string defaults so the
  // storefront can detect "not set" and skip the row rather than
  // showing a placeholder.
  styleNo: { type: String, default: '' },
  colourLabel: { type: String, default: '' },
  care: String,
  colourNote: String,
  modelHeight: { type: String, default: null },
  drapeStyle: { type: String, default: null },
  images: { type: Number, default: 0 },
  // IMG-01: every URL in imageUrls must be absolute https in production (Cloudinary).
  // In dev (NODE_ENV !== 'production') http://localhost uploads are also accepted so
  // the local disk fallback in routes/uploads.js works without Cloudinary configured.
  imageUrls: {
    type: [String],
    default: [],
    validate: {
      validator: (arr) => {
        if (!Array.isArray(arr)) return false;
        const devOk = process.env.NODE_ENV !== 'production';
        return arr.every((u) => {
          if (!u) return true;
          if (/^https:\/\//i.test(u)) return true;
          return devOk && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(u);
        });
      },
      message: 'imageUrls must be absolute https URLs.',
    },
  },
  // Colour the main image set (`imageUrls`) belongs to. One variant id for
  // the whole gallery — admin labels the set once and every photo in it is
  // understood to be of that colour. '' = shared (shown for every colour).
  imageVariant: { type: String, default: '' },
  video: { type: Boolean, default: false },
  videoName: { type: String, default: '' },
  // Full URL of the uploaded drape video (Cloudinary or /uploads/*). The
  // storefront appends this as the last thumbnail in the PDP gallery and
  // swaps the main pane to a <video> element when it's picked. Optional —
  // empty string means no video for this product.
  videoUrl: { type: String, default: '' },
  // Admin-authored PDP detail fields. Rendered in the "Product Details"
  // tab on the storefront (Identity / Craft & Material / Pack & Provenance).
  designNo: { type: String, default: '' },
  packContains: { type: String, default: '' },
  manufacturedBy: { type: String, default: '' },
  // Admin-authored copy for the other PDP tabs. Empty = the storefront
  // shows an empty-state hint instead of silently falling back to shipped
  // placeholder copy.
  speciality: { type: String, default: '' },
  styleTip: { type: String, default: '' },
  fitTip: { type: String, default: '' },
  shippingNote: { type: String, default: '' },
  // Admin-authored FAQ pairs. Rendered in the "FAQs" tab on the PDP in
  // the order the admin arranges them. Empty = storefront falls back to
  // the shipped generic FAQs so new products never show an empty tab.
  faqs: {
    type: [{ q: { type: String, default: '' }, a: { type: String, default: '' } }],
    default: [],
  },
  hsn: String,
  gst: { type: Number, default: 5 },
  status: { type: String, enum: ['Active', 'Draft', 'Hidden'], default: 'Draft', index: true },
  // Admin-controlled storefront badges (Bestseller, On Sale, New In,
  // Featured, Ready To Ship, Selling Fast). Rendered on cards and the PDP.
  // Kept as plain [String] so new badge kinds can roll out without a
  // schema change.
  badges: { type: [String], default: [] },
  views: { type: Number, default: 0 },
  carts: { type: Number, default: 0 },
  // DATA-03/REV-01: rating is now a number (1..5 average) recomputed from Published reviews.
  // Field kept as String in Mongoose for backwards compat with existing seed data that
  // stored "4.6" as a string; getter normalises on read.
  rating: { type: String, default: '0' },
  reviews: { type: Number, default: 0 },
  verifiedReviews: { type: Number, default: 0 },
  created: String,
}, { timestamps: true, _id: false });

// CAT-05: fold common weave misspellings to the canonical name before any save.
// Covers Mongoose doc.save(). findOneAndUpdate bypasses this — the shared middleware
// in routes/products.js normalises those too.
ProductSchema.pre('save', function normaliseWeave(next) {
  if (this.isModified('weave')) this.weave = normaliseWeaveSpelling(this.weave);
  // CAT-04: keep `occasion` (legacy singular) in sync with occasions[0]. If only the
  // legacy field was written, wrap it into occasions so the required-validator passes.
  if (this.isModified('occasion') && (!this.occasions || this.occasions.length === 0) && this.occasion) {
    this.occasions = [this.occasion];
  }
  if (this.occasions && this.occasions.length) this.occasion = this.occasions[0];
  next();
});

// PERF-01: compound indexes for catalogue filter + storefront queries.
ProductSchema.index({ status: 1, cat: 1, price: 1 });

export const Product = mongoose.model('Product', ProductSchema);
