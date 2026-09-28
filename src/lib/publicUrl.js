const { getLocalNetworkIp } = require('./cors');

let resolvedPublicBase = null;

function resolvePublicBaseUrl(port) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  }
  // Railway inyecta el dominio público; se usa si no hay PUBLIC_BASE_URL
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
  if (railwayDomain) {
    const host = railwayDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${host}`;
  }
  const ip = getLocalNetworkIp();
  const p = port || process.env.PORT || 4000;
  return `http://${ip}:${p}`;
}

function initPublicBaseUrl(port) {
  resolvedPublicBase = resolvePublicBaseUrl(port);
  return resolvedPublicBase;
}

function getPublicBaseUrl() {
  return resolvedPublicBase;
}

/** Convierte http://localhost:4000/uploads/... → IP LAN para que otros en la red vean la imagen */
function rewritePublicUrl(url) {
  if (!url || !resolvedPublicBase) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      const base = new URL(resolvedPublicBase);
      u.protocol = base.protocol;
      u.hostname = base.hostname;
      u.port = base.port;
      return u.toString();
    }
  } catch {
    /* URL inválida, devolver tal cual */
  }
  return url;
}

module.exports = {
  initPublicBaseUrl,
  getPublicBaseUrl,
  rewritePublicUrl,
  resolvePublicBaseUrl
};
