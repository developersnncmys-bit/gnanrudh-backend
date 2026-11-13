import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT) || 4000,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/house_of_gnanrudh',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:5174')
    .split(',').map((s) => s.trim()).filter(Boolean),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  // SEC-03: 12-hour access token with on-the-fly refresh when the request lands within
  // the sliding window. Shorter than a session; longer than most API keys.
  jwtExpiresIn: '12h',
  jwtRefreshThresholdSec: 60 * 60, // refresh if the token has less than 1 hour left
  defaultAdmin: {
    email: process.env.ADMIN_EMAIL || 'admin@houseofgnanrudh.com',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  },
};
