import mongoose from 'mongoose';

// A "Shop by price" bucket shown on the storefront. `max === null` means "no upper limit".
const PriceRangeSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true },
  min: { type: Number, default: 0, min: 0 },
  max: { type: Number, default: null, min: 0 }, // null = open upper bound
  order: { type: Number, default: 0 },
  visible: { type: Boolean, default: true },
}, { timestamps: true });

PriceRangeSchema.pre('validate', function (next) {
  if (this.max != null && this.max <= this.min) return next(new Error('Max must be greater than min'));
  next();
});

export const PriceRange = mongoose.model('PriceRange', PriceRangeSchema);
