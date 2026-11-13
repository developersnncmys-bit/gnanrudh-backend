import mongoose from 'mongoose';

const ProfileSchema = new mongoose.Schema({
  who: String,
  bust: Number, waist: Number, shoulder: Number, sleeve: Number,
  armhole: Number, length: Number, neckF: Number, neckB: Number,
  updated: String,
}, { _id: false });

const NoteSchema = new mongoose.Schema({
  text: String,
  at: String,
}, { _id: false });

const CustomerSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  name: { type: String, required: true, index: true },
  city: String,
  state: String,
  pinPrefix: String,
  phone: { type: String, index: true },
  email: { type: String, index: true },
  addresses: { type: Number, default: 1 },
  profiles: { type: [ProfileSchema], default: [] },
  notes: { type: [NoteSchema], default: [] },
  wishlist: { type: [String], default: [] },
  orders: { type: [String], default: [] },
  since: String,
  source: String,
  ltv: { type: Number, default: 0 },
  orderCount: { type: Number, default: 0 },
  lastOrder: { type: String, default: null },
  weaves: { type: [String], default: [] },
  occasions: { type: [String], default: [] },
  payments: {
    paid: { type: Number, default: 0 },
    cod: { type: Number, default: 0 },
    refunded: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
  },
  segment: { type: String, default: 'No orders', index: true },
}, { timestamps: true, _id: false });

export const Customer = mongoose.model('Customer', CustomerSchema);
