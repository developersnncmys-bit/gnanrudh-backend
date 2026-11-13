import mongoose from 'mongoose';

const PieceSchema = new mongoose.Schema({
  _id: { type: String, required: true },      // piece code, e.g. "SIL-490-001"
  pid: { type: String, required: true, index: true },
  vid: { type: String, required: true, index: true },
  status: {
    type: String,
    enum: ['In stock', 'Reserved', 'Packed', 'Shipped', 'Returned', 'Written off'],
    default: 'In stock',
    index: true,
  },
  oid: { type: String, default: null, index: true },
  at: { type: String, required: true },       // ISO datetime of last movement
  received: { type: String, required: true }, // ISO datetime first recorded in stock
  printed: { type: Boolean, default: false },
}, { timestamps: true, _id: false });

export const Piece = mongoose.model('Piece', PieceSchema);
