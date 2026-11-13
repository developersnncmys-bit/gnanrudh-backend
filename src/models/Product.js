import mongoose from 'mongoose';
import { positivePriceValidator, compareAtValidator } from '../validators.js';

const VariantSchema = new mongoose.Schema({
  id: String,
  colour: String,
  hex: String,
  size: { type: String, default: null },
  stock: { type: Number, default: 0 },
  sku: String,
}, { _id: false });

const ProductSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  cat: { type: String, required: true, index: true },
  weave: String,
  name: { type: String, required: true },
  price: { type: Number, required: true, validate: positivePriceValidator },
  compareAt: { type: Number, default: null, validate: { validator: compareAtValidator, message: 'Compare-at price must be greater than price.' } },
  variants: { type: [VariantSchema], default: [] },
  hex: String,
  zariHex: String,
  fabric: String,
  zari: { type: String, default: null },
  border: { type: String, default: null },
  occasion: String,
  length: { type: String, default: null },
  width: { type: String, default: null },
  blousePiece: { type: Boolean, default: false },
  care: String,
  colourNote: String,
  modelHeight: { type: String, default: null },
  drapeStyle: { type: String, default: null },
  images: { type: Number, default: 0 },
  imageUrls: { type: [String], default: [] },
  video: { type: Boolean, default: false },
  videoName: { type: String, default: '' },
  hsn: String,
  gst: { type: Number, default: 5 },
  status: { type: String, enum: ['Active', 'Draft', 'Hidden'], default: 'Draft', index: true },
  views: { type: Number, default: 0 },
  carts: { type: Number, default: 0 },
  rating: { type: String, default: '0' },
  reviews: { type: Number, default: 0 },
  created: String,
}, { timestamps: true, _id: false });

export const Product = mongoose.model('Product', ProductSchema);
