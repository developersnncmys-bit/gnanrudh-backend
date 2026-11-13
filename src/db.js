import mongoose from 'mongoose';
import { config } from './config.js';

mongoose.set('strictQuery', true);

export async function connectDB() {
  if (globalThis.__mongoConn) return globalThis.__mongoConn;
  if (!globalThis.__mongoConnPromise) {
    globalThis.__mongoConnPromise = mongoose.connect(config.mongoUri).then((conn) => {
      globalThis.__mongoConn = conn;
      console.log(`[db] connected`);
      return conn;
    });
  }
  return globalThis.__mongoConnPromise;
}
