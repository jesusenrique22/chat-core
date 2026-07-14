module.exports = {
  apps: [
    {
      name: 'chat-backend',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
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
