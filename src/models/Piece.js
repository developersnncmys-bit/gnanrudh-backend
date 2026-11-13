import mongoose from 'mongoose';

const PieceSchema = new mongoose.Schema({
  _id: { type: String, required: true },      // piece code, e.g. "SIL-490-001"
  pid: { type: String, required: true, index: true },
  vid: { type: String, required: true, index: true },
  status: {
    type: String,
    // INV-01: new canonical terminal state is 'Sold' (piece has left the warehouse to a
    // customer). 'Shipped' remains in the enum so historical pieces still validate;
    // new reservations always transition to Reserved -> Packed -> Sold.
    enum: ['In stock', 'Reserved', 'Packed', 'Sold', 'Shipped', 'Returned', 'Written off'],
    default: 'In stock',
    index: true,
  },
  oid: { type: String, default: null, index: true },
  at: { type: String, required: true },       // ISO datetime of last movement
  received: { type: String, required: true }, // ISO datetime first recorded in stock
  printed: { type: Boolean, default: false },
}, { timestamps: true, _id: false });

// PERF-01: compound indexes for the hot reservation + packing queries.
PieceSchema.index({ vid: 1, status: 1 });

export const Piece = mongoose.model('Piece', PieceSchema);
