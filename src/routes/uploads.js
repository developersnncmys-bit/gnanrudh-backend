import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '';
    const rand = crypto.randomBytes(6).toString('hex');
    cb(null, `${Date.now()}-${rand}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
  fileFilter: (req, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

export const uploadsRouter = Router();

// POST /api/uploads — accepts up to 20 files under the field name "files"
uploadsRouter.post('/', upload.array('files', 20), (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const files = (req.files || []).map((f) => ({
    url: `${origin}/uploads/${f.filename}`,
    filename: f.filename,
    name: f.originalname,
    size: f.size,
    type: f.mimetype,
  }));
  res.json({ files });
});

// DELETE /api/uploads/:filename — remove an upload (best-effort)
uploadsRouter.delete('/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const p = path.join(UPLOAD_DIR, safe);
  fs.unlink(p, (err) => {
    if (err && err.code !== 'ENOENT') return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});
