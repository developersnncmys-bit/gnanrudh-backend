import mongoose from 'mongoose';

const CategorySchema = new mongoose.Schema({
  _id: { type: String, required: true },
  name: { type: String, required: true },
  weaves: { type: [String], default: [] },
  price: { type: [Number], default: [0, 0] },
  weight: { type: Number, default: 400 },
  saree: { type: Boolean, default: false },
  sized: { type: Boolean, default: false },
  visible: { type: Boolean, default: true },
  story: { type: String, default: '' },
  image: { type: String, default: '' },
}, { timestamps: true, _id: false });

export const Category = mongoose.model('Category', CategorySchema);
