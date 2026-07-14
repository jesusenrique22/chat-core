/**
 * Subida de imágenes → bucket remoto (api-bucket).
 * El conector no guarda archivos en disco; MongoDB solo almacena la URL pública.
 */

const multer = require('multer');
const { authenticateRequest } = require('./integrations');
const { MAX_IMAGE_BYTES } = require('./messageHelpers');
const {
  BUCKET_UPLOAD_URL,
  BUCKET_API_KEY,
  BUCKET_FOLDER
} = require('./env');
const logger = require('./logger');

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return cb(new Error('Tipo de archivo no permitido. Use JPG, PNG, WEBP o GIF.'));
    }
    cb(null, true);
  }
});

/**
 * Reenvía el archivo al bucket y devuelve metadatos públicos.
 */
async function uploadBufferToBucket(buffer, { originalName, mimeType }) {
  const fileName = (originalName || 'image.jpg').replace(/[/\\]/g, '_');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), fileName);
  form.append('folder', BUCKET_FOLDER);

  let response;
  try {
    response = await fetch(BUCKET_UPLOAD_URL, {
      method: 'POST',
      headers: { 'x-api-key': BUCKET_API_KEY },
      body: form
    });
  } catch (networkErr) {
    const err = new Error(`No se pudo conectar al bucket: ${networkErr.message}`);
    err.status = 502;
    throw err;
  }

  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const err = new Error(
      data.error || data.message || `Bucket respondió ${response.status}`
    );
    err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw err;
  }

  if (!data.url) {
    const err = new Error('Respuesta del bucket sin URL pública');
    err.status = 502;
    throw err;
  }

  return {
    key: data.key || '',
    url: data.url,
    mimeType: data.contentType || mimeType,
    sizeBytes: Number(data.size) || buffer.length,
    fileName
  };
}

function registerUploadRoutes(expressApp) {
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

        if (!req.file?.buffer) {
          return res.status(400).json({ error: 'Campo "image" requerido (multipart/form-data)' });
        }

        const result = await uploadBufferToBucket(req.file.buffer, {
          originalName: req.file.originalname,
          mimeType: req.file.mimetype
        });

        res.status(201).json({
          success: true,
          url: result.url,
          key: result.key,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          fileName: result.fileName
        });
      } catch (uploadErr) {
        logger.error('upload_failed', { error: uploadErr.message, status: uploadErr.status });
        res.status(uploadErr.status || 500).json({ error: uploadErr.message });
      }
    });
  });
}

module.exports = {
  registerUploadRoutes,
  uploadBufferToBucket,
  BUCKET_FOLDER
};
