import mongoose from 'mongoose';

const CmsPageSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  desc: String,
  updated: String,
  body: String,
}, { timestamps: true });

export const CmsPage = mongoose.model('CmsPage', CmsPageSchema);
