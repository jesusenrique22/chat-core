/**
 * Logger JSON estructurado para PM2 / DigitalOcean.
 * Una línea JSON por evento → fácil de filtrar y alertar.
 *
 * LOG_LEVEL: error | warn | info | debug (default: info)
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel() {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] !== undefined ? LEVELS[raw] : LEVELS.info;
}

function write(level, msg, meta) {
  if (LEVELS[level] > currentLevel()) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: String(msg)
  };

  if (meta && typeof meta === 'object' && Object.keys(meta).length) {
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined) entry[key] = value;
    }
  }

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const logger = {
  error(msg, meta) {
    write('error', msg, meta);
  },
  warn(msg, meta) {
    write('warn', msg, meta);
  },
  info(msg, meta) {
    write('info', msg, meta);
  },
  debug(msg, meta) {
    write('debug', msg, meta);
  }
};

module.exports = logger;
