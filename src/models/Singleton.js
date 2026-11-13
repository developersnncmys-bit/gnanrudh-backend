import mongoose from 'mongoose';

// Singleton documents: Settings, CRM, Policy, Featured list, Counters.
// Each stored as a single document keyed by a string "key".

const SingletonSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, _id: false, minimize: false });

export const Singleton = mongoose.model('Singleton', SingletonSchema);

export const SINGLETON_KEYS = {
  settings: 'settings',
  crm: 'crm',
  policy: 'policy',
  featured: 'featured',
  counters: 'counters',
};

export async function getSingleton(key, fallback = {}) {
  const doc = await Singleton.findById(key).lean();
  return doc ? doc.data : fallback;
}

export async function setSingleton(key, data) {
  return Singleton.findByIdAndUpdate(
    key,
    { $set: { data } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
}

export async function mergeSingleton(key, patch) {
  const current = (await getSingleton(key, {})) || {};
  const next = { ...current, ...patch };
  return setSingleton(key, next);
}
