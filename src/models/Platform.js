/**
 * ============================================
 * Modelo: Platform (Plataforma)
 * ============================================
 * Registra cada plataforma externa autorizada para conectarse al chat.
 * Cada plataforma tiene:
 * - name: Nombre identificador (ej. "Servicios Maracaibo")
 * - apiKey: Clave secreta que la plataforma envía al conectarse vía Socket.io
 * - allowedOrigins: Lista de dominios/orígenes permitidos (para validación CORS)
 * 
 * La validación de seguridad se hace en dos niveles:
 * 1. CORS dinámico: solo acepta peticiones HTTP de orígenes registrados aquí.
 * 2. API Key: al conectar el socket, se valida que la clave coincida con una plataforma activa.
 */

const mongoose = require('mongoose');

const platformSchema = new mongoose.Schema({
  // Nombre legible de la plataforma (debe ser único)
  name: {
    type: String,
    required: [true, 'El nombre de la plataforma es obligatorio'],
    unique: true,
    trim: true
  },
  // Clave API secreta para autenticación de la plataforma
  apiKey: {
    type: String,
    required: [true, 'La API Key es obligatoria'],
    unique: true
  },
  // Lista de orígenes (dominios) desde los cuales esta plataforma puede conectarse
  // Ejemplo: ["http://localhost:4000", "https://serviciosmaracaibo.com"]
  allowedOrigins: {
    type: [String],
    required: [true, 'Debe especificar al menos un origen permitido'],
    validate: {
      validator: function(v) {
        return v && v.length > 0;
      },
      message: 'Debe haber al menos un origen permitido'
    }
  }
}, {
  timestamps: true // Agrega createdAt y updatedAt automáticamente
});

module.exports = mongoose.model('Platform', platformSchema);
