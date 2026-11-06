const MAX_TEXT_LENGTH = 4000;
const MAX_IMAGE_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || 3 * 1024 * 1024;
/** Notas de voz sin límite de duración: solo tope de tamaño (25 MB ≈ 50 min en AAC 64 kbps). */
const MAX_AUDIO_BYTES = Number(process.env.UPLOAD_MAX_AUDIO_BYTES) || 25 * 1024 * 1024;
const MAX_FILE_BYTES = Number(process.env.UPLOAD_MAX_FILE_BYTES) || 10 * 1024 * 1024;
const MESSAGE_TYPES = new Set(['text', 'image', 'audio', 'file']);
const { rewritePublicUrl } = require('./publicUrl');

function validateMessagePayload(data) {
  const messageType = MESSAGE_TYPES.has(data?.messageType) ? data.messageType : 'text';
  const content = (data?.content || '').trim();

  if (messageType === 'text') {
    if (!content) {
      return { error: 'El contenido del mensaje es requerido' };
    }
    if (content.length > MAX_TEXT_LENGTH) {
      return { error: `El mensaje no puede superar ${MAX_TEXT_LENGTH} caracteres` };
    }
    return { messageType, content, attachment: undefined };
  }

  const attachment = data?.attachment;
  if (messageType === 'audio') {
    return validateAudioPayload(content, attachment);
  }
  if (messageType === 'file') {
    return validateFilePayload(content, attachment);
  }
  if (!attachment?.url || typeof attachment.url !== 'string') {
    return { error: 'La imagen debe subirse primero (attachment.url)' };
  }
  if (!attachment.mimeType || !String(attachment.mimeType).startsWith('image/')) {
    return { error: 'Solo se permiten imágenes' };
  }
  if (attachment.sizeBytes && attachment.sizeBytes > MAX_IMAGE_BYTES) {
    return { error: 'La imagen supera el tamaño máximo permitido' };
  }

  return {
    messageType: 'image',
    content,
    attachment: {
      url: attachment.url.trim(),
      mimeType: attachment.mimeType,
      sizeBytes: Number(attachment.sizeBytes) || 0,
      fileName: (attachment.fileName || '').trim()
    }
  };
}

function validateAudioPayload(content, attachment) {
  if (!attachment?.url || typeof attachment.url !== 'string') {
    return { error: 'La nota de voz debe subirse primero (attachment.url)' };
  }
  if (!attachment.mimeType || !String(attachment.mimeType).startsWith('audio/')) {
    return { error: 'Solo se permiten archivos de audio' };
  }
  if (attachment.sizeBytes && attachment.sizeBytes > MAX_AUDIO_BYTES) {
    return { error: 'La nota de voz supera el tamaño máximo permitido' };
  }
  const durationMs = Math.round(Number(attachment.durationMs));
  return {
    messageType: 'audio',
    content: content.slice(0, MAX_TEXT_LENGTH),
    attachment: {
      url: attachment.url.trim(),
      mimeType: attachment.mimeType,
      sizeBytes: Number(attachment.sizeBytes) || 0,
      fileName: (attachment.fileName || '').trim(),
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
    }
  };
}

function validateFilePayload(content, attachment) {
  if (!attachment?.url || typeof attachment.url !== 'string') {
    return { error: 'El documento debe subirse primero (attachment.url)' };
  }
  if (attachment.mimeType !== 'application/pdf') {
    return { error: 'Solo se permiten documentos PDF' };
  }
  if (attachment.sizeBytes && attachment.sizeBytes > MAX_FILE_BYTES) {
    return { error: 'El documento supera el tamaño máximo permitido' };
  }
  return {
    messageType: 'file',
    content: content.slice(0, MAX_TEXT_LENGTH),
    attachment: {
      url: attachment.url.trim(),
      mimeType: attachment.mimeType,
      sizeBytes: Number(attachment.sizeBytes) || 0,
      fileName: (attachment.fileName || '').trim()
    }
  };
}

function getLastMessagePreview(messageType, content) {
  if (messageType === 'image') {
    return content ? `Imagen: ${content}` : 'Imagen';
  }
  if (messageType === 'file') {
    return content ? `Documento: ${content}` : 'Documento';
  }
  if (messageType === 'audio') {
    return 'Nota de voz';
  }
  return content;
}

function toMessageData(doc, conversationId) {
  let attachment = null;
  if (doc.attachment?.url) {
    const att = doc.attachment.toObject ? doc.attachment.toObject() : { ...doc.attachment };
    attachment = { ...att, url: rewritePublicUrl(att.url) };
  }
  return {
    _id: doc._id,
    conversationId: String(conversationId),
    senderType: doc.senderType,
    messageType: doc.messageType || 'text',
    content: doc.content || '',
    attachment,
    senderName: doc.senderName || '',
    senderAvatarUrl: doc.senderAvatarUrl ? rewritePublicUrl(doc.senderAvatarUrl) : '',
    deliveryChannel: doc.deliveryChannel || 'unknown',
    direction: doc.direction || (doc.senderType === 'customer' ? 'inbound' : 'outbound'),
    externalTicketId: doc.externalTicketId || '',
    customerId: doc.customerId || '',
    timestamp: doc.timestamp,
    readByCustomerAt: doc.readByCustomerAt || null
  };
}

function mapMessagesToData(messages) {
  return messages.map((doc) => toMessageData(doc, doc.conversationId));
}

module.exports = {
  MAX_TEXT_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_AUDIO_BYTES,
  MAX_FILE_BYTES,
  validateMessagePayload,
  getLastMessagePreview,
  toMessageData,
  mapMessagesToData
};
