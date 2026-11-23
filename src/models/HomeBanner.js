import mongoose from 'mongoose';

// One row per homepage promotional banner. Only the Bridal Edit strip
// (CraftStory.tsx) is admin-controlled; the Explore Collections banner
// is static in the component. The editable fields are the image +
// eyebrow + title + description. CTA stays hardcoded in the component.
const HomeBannerSchema = new mongoose.Schema({
  slot: { type: String, required: true, unique: true, trim: true, enum: ['bridal'] },
  image: { type: String, default: '', trim: true },
  eyebrow: { type: String, default: '', trim: true },
  title: { type: String, default: '', trim: true },
  description: { type: String, default: '', trim: true },
}, { timestamps: true });

export const HomeBanner = mongoose.model('HomeBanner', HomeBannerSchema);
