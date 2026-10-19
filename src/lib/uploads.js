/**
 * Subida de imágenes → bucket remoto (api-bucket).
 * El conector no guarda archivos en disco; MongoDB solo almacena la URL pública.
 */

const multer = require('multer');
const { authenticateRequest } = require('./auth');
const { MAX_IMAGE_BYTES } = require('./messageHelpers');
const {
  BUCKET_UPLOAD_URL,
  BUCKET_API_KEY,
  BUCKET_FOLDER
} = require('./env');
const logger = require('./logger');

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const BUCKET_TIMEOUT_MS = Number(process.env.BUCKET_TIMEOUT_MS) || 15000;

/** Firmas binarias: el mimetype del cliente no es confiable. */
function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 10, parts: 12 },
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
  const fileName = (originalName || 'image.jpg').replace(/[/\\\x00-\x1f]/g, '_').slice(0, 120);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), fileName);
  form.append('folder', BUCKET_FOLDER);

  let response;
  try {
    response = await fetch(BUCKET_UPLOAD_URL, {
      method: 'POST',
      headers: { 'x-api-key': BUCKET_API_KEY },
      body: form,
      signal: AbortSignal.timeout(BUCKET_TIMEOUT_MS)
    });
  } catch (networkErr) {
    const timedOut = networkErr.name === 'TimeoutError';
    const err = new Error(timedOut ? 'El bucket no respondió a tiempo' : 'No se pudo conectar al bucket');
    err.status = timedOut ? 504 : 502;
    logger.error('bucket_network_error', { error: networkErr.message });
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
    logger.error('bucket_upload_rejected', {
      status: response.status,
      body: String(data.error || data.message || raw || '').slice(0, 200)
    });
    // Un 401/403 del bucket es problema de NUESTRA credencial, no del cliente → 502
    const err = new Error(`El bucket rechazó la subida (HTTP ${response.status})`);
    err.status = 502;
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
  expressApp.post('/api/uploads/image', async (req, res) => {
    // Autenticar ANTES de leer el cuerpo: sin key válida no se bufferiza el archivo en memoria
    try {
      await authenticateRequest(req);
    } catch (authErr) {
      return res.status(authErr.status || 401).json({ success: false, error: authErr.message });
    }

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
        if (!req.file?.buffer) {
          return res.status(400).json({ error: 'Campo "image" requerido (multipart/form-data)' });
        }

        const realMime = sniffImageMime(req.file.buffer);
        if (!realMime || !ALLOWED_MIMES.has(realMime)) {
          return res.status(400).json({ error: 'El archivo no es una imagen válida (JPG, PNG, WEBP o GIF).' });
        }

        const result = await uploadBufferToBucket(req.file.buffer, {
          originalName: req.file.originalname,
          mimeType: realMime
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
        const status = uploadErr.status || 500;
        res.status(status).json({ error: status >= 500 && !uploadErr.status ? 'Error interno del servidor' : uploadErr.message });
      }
    });
  });
}

module.exports = {
  registerUploadRoutes,
  uploadBufferToBucket,
  BUCKET_FOLDER
};
