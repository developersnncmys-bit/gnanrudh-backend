import mongoose from 'mongoose';

// Occasions are a small reference list used by products (p.occasion) and the
// store's filters. Stored with the name as the primary key so renames behave
// like replace-and-re-link.
const OccasionSchema = new mongoose.Schema({
  _id: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  // _id of the parent occasion. Null = top-level occasion.
  parent: { type: String, default: null, index: true },
  order: { type: Number, default: 0 },
  // Absolute URL of the tile image uploaded via /api/uploads. Empty string = no image.
  image: { type: String, default: '' },
}, { timestamps: true, _id: false });

export const Occasion = mongoose.model('Occasion', OccasionSchema);
