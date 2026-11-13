import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT) || 4000,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/house_of_gnanrudh',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:5174')
    .split(',').map((s) => s.trim()).filter(Boolean),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  jwtExpiresIn: '7d',
  defaultAdmin: {
    email: process.env.ADMIN_EMAIL || 'admin@houseofgnanrudh.com',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  },
};
