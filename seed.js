const { MONGODB_URI } = require('./src/lib/env');
const { getMongooseOptions } = require('./src/lib/mongo');
const mongoose = require('mongoose');
const Platform = require('./src/models/Platform');
const Conversation = require('./src/models/Conversation');
const Message = require('./src/models/Message');

/**
 * ⚠️ BORRA plataformas, conversaciones y mensajes. Solo para desarrollo.
 * Requiere SEED_CONFIRM=yes y se niega a correr con NODE_ENV=production.
 */
async function seed() {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ seed.js está bloqueado en producción (borra toda la base de datos).');
    process.exit(1);
  }
  if (process.env.SEED_CONFIRM !== 'yes') {
    console.error('❌ Este script BORRA plataformas, conversaciones y mensajes.');
    console.error('   Si estás seguro, ejecuta: SEED_CONFIRM=yes npm run seed');
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGODB_URI, getMongooseOptions());
    console.log('🌱 Conectado a MongoDB para inicializar datos...');

    // Limpiar colecciones previas
    await Platform.deleteMany({});
    await Conversation.deleteMany({});
    await Message.deleteMany({});
    console.log('🧹 Base de datos de chat limpia.');

    // Insertar plataformas requeridas
    const testPlatforms = [
      {
        name: 'Servicios Maracaibo',
        apiKey: process.env.MARACAIBO_API_KEY || 'maracaibo_secret_key_2026',
        allowedOrigins: [
          'http://localhost:3000',
          'http://127.0.0.1:3000',
          '*.onrender.com',
          '*.up.railway.app',
          '*'
        ]
      },
      {
        name: 'Sistema de Tickets',
        apiKey: process.env.NOTIFICATIONS_API_KEY || 'tickets_secret_key_2026',
        allowedOrigins: [
          'http://localhost:3000',
          'http://127.0.0.1:3000',
          '*.onrender.com',
          '*.up.railway.app',
          '*'
        ]
      }
    ];

    await Platform.insertMany(testPlatforms);
    const createdPlatforms = await Platform.find().select('+apiKey').lean();
    console.log('✅ Plataformas creadas correctamente en MongoDB:');
    
    createdPlatforms.forEach(p => {
      console.log(`-----------------------------------------------`);
      console.log(`Plataforma:       ${p.name}`);
      console.log(`API Key (secreta): ${p.apiKey}`);
      console.log(`Orígenes CORS:     ${p.allowedOrigins.join(', ')}`);
    });
    console.log(`-----------------------------------------------`);

    await mongoose.disconnect();
    console.log('🔌 Desconectado de MongoDB. Inicialización exitosa.');
  } catch (err) {
    console.error('❌ Error sembrando base de datos:', err);
    process.exit(1);
  }
}

seed();
