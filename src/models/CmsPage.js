import mongoose from 'mongoose';

const CmsPageSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  desc: String,
  updated: String,
  body: String,
  // `banners` is the canonical list of banner image URLs. `banner` is kept as a
  // mirror of banners[0] for back-compat with older reads.
  banners: { type: [String], default: [] },
  banner: String,
}, { timestamps: true });

export const CmsPage = mongoose.model('CmsPage', CmsPageSchema);
