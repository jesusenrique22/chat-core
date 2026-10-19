module.exports = {
  apps: [
    {
      name: 'chat-backend',
      script: 'server.js',
      // Socket.io guarda sockets/salas en memoria del proceso: varias instancias SIN Redis
      // pierden mensajes entre procesos. Con REDIS_URL se puede escalar (clientes con
      // transports: ['websocket'] o balanceador con sticky sessions).
      instances: process.env.PM2_INSTANCES || (process.env.REDIS_URL ? 'max' : 1),
      exec_mode: process.env.PM2_EXEC_MODE || (process.env.REDIS_URL ? 'cluster' : 'fork'),
      max_memory_restart: process.env.PM2_MAX_MEMORY || '512M',

      // Reload más limpio: espera "ready" y da tiempo a cerrar WS/Mongo
      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 8000,
      shutdown_with_message: true,

      env: {
        NODE_ENV: 'production',
        PORT: 4000
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    }
  ]
};
