import mongoose from 'mongoose';

// One row per editorial banner — two slots are admin-controlled:
//   - `bridal` → the Bridal Edit strip on the homepage (CraftStory.tsx).
//   - `about`  → the hero at the top of the About page (AboutFallback).
// The Explore Collections strip stays static in PromoBanner.tsx. The
// enum here must stay in lockstep with ALLOWED_SLOTS in routes/
// homeBanners.js — a slot that passes the route check but fails the
// schema check surfaces as `Validation failed: slot: '<x>' is not a
// valid enum value for path 'slot'` on PATCH.
const HomeBannerSchema = new mongoose.Schema({
  slot: { type: String, required: true, unique: true, trim: true, enum: ['bridal', 'about'] },
  image: { type: String, default: '', trim: true },
  eyebrow: { type: String, default: '', trim: true },
  title: { type: String, default: '', trim: true },
  description: { type: String, default: '', trim: true },
}, { timestamps: true });

export const HomeBanner = mongoose.model('HomeBanner', HomeBannerSchema);
