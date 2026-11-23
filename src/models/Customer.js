import mongoose from 'mongoose';
import { optMobileValidator, optEmailValidator } from '../validators.js';

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

const AddressSchema = new mongoose.Schema({
  id: { type: String, required: true },
  label: { type: String, default: 'Home' },
  name: { type: String, default: '' },
  phone: { type: String, default: '' },
  line1: { type: String, default: '' },
  line2: { type: String, default: '' },
  city: { type: String, default: '' },
  state: { type: String, default: '' },
  pin: { type: String, default: '' },
  country: { type: String, default: 'India' },
  isDefault: { type: Boolean, default: false },
}, { _id: false });

const CustomerSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  name: { type: String, required: true, index: true },
  // Split name fields. `name` is kept as the display composite so legacy
  // admin reads keep working; `firstName`/`lastName` are what the signup
  // form captures and what the account UI renders.
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  // Customer auth. Only set for shoppers who signed up with a password;
  // admin-imported customers (orders placed in-store) leave it blank.
  passwordHash: { type: String, default: '', select: false },
  dob: { type: String, default: '' }, // ISO yyyy-mm-dd
  city: String,
  state: String,
  pinPrefix: String,
  phone: { type: String, index: true, validate: optMobileValidator },
  email: { type: String, index: true, validate: optEmailValidator },
  addresses: { type: Number, default: 1 },
  // Structured address book used by the storefront account & checkout.
  // Separate from the legacy `addresses` count above.
  addressBook: { type: [AddressSchema], default: [] },
  profiles: { type: [ProfileSchema], default: [] },
  notes: { type: [NoteSchema], default: [] },
  // CUS-01: wishlist is a set — duplicates collapse on save.
  wishlist: {
    type: [String],
    default: [],
    set: (v) => Array.isArray(v) ? [...new Set(v.filter(Boolean))] : [],
  },
  // Account-tied cart. Each line is a {productId, quantity} pair. Mirrors
  // the shop-store cart on the frontend. Cleared from the device on sign
  // out and restored from this field on sign-in so the user's cart roams
  // across devices and survives browser resets.
  cart: {
    type: [{
      productId: { type: String, required: true },
      quantity: { type: Number, default: 1, min: 1 },
      _id: false,
    }],
    default: [],
  },
  // Tokens are stateless JWTs, so logout can't delete them. Instead we
  // record the logout moment here; any token whose `iat` is earlier than
  // this timestamp is rejected by requireCustomer in customerAuth.js.
  // Re-login mints a token with a fresh `iat`, which is accepted again.
  tokenInvalidBefore: { type: Date, default: null },
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
