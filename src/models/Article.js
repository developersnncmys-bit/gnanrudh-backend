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

// CONT-01: can't flip an article to Published without a body, a cover and an SEO
// description. Drafts and Scheduled stay unrestricted so authors can save work in
// progress; the gate catches publish-by-mistake and the audit's 5 empty-published rows.
function validatePublishable(doc) {
  if (doc.status !== 'Published') return null;
  const missing = [];
  if (!doc.body || String(doc.body).trim().length < 80) missing.push('body (at least 80 characters)');
  if (!doc.cover) missing.push('cover image');
  if (!doc.seoDesc || String(doc.seoDesc).trim().length < 20) missing.push('SEO description (at least 20 characters)');
  return missing.length ? missing : null;
}

ArticleSchema.pre('save', function requirePublishedContent(next) {
  const missing = validatePublishable(this);
  if (missing) {
    const err = new Error(`Cannot publish without ${missing.join(', ')}.`);
    err.name = 'ValidationError';
    err.status = 400;
    return next(err);
  }
  next();
});

// findOneAndUpdate / PATCH path (crudRouter uses this) has to validate too.
ArticleSchema.pre('findOneAndUpdate', async function guardPublish(next) {
  const update = this.getUpdate() || {};
  const next$ = update.$set || update;
  if (next$.status !== 'Published') return next();
  const current = await this.model.findOne(this.getQuery()).lean();
  const merged = { ...(current || {}), ...next$ };
  const missing = validatePublishable(merged);
  if (missing) {
    const err = new Error(`Cannot publish without ${missing.join(', ')}.`);
    err.name = 'ValidationError';
    err.status = 400;
    return next(err);
  }
  next();
});

export const Article = mongoose.model('Article', ArticleSchema);
