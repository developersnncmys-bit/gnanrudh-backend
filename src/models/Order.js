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
  // Razorpay payment id, set after /payment/verify confirms a capture.
  rzp: { type: String, default: null },
  // Razorpay order id (gateway-side), set when /payment/order creates it.
  // Required for the admin "Check with Razorpay" flow to look up payment
  // attempts after the fact — without it we have no way to query the gateway.
  rzpOrderId: { type: String, default: null },
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
  // TAX-02: GST recorded on the order so the admin invoice breakdown
  // stays audit-ready. Legacy orders may be undefined; treat missing as 0.
  tax: { type: Number, default: 0 },
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
  // GST-05: B2B invoicing. When the shopper ticks "I need a GST invoice"
  // at checkout (or an admin fills it in on a walk-in order), the GSTIN
  // + business name + billing address land here. The invoice template
  // flips "Customer type" to Registered when `billingGstin` is set and
  // shows the GSTIN under "Billed to" so the buyer can claim input tax
  // credit. All three fields are optional — B2C orders leave them blank.
  billingGstin: { type: String, default: '' },
  billingName: { type: String, default: '' },
  billingAddress: { type: String, default: '' },
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
