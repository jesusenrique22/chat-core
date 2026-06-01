const mongoose = require('mongoose');
const Platform = require('./src/models/Platform');
const Conversation = require('./src/models/Conversation');
const Message = require('./src/models/Message');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/chat_multiservicio';

async function seed() {
  try {
    await mongoose.connect(MONGODB_URI);
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
        apiKey: 'maracaibo_secret_key_2026',
        // Permitimos desarrollo en localhost en varios puertos y wildcard '*' para demostración rápida
        allowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000', '*']
      },
      {
        name: 'Sistema de Tickets',
        apiKey: 'tickets_secret_key_2026',
        allowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000', '*']
      }
    ];

    const createdPlatforms = await Platform.insertMany(testPlatforms);
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
