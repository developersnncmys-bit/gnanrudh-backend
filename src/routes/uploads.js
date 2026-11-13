// IMG-01: uploads go to Cloudinary when CLOUDINARY_URL is set (production),
// and fall back to local disk when it isn't (local dev / tests). Vercel's
// filesystem is read-only outside /tmp and wipes between invocations, so the
// Cloudinary path is mandatory in production — see QA-FIXES-REPORT.md.

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v2 as cloudinary } from 'cloudinary';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const USE_CLOUDINARY = Boolean(process.env.CLOUDINARY_URL);
if (USE_CLOUDINARY) cloudinary.config({ secure: true }); // CLOUDINARY_URL is picked up automatically

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '';
    const rand = crypto.randomBytes(6).toString('hex');
    cb(null, `${Date.now()}-${rand}${ext}`);
  },
});

// Cloudinary upload accepts a buffer, so we use memoryStorage there and stream the
// buffer into cloudinary.uploader.upload_stream.
const upload = multer({
  storage: USE_CLOUDINARY ? multer.memoryStorage() : diskStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
  fileFilter: (req, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

function uploadToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const kind = file.mimetype.startsWith('video/') ? 'video' : 'image';
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'gnanrudh', resource_type: kind },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    stream.end(file.buffer);
  });
}

export const uploadsRouter = Router();

// POST /api/uploads — accepts up to 20 files under the field name "files".
uploadsRouter.post('/', upload.array('files', 20), async (req, res, next) => {
  try {
    if (USE_CLOUDINARY) {
      const uploaded = await Promise.all((req.files || []).map(async (f) => {
        const r = await uploadToCloudinary(f);
        return {
          url: r.secure_url,
          filename: r.public_id,
          name: f.originalname,
          size: f.size,
          type: f.mimetype,
        };
      }));
      return res.json({ files: uploaded });
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    const files = (req.files || []).map((f) => ({
      url: `${origin}/uploads/${f.filename}`,
      filename: f.filename,
      name: f.originalname,
      size: f.size,
      type: f.mimetype,
    }));
    res.json({ files });
  } catch (e) { next(e); }
});

// DELETE /api/uploads/:filename — remove an upload (best-effort).
// For Cloudinary, "filename" is the public_id returned at upload time.
uploadsRouter.delete('/:filename', async (req, res, next) => {
  try {
    if (USE_CLOUDINARY) {
      await cloudinary.uploader.destroy(req.params.filename);
      return res.json({ ok: true });
    }
    const safe = path.basename(req.params.filename);
    const p = path.join(UPLOAD_DIR, safe);
    fs.unlink(p, (err) => {
      if (err && err.code !== 'ENOENT') return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  } catch (e) { next(e); }
});
