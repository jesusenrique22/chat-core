/** Marca de arranque del proceso (uptime). */

const startedAt = Date.now();

function getUptimeSec() {
  return Math.floor((Date.now() - startedAt) / 1000);
}

function getStartedAtIso() {
  return new Date(startedAt).toISOString();
}

module.exports = {
  startedAt,
  getUptimeSec,
  getStartedAtIso
};
