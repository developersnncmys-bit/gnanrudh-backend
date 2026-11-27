import mongoose from 'mongoose';
import { config } from './config.js';

mongoose.set('strictQuery', true);

const cached = globalThis.__mongoCache ??= {
  conn: null,
  promise: null,
};

export async function connectDB() {
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose.connect(config.mongoUri, {
      maxPoolSize: 10,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 15000,
      waitQueueTimeoutMS: 5000,
      maxIdleTimeMS: 60000,
    });
  }

  try {
    cached.conn = await cached.promise;
    return cached.conn;
  } catch (error) {
    cached.conn = null;
    console.error('[MongoDB Error]', error.message);
    throw error;
  } finally {
    cached.promise = null;
  }
}