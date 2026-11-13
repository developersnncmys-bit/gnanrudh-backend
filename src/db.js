import mongoose from 'mongoose';
import { config } from './config.js';

mongoose.set('strictQuery', true);

export async function connectDB() {
  if (globalThis.__mongoConn) return globalThis.__mongoConn;
  if (!globalThis.__mongoConnPromise) {
    // PERF-01: bound the pool so a serverless cold-start burst doesn't open 100 sockets
    // and so a single function instance doesn't starve others on the cluster. 10 is safe
    // for a Mongo M10 (hard cap 1,500) with dozens of concurrent function instances.
    globalThis.__mongoConnPromise = mongoose.connect(config.mongoUri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    }).then((conn) => {
      globalThis.__mongoConn = conn;
      console.log(`[db] connected`);
      return conn;
    });
  }
  return globalThis.__mongoConnPromise;
}
