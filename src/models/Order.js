import mongoose from 'mongoose';
import { optPincodeValidator } from '../validators.js';

const OrderItemSchema = new mongoose.Schema({
  pid: String,
  vid: String,
  qty: { type: Number, default: 1 },
  price: Number,
  stitch: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const PaymentSchema = new mongoose.Schema({
  method: String,
  status: String,
  rzp: { type: String, default: null },
}, { _id: false });

const ShipSchema = new mongoose.Schema({
  courier: { type: String, default: null },
  awb: { type: String, default: null },
  weight: Number,
  slab: String,
  rate: Number,
  pin: { type: String, validate: optPincodeValidator },
  etd: String,
}, { _id: false });

const OrderSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  placed: { type: String, required: true, index: true },
  cid: { type: String, required: true, index: true },
  items: { type: [OrderItemSchema], default: [] },
  sub: Number,
  coupon: { type: String, default: null },
  discount: { type: Number, default: 0 },
  shipping: { type: Number, default: 0 },
  total: { type: Number, required: true },
  payment: PaymentSchema,
  status: { type: String, required: true, index: true },
  invoice: { type: String, default: null },
  creditNote: { type: String, default: null },
  ship: ShipSchema,
  ndr: { type: String, default: null },
  source: String,
  promised: String,
  // RET-01: set when Shiprocket's Delivered webhook lands (or manual "mark delivered").
  // Returns compute eligibility from this + Settings.policy.window.
  deliveredAt: { type: String, default: null },
}, { timestamps: true, _id: false });

// PERF-01: compound indexes for the hot dashboard + listing queries.
OrderSchema.index({ status: 1, placed: -1 });
// Unique only among orders that actually have an invoice string. A sparse index
// still indexes `invoice: null` and collides across multiple pending orders;
// a partial filter skips nulls entirely, which is what we want.
OrderSchema.index(
  { invoice: 1 },
  { unique: true, partialFilterExpression: { invoice: { $type: 'string' } } },
);

export const Order = mongoose.model('Order', OrderSchema);
