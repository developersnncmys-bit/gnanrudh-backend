import mongoose from 'mongoose';
import { positivePriceValidator, compareAtValidator, normaliseWeaveSpelling } from '../validators.js';

const VariantSchema = new mongoose.Schema({
  id: String,
  colour: String,
  hex: String,
  size: { type: String, default: null },
  stock: { type: Number, default: 0 },
  sku: String,
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
  care: String,
  colourNote: String,
  modelHeight: { type: String, default: null },
  drapeStyle: { type: String, default: null },
  images: { type: Number, default: 0 },
  imageUrls: { type: [String], default: [] },
  video: { type: Boolean, default: false },
  videoName: { type: String, default: '' },
  hsn: String,
  gst: { type: Number, default: 5 },
  status: { type: String, enum: ['Active', 'Draft', 'Hidden'], default: 'Draft', index: true },
  views: { type: Number, default: 0 },
  carts: { type: Number, default: 0 },
  rating: { type: String, default: '0' },
  reviews: { type: Number, default: 0 },
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

export const Product = mongoose.model('Product', ProductSchema);
