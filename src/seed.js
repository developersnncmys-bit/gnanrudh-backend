// Seeds MongoDB with the same fixture data the admin frontend used in-memory.
// Idempotent: drops each collection first, then inserts.
import mongoose from 'mongoose';
import { connectDB } from './db.js';
import { Category } from './models/Category.js';
import { Product } from './models/Product.js';
import { Customer } from './models/Customer.js';
import { Order } from './models/Order.js';
import { Return } from './models/Return.js';
import { ShipEvent } from './models/ShipEvent.js';
import { Coupon } from './models/Coupon.js';
import { Review } from './models/Review.js';
import { Article } from './models/Article.js';
import { CmsPage } from './models/CmsPage.js';
import { Scene } from './models/Scene.js';
import { Singleton } from './models/Singleton.js';
import { Occasion } from './models/Occasion.js';
import { User } from './models/User.js';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

// Deterministic PRNG and formatters — same as the frontend's.
const rng = (seed) => () => { let t = (seed += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const R = rng(2026);
const pick = (a, r = R) => a[Math.floor(r() * a.length)];
const between = (a, b, r = R) => a + Math.floor(r() * (b - a + 1));
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysFrom = (ref, v) => Math.round((new Date(iso(new Date(v))) - new Date(iso(ref))) / 864e5);
const TODAY = new Date(iso(new Date()));

const categories = [
  { _id: 'silk', name: 'Silk Sarees', weaves: ['Kanjivaram', 'Banarasi', 'Mysore silk', 'Tussar', 'Paithani', 'Patola'], price: [9000, 180000], weight: 850, saree: true, story: 'The flagship aisle. Every piece carries its weave, zari and origin.' },
  { _id: 'cotton', name: 'Cotton and Handloom', weaves: ['Ilkal', 'Chanderi', 'Maheshwari', 'Jamdani', 'Kota Doria', 'Mangalgiri'], price: [1800, 14000], weight: 450, saree: true, story: 'Everyday handloom from the clusters we buy from directly.' },
  { _id: 'designer', name: 'Designer and Party Wear', weaves: ['Georgette', 'Organza', 'Chiffon', 'Sequinned', 'Embroidered'], price: [4500, 38000], weight: 550, saree: true, story: 'Limited drops for evenings and receptions.' },
  { _id: 'lehenga', name: 'Lehengas and Ethnic Sets', weaves: ['Lehenga', 'Half saree', 'Kurta set', 'Salwar set', 'Dupatta'], price: [3500, 90000], weight: 1300, saree: false, sized: true, story: 'For the wedding season and the festivals around it.' },
  { _id: 'acc', name: 'Accessories', weaves: ['Petticoat', 'Falls and pico', 'Saree pins', 'Potli bag', 'Imitation jewellery', 'Shapewear'], price: [150, 4500], weight: 150, saree: false, story: 'The things that finish a drape, beside the cart.' },
];
const CAT = Object.fromEntries(categories.map((c) => [c._id, c]));

const COLORS = [['Peacock blue', '#1f5f7a'], ['Mango yellow', '#e0a526'], ['Rani pink', '#c2185b'], ['Bottle green', '#1e5c3a'], ['Maroon', '#6d1b2c'], ['Mustard', '#c9932b'], ['Wine', '#5a1f33'], ['Ivory', '#ece2cc'], ['Lotus pink', '#e8a3b5'], ['Parrot green', '#6aa84f'], ['Royal blue', '#2c4fa3'], ['Black', '#26232a'], ['Onion pink', '#d9a5a0'], ['Teal', '#1d7473'], ['Lavender', '#a693c9']];
const MOTIFS = ['temple border', 'mango buttas', 'peacock pallu', 'korvai checks', 'jaal weave', 'rudraksha border', 'annam motifs', 'contrast pallu', 'zari stripes', 'floral vines'];
const BORDERS = ['Temple border', 'Korvai contrast', 'Plain zari', 'Thread border', 'No border'];
const OCCASIONS = ['Wedding', 'Festival', 'Temple', 'Office', 'Party'];
const SIZES = ['32', '34', '36', '38', '40'];

const products = Array.from({ length: 96 }, (_, i) => {
  const c = categories[[0, 0, 0, 1, 1, 2, 3, 2, 4, 0, 1, 2][i % 12]];
  const weave = pick(c.weaves);
  const nVar = c._id === 'silk' && R() < 0.5 ? 1 : between(1, 3);
  const variants = Array.from({ length: nVar }, (_, v) => {
    const [colour, hex] = COLORS[(i * 3 + v * 5) % COLORS.length];
    return { id: `V${i}-${v}`, colour, hex, size: c.sized ? SIZES[(i + v) % SIZES.length] : null, stock: R() < 0.06 ? 0 : c._id === 'silk' ? between(1, 3) : between(1, 14), sku: `${c._id.slice(0, 3).toUpperCase()}-${pad(i)}${v}` };
  });
  const zari = c._id === 'silk' ? pick(['Pure zari', 'Pure zari', 'Tested zari']) : c.saree ? pick(['Tested zari', 'No zari', 'No zari']) : null;
  const price = Math.round(between(c.price[0], c.price[1]) / 100) * 100;
  const name = c.saree ? `${variants[0].colour} ${weave} with ${pick(MOTIFS)}` : c._id === 'acc' ? `${weave}, ${pick(['classic', 'festive', 'everyday', 'bridal'])}` : `${variants[0].colour} ${weave.toLowerCase()}, ${pick(['zari work', 'mirror work', 'hand embroidered', 'printed'])}`;
  const status = R() < 0.05 ? 'Draft' : R() < 0.03 ? 'Hidden' : 'Active';
  const views = between(60, 4200);
  return {
    _id: `P${1000 + i}`, cat: c._id, weave, name, price, compareAt: R() < 0.18 ? Math.round(price * 1.15 / 100) * 100 : null, variants,
    hex: variants[0].hex, zariHex: zari === 'Pure zari' ? '#c9a227' : zari === 'Tested zari' ? '#b9a26a' : '#d8cfbf',
    fabric: c._id === 'silk' ? 'Pure silk' : c._id === 'cotton' ? pick(['Cotton', 'Silk cotton']) : c._id === 'designer' ? weave : c._id === 'acc' ? '—' : pick(['Silk', 'Georgette', 'Cotton']),
    zari, border: c.saree ? pick(BORDERS) : null, occasion: pick(OCCASIONS),
    length: c.saree ? pick(['5.5 m', '6.3 m']) : null, width: c.saree ? pick(['1.14 m', '1.2 m']) : null, blousePiece: c.saree ? R() < 0.85 : false,
    care: c._id === 'silk' ? 'Dry clean only. Store folded in muslin; refold every three months.' : 'Gentle hand wash in cold water. Dry in shade.',
    colourNote: 'Photographed in daylight. Screens vary; the fabric may read slightly warmer in person.',
    modelHeight: c.saree || c._id === 'lehenga' ? pick(['5 ft 4 in', '5 ft 6 in', '5 ft 7 in']) : null,
    drapeStyle: c.saree ? pick(['Nivi', 'Nivi', 'Bengali', 'Gujarati']) : null,
    images: status === 'Draft' ? between(0, 3) : between(4, 9),
    video: c.saree && R() < 0.45, videoName: '', imageUrls: [],
    hsn: c._id === 'acc' ? '6217' : c.saree ? (c._id === 'silk' ? '5007' : '5208') : '6204', gst: 5,
    status, views, carts: Math.round(views * (0.02 + R() * 0.07)),
    rating: (3.6 + R() * 1.4).toFixed(1), reviews: between(0, 34),
    created: iso(addDays(TODAY, -between(1, 300))),
  };
});

const FIRST = ['Lakshmi', 'Priya', 'Meenakshi', 'Kavya', 'Anjali', 'Divya', 'Sowmya', 'Revathi', 'Nandini', 'Shruti', 'Pooja', 'Aparna', 'Deepika', 'Gayathri', 'Harini', 'Ishita', 'Janani', 'Keerthana', 'Madhavi', 'Nisha', 'Radhika', 'Sangeetha', 'Uma', 'Vidya'];
const LAST = ['Iyer', 'Reddy', 'Nair', 'Rao', 'Sharma', 'Menon', 'Krishnan', 'Pillai', 'Hegde', 'Kulkarni', 'Subramaniam', 'Gupta', 'Shetty', 'Bhat'];
const PLACES = [['Bengaluru', 'Karnataka', '5600'], ['Mysuru', 'Karnataka', '5700'], ['Chennai', 'Tamil Nadu', '6000'], ['Hyderabad', 'Telangana', '5000'], ['Mumbai', 'Maharashtra', '4000'], ['Pune', 'Maharashtra', '4110'], ['Kochi', 'Kerala', '6820'], ['Coimbatore', 'Tamil Nadu', '6410'], ['Delhi', 'Delhi', '1100'], ['Kolkata', 'West Bengal', '7000']];
const NOTES = ['Prefers lighter zari', 'Stitches elbow length sleeves only', 'Likes contrast pallu', 'Ask before substituting colour'];
const mkProfile = (who) => ({ who, bust: 32 + between(0, 8), waist: 26 + between(0, 10), shoulder: 13.5 + between(0, 3) / 2, sleeve: pick([6, 8, 11, 12]), armhole: 15 + between(0, 4) / 2, length: 14 + between(0, 2) / 2, neckF: pick([6, 6.5, 7, 7.5]), neckB: pick([7, 8, 9, 10]), updated: iso(addDays(TODAY, -between(5, 400))) });

const customers = Array.from({ length: 130 }, (_, i) => {
  const pl = PLACES[i % 10 < 3 ? i % 2 : Math.floor(R() * PLACES.length)];
  const name = `${FIRST[(i * 5) % FIRST.length]} ${LAST[(i * 3 + 1) % LAST.length]}`;
  const profiles = R() < 0.55 ? [mkProfile('Self'), ...(R() < 0.35 ? [mkProfile(pick(['Mother', 'Daughter', 'Sister']))] : [])] : [];
  return {
    _id: `C${5000 + i}`, name, city: pl[0], state: pl[1], pinPrefix: pl[2],
    phone: `+91 9${between(10, 99)}${between(100, 999)} ${between(10000, 99999)}`,
    email: `${name.split(' ')[0].toLowerCase()}.${name.split(' ')[1].toLowerCase()}@gmail.com`,
    addresses: between(1, 3), profiles,
    notes: R() < 0.3 ? [{ text: pick(NOTES), at: iso(addDays(TODAY, -between(3, 200))) }] : [],
    wishlist: Array.from({ length: between(0, 4) }, () => pick(products)._id),
    orders: [], since: iso(addDays(TODAY, -between(30, 900))),
    source: pick(['Direct', 'Google', 'Google', 'Instagram', 'Instagram', 'WhatsApp', 'Referral']),
    ltv: 0, orderCount: 0, lastOrder: null, weaves: [], occasions: [],
    payments: { paid: 0, cod: 0, refunded: 0, pending: 0 }, segment: 'No orders',
  };
});
const CUST = Object.fromEntries(customers.map((c) => [c._id, c]));

const COURIERS = ['Delhivery', 'Blue Dart', 'DTDC', 'Ekart', 'Xpressbees'];
const orders = [];
let invSeq = 1, cnSeq = 1;
for (let i = 0; i < 190; i++) {
  const age = i < 4 ? 0 : i < 8 ? between(1, 2) : R() < 0.7 ? between(1, 75) : between(76, 330);
  const placed = addDays(TODAY, -age); placed.setHours(between(8, 23), between(0, 59));
  const c = customers[Math.floor(R() * customers.length)];
  const items = Array.from({ length: R() < 0.74 ? 1 : 2 }, () => {
    const p = pick(products.filter((x) => x.status === 'Active'));
    const v = pick(p.variants);
    return { pid: p._id, vid: v.id, qty: 1, price: p.price, stitch: null };
  });
  const sub = items.reduce((a, it) => a + it.price * it.qty, 0);
  const coupon = R() < 0.2 ? pick(['FIRSTDRAPE', 'WEDDING10', 'COTTON5']) : null;
  const discount = coupon ? Math.round(sub * (coupon === 'WEDDING10' ? 0.1 : 0.05)) : 0;
  const shipping = sub > 2999 ? 0 : 99;
  const total = sub - discount + shipping;
  const method = i < 2 ? 'UPI' : R() < 0.22 && total < 25000 ? 'Cash on delivery' : pick(['UPI', 'UPI', 'UPI', 'Card', 'Netbanking', 'Wallet', 'EMI']);
  let status;
  if (age === 0) status = i === 1 ? 'Payment pending' : 'Label generated';
  else if (age <= 3) status = pick(['Label generated', 'In transit', 'In transit']);
  else if (age <= 8) status = pick(['In transit', 'Delivered', 'Delivered', 'Delivery failed']);
  else status = method === 'Cash on delivery' && R() < 0.15 ? 'Returned to origin' : R() < 0.03 ? 'Cancelled' : 'Delivered';
  const pay = status === 'Payment pending' ? 'Pending' : method === 'Cash on delivery' ? (status === 'Delivered' ? 'COD collected' : status === 'Returned to origin' || status === 'Cancelled' ? 'COD not collected' : 'COD pending') : status === 'Cancelled' ? 'Refunded' : 'Paid';
  const weight = items.reduce((a, it) => a + CAT[products.find((p) => p._id === it.pid).cat].weight, 0) + 120;
  const pin = `${c.pinPrefix}${between(10, 99)}`;
  const o = {
    _id: `GR${10400 + i}`, placed: placed.toISOString(), cid: c._id, items, sub, coupon, discount, shipping, total,
    payment: { method, status: pay, rzp: method === 'Cash on delivery' ? null : `pay_${Math.random().toString(36).slice(2, 16)}` },
    status, invoice: status !== 'Payment pending' ? `GR/26-27/${pad(invSeq++).padStart(4, '0')}` : null, creditNote: null,
    ship: { courier: ['Label generated', 'In transit', 'Delivered', 'Delivery failed', 'Returned to origin'].includes(status) ? pick(COURIERS) : null, awb: null, weight, slab: `${Math.ceil(weight / 500) * 0.5} kg`, rate: 60 + Math.ceil(weight / 500) * 38, pin, etd: iso(addDays(placed, between(3, 6))) },
    ndr: status === 'Delivery failed' ? pick(['Customer not reachable', 'Address incomplete', 'Customer asked to reschedule', 'Refused at door']) : null,
    source: c.source, promised: iso(addDays(placed, 2)),
  };
  if (o.ship.courier) o.ship.awb = `${between(10000000, 99999999)}${between(10, 99)}`;
  c.orders.push(o._id);
  orders.push(o);
}

// Customer roll-ups
const CRM = { vip: 150000, dormantDays: 180, repeatOrders: 2 };
customers.forEach((c) => {
  const os = c.orders.map((id) => orders.find((o) => o._id === id)).filter((o) => o && o.status !== 'Cancelled' && o.status !== 'Payment pending').sort((a, b) => (a.placed < b.placed ? 1 : -1));
  c.ltv = os.reduce((a, o) => a + o.total, 0);
  c.orderCount = os.length;
  c.lastOrder = os[0]?.placed || null;
  c.weaves = [...new Set(os.flatMap((o) => o.items.map((it) => products.find((p) => p._id === it.pid).weave)))];
  c.occasions = [...new Set(os.flatMap((o) => o.items.map((it) => products.find((p) => p._id === it.pid).occasion)))];
  c.payments = {
    paid: os.filter((o) => o.payment.status === 'Paid').length,
    cod: os.filter((o) => o.payment.status.startsWith('COD')).length,
    refunded: c.orders.filter((id) => orders.find((o) => o._id === id)?.payment.status === 'Refunded').length,
    pending: c.orders.filter((id) => orders.find((o) => o._id === id)?.payment.status === 'Pending').length,
  };
  const dormant = c.lastOrder && daysFrom(TODAY, c.lastOrder) < -CRM.dormantDays;
  c.segment = !c.orderCount ? 'No orders' : dormant ? 'Dormant' : c.ltv >= CRM.vip ? 'VIP' : c.orderCount >= CRM.repeatOrders ? 'Repeat' : 'New';
});

// Returns
const POLICY = { window: 7, excludeStitched: true, excludeFalls: true, excludeCustom: true, reversePaidBy: 'Store', reverseFee: 0 };
const RET_REASONS = ['Colour different from photos', 'Drape or fabric not as expected', 'Damaged in transit', 'Received a different piece', 'Changed my mind', 'Size does not fit'];
const returns = orders.filter((o) => o.status === 'Delivered').slice(0, 16).map((o, i) => {
  const it = o.items[0];
  const p = products.find((x) => x._id === it.pid);
  const excluded = p.weave === 'Falls and pico' && POLICY.excludeFalls;
  const status = excluded ? 'Not eligible' : pick(['Requested', 'Requested', 'Pickup scheduled', 'Picked up', 'Received', 'Received', 'Refunded', 'Rejected']);
  return { _id: `RT${900 + i}`, oid: o._id, pid: it.pid, cid: o.cid, reason: pick(RET_REASONS), requested: iso(addDays(TODAY, -between(0, 30))), amount: it.price, excluded, stitched: false, status, awb: ['Pickup scheduled', 'Picked up', 'Received', 'Refunded'].includes(status) ? `R${between(10000000, 99999999)}` : null };
});
returns.filter((r) => r.status === 'Refunded').forEach((r) => {
  const o = orders.find((x) => x._id === r.oid);
  if (o) { o.creditNote = `GR-CN/26-27/${String(cnSeq++).padStart(4, '0')}`; o.payment.status = 'Refunded'; }
});

// Ship events
const shipLog = [];
orders.filter((o) => o.ship.awb && daysFrom(TODAY, o.placed) > -10).forEach((o) => {
  const t = new Date(o.placed);
  const push = (type, h, extra = {}) => shipLog.push({ _id: `SL${shipLog.length}`, oid: o._id, type, at: new Date(t.getTime() + h * 3600e3).toISOString(), courier: o.ship.courier, awb: o.ship.awb, webhook: R() < 0.008 ? 'Failed, retrying' : 'Received', ...extra });
  push('Order pushed', 0.01); push('Label generated', 0.02);
  if (o.status !== 'Label generated') { push('Picked up', 20); push('In transit', 30); }
  if (o.status === 'Delivered') push('Delivered', 80);
  if (o.status === 'Delivery failed') push('NDR raised', 70, { detail: o.ndr });
  if (o.status === 'Returned to origin') push('RTO initiated', 120);
});
returns.filter((r) => r.awb).forEach((r) => shipLog.push({ _id: `SL${shipLog.length}R`, oid: r.oid, type: 'Reverse pickup created', at: new Date(new Date(r.requested).getTime() + 26 * 3600e3).toISOString(), courier: 'Delhivery', awb: r.awb, webhook: 'Received' }));

const coupons = [
  { _id: 'FIRSTDRAPE', kind: 'Percent', value: 5, min: 2000, scope: 'First order', uses: 214, limit: null, ends: null, on: true },
  { _id: 'WEDDING10', kind: 'Percent', value: 10, min: 15000, scope: 'Silk Sarees', uses: 61, limit: 200, ends: iso(addDays(TODAY, 40)), on: true },
  { _id: 'COTTON5', kind: 'Percent', value: 5, min: 1500, scope: 'Cotton and Handloom', uses: 98, limit: null, ends: null, on: true },
  { _id: 'PONGAL500', kind: 'Flat', value: 500, min: 5000, scope: 'All products', uses: 0, limit: 300, ends: iso(addDays(TODAY, 70)), on: false },
];

const reviews = Array.from({ length: 14 }, (_, i) => {
  const p = pick(products.filter((x) => x.status === 'Active')); const c = pick(customers); const rating = pick([5, 5, 4, 5, 3, 2, 4, 1]);
  return { _id: `RV${i}`, pid: p._id, cid: c._id, rating, text: rating >= 4 ? pick(['The zari is richer in person. Drapes beautifully.', 'Exactly the colour in the daylight photo.', 'Soft, light and the pallu falls well.']) : pick(['Colour was a little darker than the photos.', 'Delivery took longer than promised.']), at: iso(addDays(TODAY, -between(0, 15))), status: i < 7 ? 'Pending' : pick(['Published', 'Published', 'Rejected']), reply: '' };
});

const journal = [
  ['How to drape a Kanjivaram in the Nivi style', 'Draping guide', 'Published', 4120],
  ['Pure zari or tested zari: how to tell the difference', 'Weave guide', 'Published', 6890],
  ['Caring for silk: folding, storing and refolding zari', 'Zari care', 'Published', 3310],
  ['Wedding season lookbook: five silks, five rituals', 'Lookbook', 'Published', 2540],
  ['Ilkal, Chanderi, Maheshwari: a guide to everyday handloom', 'Weave guide', 'Published', 1980],
  ['Blouse measurements: taking them right at home', 'Draping guide', 'Draft', 0],
  ['Festival edit: Pongal and Sankranti', 'Lookbook', 'Scheduled', 0],
].map(([title, type, status, views], i) => ({ _id: `J${i}`, title, type, status, views, date: status === 'Scheduled' ? iso(addDays(TODAY, 30)) : iso(addDays(TODAY, -between(4, 140))), slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), seoTitle: `${title} | House of GnanRudh`, seoDesc: '', body: '' }));

const scenes = [
  ['The Loom', 'Woven to be worn. Not just owned.'],
  ['Six Aisles', 'Six aisles. One house.'],
  ['The Drape', 'Seen before it is bought.'],
  ['The Occasion', 'A weave for every morning of the year.'],
  ['The Rail', 'Yesterday’s story becomes today’s cart.'],
  ['Your Story Continues', 'Welcome back. Your measurements are saved.'],
].map(([name, line], i) => ({ order: i, name, line }));

const pages = [
  ['Home', 'The storefront landing page. Upload a hero banner shown at the top above the homepage story.', 2],
  ['Our house', 'Founder’s story, the weavers and clusters we buy from, and what the house will not stock.', 12],
  ['Contact', 'Map, enquiry form, phone, WhatsApp and email.', 40],
  ['Shipping policy', 'Delivery timelines, charges and COD.', 22],
  ['Returns policy', 'Window, conditions and refunds. Reflects Settings, Returns policy.', 9],
  ['Privacy policy', 'How customer and measurement data is used.', 60],
  ['Terms of use', 'Terms for using the store.', 60],
  ['GST policy', 'Tax invoices, credit notes and GSTIN details.', 30],
].map(([name, desc, d]) => {
  // LEGAL-01: stub bodies, flagged by the admin "Stub body" badge until they cross 800 chars.
  // Returns policy is pre-populated with the Settings tokens so the admin sees how to use them.
  let body = `# ${name}\n\n${desc}\n\nTODO: supply full policy text.`;
  if (name === 'Returns policy') {
    body = `# Returns policy\n\nWe accept returns within {{returnWindow}} of delivery.\n\n## Conditions\n\n{{returnConditions}}\n\n## Reverse shipping\n\n{{reverseShippingRule}}\n\nTODO: supply full policy text (headings, lists, links). The tokens above pull their values from Settings so this page stays in sync when you change the return window or conditions.`;
  }
  return { name, desc, updated: iso(addDays(TODAY, -d)), body };
});

// DEV-SEED: the seller details below are placeholders chosen so `settingsReady`
// passes in a dev environment (manual-order invoice generation needs this).
// They are NOT a real GSTIN / phone / address — replace with real values before
// using in production. The validator blocks the old `29ABCDE1234F1Z5` literal,
// so we use a different syntactically-valid GSTIN here.
const SETTINGS = {
  store: { name: 'House of GnanRudh', site: 'houseofgnanrudh.com', phone: '+91 98765 43210', email: 'care@houseofgnanrudh.com', address: 'No. 42, 3rd Cross, Indiranagar, Bengaluru, Karnataka 560038' },
  pay: { methods: { UPI: true, Cards: true, Wallets: true, Netbanking: true, EMI: true }, cod: true, codCap: 25000, codPins: 1842, codFile: '' },
  ship: { packaging: 120, freeAbove: 2999 },
  gst: { gstin: '29GNRUD2026A1ZV', inv: 'GR/26-27/', cn: 'GR-CN/26-27/' },
  account: { email: 'surekha@houseofgnanrudh.com', pwChanged: iso(addDays(TODAY, -64)), devices: [{ name: 'MacBook, Chrome', where: 'Bengaluru' }, { name: 'iPhone, Safari', where: 'Bengaluru' }] },
};

const featuredIds = products.filter((p) => p.cat === 'silk' && p.status === 'Active').slice(0, 6).map((p) => p._id);

async function run() {
  await connectDB();
  console.log('[seed] clearing collections…');
  await Promise.all([
    Category.deleteMany({}), Product.deleteMany({}), Customer.deleteMany({}), Order.deleteMany({}),
    Return.deleteMany({}), ShipEvent.deleteMany({}), Coupon.deleteMany({}), Review.deleteMany({}),
    Article.deleteMany({}), CmsPage.deleteMany({}), Scene.deleteMany({}), Singleton.deleteMany({}),
    Occasion.deleteMany({}),
  ]);

  console.log('[seed] inserting…');
  await Category.insertMany(categories);
  await Product.insertMany(products);
  await Customer.insertMany(customers);
  await Order.insertMany(orders);
  await Return.insertMany(returns);
  await ShipEvent.insertMany(shipLog);
  await Coupon.insertMany(coupons);
  await Review.insertMany(reviews);
  await Article.insertMany(journal);
  await CmsPage.insertMany(pages);
  await Scene.insertMany(scenes);
  await Occasion.insertMany(OCCASIONS.map((name, i) => ({ _id: name, name, order: i })));

  await Singleton.create({ _id: 'settings', data: SETTINGS });
  await Singleton.create({ _id: 'crm', data: CRM });
  await Singleton.create({ _id: 'policy', data: POLICY });
  await Singleton.create({ _id: 'featured', data: { ids: featuredIds } });
  await Singleton.create({ _id: 'counters', data: { invSeq, cnSeq } });

  // Upsert the default admin user (idempotent: preserves password if user already exists).
  const adminEmail = String(config.defaultAdmin.email).toLowerCase().trim();
  const existingAdmin = await User.findOne({ email: adminEmail });
  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(config.defaultAdmin.password, 10);
    await User.create({ email: adminEmail, passwordHash, name: 'Admin', role: 'owner' });
    console.log(`[seed] created admin ${adminEmail} (password: ${config.defaultAdmin.password})`);
  } else {
    console.log(`[seed] admin ${adminEmail} already exists — password unchanged`);
  }

  console.log(`[seed] done: ${categories.length} categories, ${products.length} products, ${customers.length} customers, ${orders.length} orders, ${returns.length} returns, ${shipLog.length} ship events, ${coupons.length} coupons, ${reviews.length} reviews, ${journal.length} articles, ${pages.length} pages, ${scenes.length} scenes.`);
  await mongoose.disconnect();
}

run().catch((err) => { console.error('[seed] failed', err); process.exit(1); });
