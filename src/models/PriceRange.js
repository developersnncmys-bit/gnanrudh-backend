import mongoose from 'mongoose';

// A "Shop by price" bucket shown on the storefront. `max === null` means "no upper limit".
const PriceRangeSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true },
  // Storefront-facing headline (e.g. "Everyday Drapes"). Falls back to `label` when empty.
  title: { type: String, default: '', trim: true },
  // Short tagline shown under the title on the storefront card (e.g. "Beauty That Feels as Good as It Looks.").
  description: { type: String, default: '', trim: true },
  min: { type: Number, default: 0, min: 0 },
  max: { type: Number, default: null, min: 0 }, // null = open upper bound
  order: { type: Number, default: 0 },
  visible: { type: Boolean, default: true },
  image: { type: String, default: '' },
}, { timestamps: true });

PriceRangeSchema.pre('validate', function (next) {
  if (this.max != null && this.max <= this.min) return next(new Error('Max must be greater than min'));
  next();
});

export const PriceRange = mongoose.model('PriceRange', PriceRangeSchema);
