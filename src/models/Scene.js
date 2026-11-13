import mongoose from 'mongoose';

const SceneSchema = new mongoose.Schema({
  order: { type: Number, required: true, unique: true },
  name: String,
  line: String,
}, { timestamps: true });

export const Scene = mongoose.model('Scene', SceneSchema);
