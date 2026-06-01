const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { authenticateRequest } = require('./integrations');
const { MAX_IMAGE_BYTES } = require('./messageHelpers');
const { getPublicBaseUrl } = require('./publicUrl');

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function getPublicBase(req) {
  const configured = getPublicBaseUrl();
  if (configured) return configured;
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    ensureUploadDir();
    cb(null, UPLOAD_DIR);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
    cb(null, `${crypto.randomUUID()}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return cb(new Error('Tipo de archivo no permitido. Use JPG, PNG, WEBP o GIF.'));
    }
    cb(null, true);
  }
});

function registerUploadRoutes(expressApp) {
  ensureUploadDir();

  expressApp.post('/api/uploads/image', (req, res) => {
    upload.single('image')(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            error: `Imagen demasiado grande (máx ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)`
          });
        }
        return res.status(400).json({ error: err.message });
      }

      try {
        await authenticateRequest(req);

        if (!req.file) {
          return res.status(400).json({ error: 'Campo "image" requerido (multipart/form-data)' });
        }

        const base = getPublicBase(req);
        const url = `${base}/uploads/${req.file.filename}`;

        res.status(201).json({
          success: true,
          url,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
          fileName: req.file.originalname || req.file.filename
        });
      } catch (authErr) {
        if (req.file?.path && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        res.status(authErr.status || 500).json({ error: authErr.message });
      }
    });
  });
}

module.exports = {
  UPLOAD_DIR,
  registerUploadRoutes,
  getPublicBase
};
