import { Router } from 'express';
import { Order } from '../models/Order.js';
import { Return } from '../models/Return.js';
import { Review } from '../models/Review.js';
import { Product } from '../models/Product.js';
import { Customer } from '../models/Customer.js';
import { ShipEvent } from '../models/ShipEvent.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export const statsRouter = Router();

// GET /stats/queue — counts used by the admin's sidebar badges + dashboard
statsRouter.get('/queue', asyncHandler(async (req, res) => {
  const [pending, ndr, retReview, retRefund, reviews, drafts, webhook, oos] = await Promise.all([
    Order.countDocuments({ status: 'Payment pending' }),
    Order.countDocuments({ status: 'Delivery failed' }),
    Return.countDocuments({ status: 'Requested' }),
    Return.countDocuments({ status: 'Received' }),
    Review.countDocuments({ status: 'Pending' }),
    Product.countDocuments({ status: 'Draft' }),
    ShipEvent.countDocuments({ webhook: { $ne: 'Received' } }),
    Product.countDocuments({ status: 'Active', 'variants.stock': 0 }),
  ]);
  res.json({ pending, ndr, retReview, retRefund, reviews, drafts, webhook, oos });
}));

// LOGIC-02: anchor period boundaries to IST (Asia/Kolkata) calendar days.
// Vercel runs in UTC; without this, a "7 days" range ending at 02:00 IST would include
// today's early hours but drop evenings from the oldest day.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const istMidnightDaysAgo = (n) => {
  const istMs = Date.now() + IST_OFFSET_MS;
  const istMidnightTodayMs = Math.floor(istMs / 864e5) * 864e5;
  return new Date(istMidnightTodayMs - n * 864e5 - IST_OFFSET_MS);
};

// GET /stats/dashboard?range=7 — totals + comparisons for the dashboard KPIs
statsRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const range = Math.max(1, Math.min(90, Number(req.query.range) || 7));
  const now = new Date();
  const curStart = istMidnightDaysAgo(range);
  const prevStart = istMidnightDaysAgo(2 * range);

  // LOGIC-01: "Payments received" = money actually in the account.
  // Prepaid 'Paid' + COD 'COD collected'. Excludes COD pending (with courier),
  // COD not collected (RTO), Razorpay-webhook-pending and Refunded.
  const match = (from, to) => ({
    'payment.status': { $in: ['Paid', 'COD collected'] },
    placed: { $gte: from.toISOString(), $lt: to.toISOString() },
  });

  const [cur, prev, codPending] = await Promise.all([
    Order.aggregate([
      { $match: match(curStart, now) },
      { $group: { _id: null, revenue: { $sum: '$total' }, count: { $sum: 1 }, cod: { $sum: { $cond: [{ $eq: ['$payment.method', 'Cash on delivery'] }, 1, 0] } } } },
    ]),
    Order.aggregate([
      { $match: match(prevStart, curStart) },
      { $group: { _id: null, revenue: { $sum: '$total' }, count: { $sum: 1 } } },
    ]),
    // COD cash still with the courier, across all time (a liability counter, not period-scoped).
    Order.aggregate([
      { $match: { 'payment.status': 'COD pending' } },
      { $group: { _id: null, amount: { $sum: '$total' }, count: { $sum: 1 } } },
    ]),
  ]);

  const [buyers, repeaters] = await Promise.all([
    Customer.countDocuments({ orderCount: { $gte: 1 } }),
    Customer.countDocuments({ orderCount: { $gte: 2 } }),
  ]);

  res.json({
    range,
    current: cur[0] || { revenue: 0, count: 0, cod: 0 },
    previous: prev[0] || { revenue: 0, count: 0 },
    codToCollect: codPending[0] || { amount: 0, count: 0 },
    repeatCustomers: repeaters,
    totalBuyers: buyers,
  });
}));

// GET /stats/sales-by-category?days=30
statsRouter.get('/sales-by-category', asyncHandler(async (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const since = istMidnightDaysAgo(days).toISOString();
  const rows = await Order.aggregate([
    { $match: { 'payment.status': { $in: ['Paid', 'COD collected'] }, placed: { $gte: since } } },
    { $unwind: '$items' },
    { $lookup: { from: 'products', localField: 'items.pid', foreignField: '_id', as: 'product' } },
    { $unwind: '$product' },
    { $group: { _id: '$product.cat', value: { $sum: '$items.price' } } },
    { $sort: { value: -1 } },
  ]);
  res.json(rows.map((r) => ({ cat: r._id, value: r.value })));
}));

// GET /stats/revenue-series?days=30&group=silk,cotton
statsRouter.get('/revenue-series', asyncHandler(async (req, res) => {
  const days = Math.max(7, Math.min(90, Number(req.query.days) || 30));
  const since = istMidnightDaysAgo(days).toISOString();
  const series = await Order.aggregate([
    { $match: { 'payment.status': { $in: ['Paid', 'COD collected'] }, placed: { $gte: since } } },
    { $group: { _id: { $substr: ['$placed', 0, 10] }, value: { $sum: '$total' } } },
    { $sort: { _id: 1 } },
  ]);
  res.json(series.map((r) => ({ date: r._id, value: r.value })));
}));
