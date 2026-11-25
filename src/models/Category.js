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
  // Editorial "Styling Notes" block rendered on the category landing
  // page (CategoryStylingGuide on the storefront). `stylingTips` is
  // capped at four entries by the admin form; the schema accepts any
  // number so future expansions don't need a migration.
  stylingTitle: { type: String, default: '' },
  stylingIntro: { type: String, default: '' },
  stylingTips: {
    type: [{ title: { type: String, default: '' }, body: { type: String, default: '' } }],
    default: [],
  },
}, { timestamps: true, _id: false });

export const Category = mongoose.model('Category', CategorySchema);
