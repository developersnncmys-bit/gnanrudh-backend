import mongoose from 'mongoose';

const ReviewSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  pid: { type: String, index: true },
  cid: { type: String, index: true },
  // DATA-03/REV-01: order the review is attached to. Required for new reviews so we
  // can show "Verified buyer" and block drive-by ratings. Legacy rows carry null.
  oid: { type: String, default: null, index: true },
  verified: { type: Boolean, default: false, index: true },
  rating: { type: Number, min: 1, max: 5 },
  text: String,
  at: String,
  status: { type: String, enum: ['Pending', 'Published', 'Rejected'], default: 'Pending', index: true },
  reply: { type: String, default: '' },
}, { timestamps: true, _id: false });

export const Review = mongoose.model('Review', ReviewSchema);
