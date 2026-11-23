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

// Cloudinary is enabled when either the discrete vars are set, or the single
// CLOUDINARY_URL env is set (SDK default). Falls back to local disk otherwise.
const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_URL } = process.env;
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'gnanrudh';
const USE_CLOUDINARY = Boolean(
  (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) || CLOUDINARY_URL,
);
if (USE_CLOUDINARY) {
  if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
    cloudinary.config({
      cloud_name: CLOUDINARY_CLOUD_NAME,
      api_key: CLOUDINARY_API_KEY,
      api_secret: CLOUDINARY_API_SECRET,
      secure: true,
    });
  } else {
    cloudinary.config({ secure: true }); // picks up CLOUDINARY_URL from env
  }
}

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '';
    const rand = crypto.randomBytes(6).toString('hex');
    cb(null, `${Date.now()}-${rand}${ext}`);
  },
});

// Per-type media size caps. Kept in step with gnanrudh-admin/src/lib/api.js
// UPLOAD_LIMITS — admin client enforces its own tighter check first; this
// is the server-side safety net for direct uploads / bypassed clients.
//   - images: 10 MB  (web product shots don't need more; Cloudinary auto-
//                     transforms downscale at delivery time anyway)
//   - videos: 100 MB (drape clips at 720p mp4; multer needs this as its
//                     single request-level ceiling)
// Multer only accepts ONE `fileSize` limit per instance, so we set it to
// the higher of the two and re-check images inside the route handler.
export const UPLOAD_LIMITS = {
  image: 10 * 1024 * 1024,
  video: 100 * 1024 * 1024,
};

const upload = multer({
  storage: USE_CLOUDINARY ? multer.memoryStorage() : diskStorage,
  limits: { fileSize: UPLOAD_LIMITS.video },
  fileFilter: (req, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

// Image files that pass multer's video-sized ceiling can still be over the
// image-specific cap. Checked after multer has parsed so `f.size` is known.
// Returns the first offender's message, or null when all files are OK.
function enforceImageCap(files) {
  for (const f of (files || [])) {
    if (f.mimetype.startsWith('image/') && f.size > UPLOAD_LIMITS.image) {
      const mb = (UPLOAD_LIMITS.image / (1024 * 1024)).toFixed(0);
      const actual = (f.size / (1024 * 1024)).toFixed(1);
      return `${f.originalname} is ${actual} MB — images must be under ${mb} MB.`;
    }
  }
  return null;
}

function uploadToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const isVideo = file.mimetype.startsWith('video/');
    const opts = { folder: CLOUDINARY_FOLDER, resource_type: isVideo ? 'video' : 'image' };
    const cb = (err, result) => (err ? reject(err) : resolve(result));
    // Videos stream through `upload_chunked_stream` with 6 MB chunks so
    // clips in the 20-100 MB range upload reliably instead of timing out
    // on a single multipart POST to Cloudinary.
    const stream = isVideo
      ? cloudinary.uploader.upload_chunked_stream({ ...opts, chunk_size: 6 * 1024 * 1024 }, cb)
      : cloudinary.uploader.upload_stream(opts, cb);
    stream.end(file.buffer);
  });
}

export const uploadsRouter = Router();

// POST /api/uploads — accepts up to 20 files under the field name "files".
// multer errors (file too large, unsupported type) surface via `next(err)`
// and land in the global errorHandler, so the client receives a 500 with
// a readable message rather than a hang.
uploadsRouter.post('/', upload.array('files', 20), async (req, res, next) => {
  try {
    const imgErr = enforceImageCap(req.files);
    if (imgErr) return res.status(413).json({ error: imgErr });
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

// Route-local error handler — translates multer's size/filter errors into
// clean 413/415 responses with human-readable messages. Without this they
// hit the global handler as 500s, and the admin's toast just says
// "Internal error" with no hint that the file was too large. Must be
// registered BEFORE the next route (Express error-handler ordering).
uploadsRouter.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const mb = (UPLOAD_LIMITS.video / (1024 * 1024)).toFixed(0);
    return res.status(413).json({
      error: `File too large. Videos must be under ${mb} MB, images under ${(UPLOAD_LIMITS.image / (1024 * 1024)).toFixed(0)} MB.`,
    });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: 'Too many files. Max 20 per upload.' });
  }
  if (err && /Unsupported file type/i.test(err.message || '')) {
    return res.status(415).json({ error: err.message });
  }
  return next(err);
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
