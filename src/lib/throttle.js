/**
 * Throttle por socket (p. ej. typing). Los eventos de "stop" (isTyping: false) siempre pasan.
 */
function shouldThrottleSocketEvent(socket, key, intervalMs = 2000) {
  const storageKey = `_throttle_${key}`;
  const now = Date.now();
  if (socket[storageKey] && now - socket[storageKey] < intervalMs) {
    return true;
  }
  socket[storageKey] = now;
  return false;
}

/**
 * Rate limit deslizante: máx. N eventos por ventana (p. ej. send_message).
 * @returns {boolean} true si el evento debe rechazarse
 */
function shouldRateLimitSocketEvent(socket, key, maxPerWindow = 10, windowMs = 60_000) {
  const storageKey = `_rate_${key}`;
  const now = Date.now();
  const timestamps = (socket[storageKey] || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= maxPerWindow) {
    socket[storageKey] = timestamps;
    return true;
  }
  timestamps.push(now);
  socket[storageKey] = timestamps;
  return false;
}

module.exports = { shouldThrottleSocketEvent, shouldRateLimitSocketEvent };
