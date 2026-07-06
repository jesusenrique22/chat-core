const MAX_TEXT_LENGTH = 4000;
const MAX_IMAGE_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || 3 * 1024 * 1024;
const { rewritePublicUrl } = require('./publicUrl');

function validateMessagePayload(data) {
  const messageType = data?.messageType === 'image' ? 'image' : 'text';
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

function getLastMessagePreview(messageType, content) {
  if (messageType === 'image') {
    return content ? `📷 ${content}` : '📷 Imagen';
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
  validateMessagePayload,
  getLastMessagePreview,
  toMessageData,
  mapMessagesToData
};
