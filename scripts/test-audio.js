/**
 * Pruebas de notas de voz: validación del mensaje y detección del formato por firma.
 * Uso: node scripts/test-audio.js
 */
const assert = require('assert');
const { validateMessagePayload, getLastMessagePreview } = require('../src/lib/messageHelpers');
const { sniffAudioMime } = require('../src/lib/uploads');

const ok = (name) => console.log(`✔ ${name}`);

const valid = validateMessagePayload({
  messageType: 'audio',
  attachment: { url: 'https://b/x.m4a', mimeType: 'audio/mp4', sizeBytes: 1000, durationMs: 15300.4 }
});
assert.strictEqual(valid.messageType, 'audio');
assert.deepStrictEqual(valid.attachment, { url: 'https://b/x.m4a', mimeType: 'audio/mp4', sizeBytes: 1000, fileName: '', durationMs: 15300 });
ok('nota de voz válida');

assert.match(validateMessagePayload({ messageType: 'audio', attachment: {} }).error, /subirse primero/);
assert.match(validateMessagePayload({ messageType: 'audio', attachment: { url: 'u', mimeType: 'image/png' } }).error, /audio/);
assert.match(validateMessagePayload({ messageType: 'audio', attachment: { url: 'u', mimeType: 'audio/mp4', sizeBytes: 26 * 1024 * 1024 } }).error, /tamaño/);
ok('rechaza sin URL, tipo no audio y >25 MB');

assert.strictEqual(validateMessagePayload({ messageType: 'image', attachment: { url: 'u', mimeType: 'image/png' } }).messageType, 'image');
assert.strictEqual(validateMessagePayload({ messageType: 'desconocido', content: 'hola' }).messageType, 'text');
assert.strictEqual(getLastMessagePreview('audio', ''), 'Nota de voz');
ok('imágenes y texto sin cambios; vista previa "Nota de voz"');

const pad = (buf) => Buffer.concat([buf, Buffer.alloc(16)]);
assert.strictEqual(sniffAudioMime(pad(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A ')]))), 'audio/mp4');
assert.strictEqual(sniffAudioMime(pad(Buffer.from('1a45dfa3', 'hex'))), 'audio/webm');
assert.strictEqual(sniffAudioMime(pad(Buffer.from('OggS'))), 'audio/ogg');
assert.strictEqual(sniffAudioMime(pad(Buffer.from('ID3'))), 'audio/mpeg');
assert.strictEqual(sniffAudioMime(pad(Buffer.from('fff1', 'hex'))), 'audio/aac');
assert.strictEqual(sniffAudioMime(pad(Buffer.from('fffb', 'hex'))), 'audio/mpeg');
assert.strictEqual(sniffAudioMime(pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))), 'audio/wav');
assert.strictEqual(sniffAudioMime(pad(Buffer.from('89504e47', 'hex'))), null);
ok('detecta M4A, WebM, OGG, MP3, AAC y WAV; rechaza imágenes');
