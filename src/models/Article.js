import mongoose from 'mongoose';

const ArticleSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  title: { type: String, required: true },
  type: String,
  status: { type: String, enum: ['Draft', 'Scheduled', 'Published'], default: 'Draft', index: true },
  views: { type: Number, default: 0 },
  date: String,
  slug: { type: String, index: true },
  seoTitle: String,
  seoDesc: String,
  body: String,
  cover: { type: String, default: '' },
}, { timestamps: true, _id: false });

export const Article = mongoose.model('Article', ArticleSchema);
