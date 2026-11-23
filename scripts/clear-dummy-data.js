// One-shot cleanup: wipe transactional dummy data, keep exactly 1 product.
// Preserves settings, CRM thresholds, policy, categories, occasions, price ranges,
// CMS pages, scenes, users and login attempts.
//
// Usage:
//   MONGO_URI=... node scripts/clear-dummy-data.js            # dry-run
//   MONGO_URI=... node scripts/clear-dummy-data.js --apply    # actually delete

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/db.js';
import { Product } from '../src/models/Product.js';
import { Customer } from '../src/models/Customer.js';
import { Order } from '../src/models/Order.js';
import { Return } from '../src/models/Return.js';
import { ShipEvent } from '../src/models/ShipEvent.js';
import { Coupon } from '../src/models/Coupon.js';
import { Review } from '../src/models/Review.js';
import { Article } from '../src/models/Article.js';
import { Piece } from '../src/models/Piece.js';
import { Movement } from '../src/models/Movement.js';
import { Singleton } from '../src/models/Singleton.js';

const apply = process.argv.includes('--apply');

async function main() {
  await connectDB();

  // Pick the single product to keep: prefer an Active one, else any.
  const keep = (await Product.findOne({ status: 'Active' }).lean())
    || (await Product.findOne({}).lean());
  if (!keep) {
    console.log('[clear] no products found; nothing to keep.');
  } else {
    console.log(`[clear] keeping product ${keep._id} — "${keep.name}"`);
  }

  const counts = {
    productsToDelete: keep ? await Product.countDocuments({ _id: { $ne: keep._id } }) : await Product.countDocuments({}),
    customers: await Customer.countDocuments({}),
    orders: await Order.countDocuments({}),
    returns: await Return.countDocuments({}),
    shipEvents: await ShipEvent.countDocuments({}),
    coupons: await Coupon.countDocuments({}),
    reviews: await Review.countDocuments({}),
    articles: await Article.countDocuments({}),
    pieces: await Piece.countDocuments({}),
    movements: await Movement.countDocuments({}),
  };
  console.log('[clear] will delete:', counts);

  if (!apply) {
    console.log('[clear] dry run. re-run with --apply to commit.');
    await mongoose.disconnect();
    return;
  }

  if (keep) {
    await Product.deleteMany({ _id: { $ne: keep._id } });
  } else {
    await Product.deleteMany({});
  }
  await Customer.deleteMany({});
  await Order.deleteMany({});
  await Return.deleteMany({});
  await ShipEvent.deleteMany({});
  await Coupon.deleteMany({});
  await Review.deleteMany({});
  await Article.deleteMany({});
  await Piece.deleteMany({});
  await Movement.deleteMany({});

  // Reset invoice/credit-note counters since the ledger is now empty.
  await Singleton.updateOne({ _id: 'counters' }, { $set: { data: { invSeq: 1, cnSeq: 1 } } }, { upsert: true });

  // Trim featured list to the surviving product (if it was featured) else clear it.
  const featured = await Singleton.findOne({ _id: 'featured' }).lean();
  const ids = Array.isArray(featured?.data?.ids) ? featured.data.ids : [];
  const nextIds = keep ? ids.filter((id) => id === keep._id) : [];
  if (featured) {
    await Singleton.updateOne({ _id: 'featured' }, { $set: { data: { ids: nextIds } } });
  }

  // Reset the surviving product's review/rating rollups since reviews are gone.
  if (keep) {
    await Product.updateOne({ _id: keep._id }, { $set: { rating: '0', reviews: 0, verifiedReviews: 0, views: 0, carts: 0 } });
  }

  console.log('[clear] done.');
  await mongoose.disconnect();
}

main().catch((e) => { console.error('[clear] failed', e); process.exit(1); });
