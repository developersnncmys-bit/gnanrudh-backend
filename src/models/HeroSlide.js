import mongoose from 'mongoose';

// One slide on the storefront's homepage hero carousel. Replaces the hardcoded
// SLIDES array in components/home/Hero.tsx — each row owns its own image, copy
// and CTA so the admin can run promotional campaigns without a deploy.
const HeroSlideSchema = new mongoose.Schema({
  // Background photo (desktop + fallback). Full URL — Cloudinary or /uploads/*.
  image: { type: String, required: true, trim: true },
  // Optional art-direction crop for phones. When blank the storefront uses `image`.
  mobileImage: { type: String, default: '', trim: true },
  // Focal point override, CSS object-position syntax (e.g. "50% 25%"). Blank =
  // storefront default of "50% 25%".
  objectPosition: { type: String, default: '', trim: true },
  // Which half the text panel sits on. Alternate across slides so the carousel
  // has rhythm rather than looking like the same layout re-coloured.
  textSide: { type: String, enum: ['left', 'right'], default: 'right' },
  // Optional accent chip above the eyebrow (e.g. "Just In", "Limited").
  badgeLabel: { type: String, default: '', trim: true },
  badgeTone: { type: String, enum: ['maroon', 'gold'], default: 'gold' },
  // Small uppercase pretext above the headline (e.g. "Festive").
  eyebrow: { type: String, default: '', trim: true },
  // The big metallic-gold display heading (e.g. "New Arrivals").
  headline: { type: String, required: true, trim: true },
  // One or two sentences under the headline.
  supporting: { type: String, default: '', trim: true },
  // CTA button — label ("Shop New") and target href ("/shop?sort=new").
  ctaLabel: { type: String, default: '', trim: true },
  ctaHref: { type: String, default: '', trim: true },
  // Carousel ordering. Lower comes first.
  order: { type: Number, default: 0 },
  // Toggle a slide off without deleting it.
  visible: { type: Boolean, default: true },
}, { timestamps: true });

export const HeroSlide = mongoose.model('HeroSlide', HeroSlideSchema);
