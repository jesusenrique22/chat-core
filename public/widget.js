(function () {
  // Evitar duplicación del widget
  if (window.__CHAT_WIDGET_LOADED__) return;
  window.__CHAT_WIDGET_LOADED__ = true;

  // 1. Obtener parámetros de configuración del script
  const scriptEl = document.currentScript;
  const apiKey = scriptEl.getAttribute("data-api-key");
  const customerName = scriptEl.getAttribute("data-customer-name") || "Cliente Web";
  const ticketId = scriptEl.getAttribute("data-ticket-id") || null;
  const fixedCustomerId = scriptEl.getAttribute("data-customer-id");
  const serverUrl = scriptEl.getAttribute("data-server-url") || window.location.origin;

  if (!apiKey) {
    console.error("❌ Chat Widget: La clave API (data-api-key) es obligatoria.");
    return;
  }

  // 2. Persistencia: ID fijo (data-customer-id) o localStorage
  let customerId = fixedCustomerId || localStorage.getItem("chat_multiservicio_customer_id");
  if (!customerId) {
    customerId = "cust_" + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    localStorage.setItem("chat_multiservicio_customer_id", customerId);
  } else if (fixedCustomerId) {
    localStorage.setItem("chat_multiservicio_customer_id", customerId);
  }

  // 3. Estilos CSS dinámicos (inyectados para mantener independencia total de archivos externos)
  const styleEl = document.createElement("style");
  styleEl.innerHTML = `
    /* Botón flotante del Widget */
    #chat-widget-button {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      box-shadow: 0 4px 16px rgba(37, 99, 235, 0.4);
      cursor: pointer;
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    #chat-widget-button:hover {
      transform: scale(1.08) translateY(-2px);
      box-shadow: 0 6px 20px rgba(37, 99, 235, 0.5);
    }
    #chat-widget-button svg {
      width: 28px;
      height: 28px;
      fill: none;
      stroke: #ffffff;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    
    /* Contenedor del Chat (Panel) */
    #chat-widget-container {
      position: fixed;
      bottom: 96px;
      right: 24px;
      width: 370px;
      height: 520px;
      border-radius: 16px;
      background: #0f172a;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
      z-index: 999998;
      display: none; /* Oculto inicialmente */
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #f1f5f9;
      animation: chatSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    @keyframes chatSlideIn {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    
    /* Cabecera del Panel */
    #chat-widget-header {
      padding: 16px;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    #chat-widget-header h4 {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
      color: #ffffff;
    }
    #chat-widget-header .subtitle {
      font-size: 0.75rem;
      color: #94a3b8;
      margin-top: 2px;
    }
    #chat-widget-close {
      background: transparent;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 1.2rem;
      padding: 4px;
      line-height: 1;
    }
    #chat-widget-close:hover {
      color: #ffffff;
    }
    
    /* Cuerpo del Chat (Mensajes) */
    #chat-widget-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #020617;
    }
    #chat-widget-body::-webkit-scrollbar {
      width: 4px;
    }
    #chat-widget-body::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
    }
    
    /* Burbujas de Chat */
    .chat-bubble {
      max-width: 75%;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 0.88rem;
      line-height: 1.4;
      word-wrap: break-word;
    }
    .chat-bubble.customer {
      background: #2563eb;
      color: #ffffff;
      align-self: flex-end;
      border-bottom-right-radius: 2px;
    }
    .chat-bubble.agent {
      background: #1e293b;
      color: #f1f5f9;
      align-self: flex-start;
      border-bottom-left-radius: 2px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .chat-bubble.system {
      background: rgba(239, 68, 68, 0.1);
      color: #f87171;
      align-self: center;
      max-width: 90%;
      font-size: 0.78rem;
      border: 1px solid rgba(239, 68, 68, 0.2);
      border-radius: 8px;
      text-align: center;
    }
    #chat-widget-load-older {
      align-self: center;
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #94a3b8;
      font-size: 0.75rem;
      padding: 6px 12px;
      border-radius: 999px;
      cursor: pointer;
      margin-bottom: 4px;
    }
    #chat-widget-load-older:hover {
      color: #e2e8f0;
      border-color: rgba(37, 99, 235, 0.5);
    }
    #chat-widget-load-older:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .chat-bubble-time {
      display: block;
      font-size: 0.65rem;
      margin-top: 4px;
      opacity: 0.7;
      text-align: right;
    }
    
    /* Pie de Página (Formulario de Entrada) */
    #chat-widget-footer {
      padding: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      background: #0f172a;
    }
    #chat-widget-form {
      display: flex;
      gap: 8px;
    }
    #chat-widget-input {
      flex: 1;
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 10px 12px;
      color: #ffffff;
      font-size: 0.88rem;
      outline: none;
    }
    #chat-widget-input:focus {
      border-color: #2563eb;
    }
    #chat-widget-input:disabled {
      background: #0f172a;
      color: #64748b;
      cursor: not-allowed;
    }
    #chat-widget-send {
      background: #2563eb;
      color: #ffffff;
      border: none;
      border-radius: 8px;
      padding: 0 16px;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.88rem;
      transition: background 0.2s;
    }
    #chat-widget-send:hover {
      background: #1d4ed8;
    }
    #chat-widget-send:disabled {
      background: #1e293b;
      color: #64748b;
      cursor: not-allowed;
    }
    #chat-widget-typing {
      display: none;
      padding: 0 16px 8px;
      font-size: 0.75rem;
      color: #94a3b8;
      font-style: italic;
      align-items: center;
      gap: 6px;
    }
    #chat-widget-typing.visible {
      display: flex;
    }
    #chat-widget-typing .typing-dots span {
      display: inline-block;
      width: 4px;
      height: 4px;
      margin: 0 1px;
      border-radius: 50%;
      background: #60a5fa;
      animation: typingBounce 1.2s infinite ease-in-out;
    }
    #chat-widget-typing .typing-dots span:nth-child(2) { animation-delay: 0.15s; }
    #chat-widget-typing .typing-dots span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes typingBounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-4px); opacity: 1; }
    }
    #chat-widget-attach {
      background: #1e293b;
      color: #94a3b8;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      width: 40px;
      cursor: pointer;
      font-size: 1.1rem;
      flex-shrink: 0;
    }
    #chat-widget-attach:hover { color: #fff; border-color: #2563eb; }
    .chat-image {
      width: 100%;
      max-height: 220px;
      object-fit: contain;
      display: block;
      cursor: pointer;
    }
    .chat-caption { white-space: pre-wrap; word-break: break-word; }
    .chat-bubble-image {
      padding: 0 !important;
      overflow: hidden;
      max-width: 260px;
      background: #0f172a !important;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .chat-bubble-image.customer {
      border-color: rgba(37, 99, 235, 0.35);
    }
    .chat-bubble-image.agent {
      border-color: rgba(255,255,255,0.1);
    }
    .chat-image-media {
      position: relative;
      background: #0b1220;
      line-height: 0;
    }
    .chat-image-footer {
      padding: 8px 12px 6px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .chat-image-footer .chat-caption {
      margin: 0 0 4px;
      font-size: 0.85rem;
      line-height: 1.4;
    }
    .chat-image-time-overlay {
      position: absolute;
      bottom: 6px;
      right: 6px;
      font-size: 0.62rem;
      padding: 2px 7px;
      border-radius: 6px;
      background: rgba(0,0,0,0.55);
      color: rgba(255,255,255,0.9);
    }
    .chat-bubble-image .chat-bubble-time {
      margin-top: 0;
    }
    #chat-widget-image-preview {
      display: none;
      padding: 8px 12px 0;
      align-items: center;
      gap: 10px;
    }
    #chat-widget-image-preview.visible {
      display: flex;
    }
    #chat-widget-preview-thumb {
      width: 56px;
      height: 56px;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.15);
      flex-shrink: 0;
    }
    #chat-widget-preview-info {
      flex: 1;
      min-width: 0;
      font-size: 0.78rem;
      color: #94a3b8;
      line-height: 1.35;
    }
    #chat-widget-preview-info strong {
      display: block;
      color: #e2e8f0;
      font-size: 0.82rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #chat-widget-preview-remove {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 1.25rem;
      cursor: pointer;
      padding: 4px 8px;
      line-height: 1;
    }
    #chat-widget-preview-remove:hover { color: #f87171; }
  `;
  document.head.appendChild(styleEl);

  // 4. Crear estructura HTML del Widget
  const widgetButton = document.createElement("div");
  widgetButton.id = "chat-widget-button";
  widgetButton.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    </svg>
  `;

  const widgetContainer = document.createElement("div");
  widgetContainer.id = "chat-widget-container";
  widgetContainer.innerHTML = `
    <div id="chat-widget-header">
      <div>
        <h4>Soporte en Línea</h4>
        <div class="subtitle">Sesión protegida y persistente</div>
      </div>
      <button id="chat-widget-close">&times;</button>
    </div>
    <div id="chat-widget-body">
      <div class="chat-bubble agent">
        Hola ${customerName}, ¿en qué podemos ayudarte hoy?
      </div>
    </div>
    <div id="chat-widget-typing" aria-live="polite">
      <span class="typing-dots"><span></span><span></span><span></span></span>
      <span id="chat-widget-typing-text"></span>
    </div>
    <div id="chat-widget-image-preview">
      <img id="chat-widget-preview-thumb" alt="Vista previa" />
      <div id="chat-widget-preview-info">
        <strong id="chat-widget-preview-name"></strong>
        Escribe un mensaje y pulsa Enviar
      </div>
      <button type="button" id="chat-widget-preview-remove" title="Quitar imagen">&times;</button>
    </div>
    <div id="chat-widget-footer">
      <form id="chat-widget-form">
        <input type="file" id="chat-widget-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden />
        <button type="button" id="chat-widget-attach" title="Enviar imagen">📷</button>
        <input type="text" id="chat-widget-input" placeholder="Escribe tu mensaje..." autocomplete="off" />
        <button type="submit" id="chat-widget-send">Enviar</button>
      </form>
    </div>
  `;

  document.body.appendChild(widgetButton);
  document.body.appendChild(widgetContainer);

  const chatInput = document.getElementById("chat-widget-input");
  const chatSendBtn = document.getElementById("chat-widget-send");
  const chatBody = document.getElementById("chat-widget-body");
  const chatForm = document.getElementById("chat-widget-form");
  const chatFileInput = document.getElementById("chat-widget-file");
  const chatAttachBtn = document.getElementById("chat-widget-attach");
  const imagePreviewEl = document.getElementById("chat-widget-image-preview");
  const previewThumbEl = document.getElementById("chat-widget-preview-thumb");
  const previewNameEl = document.getElementById("chat-widget-preview-name");
  const previewRemoveBtn = document.getElementById("chat-widget-preview-remove");
  const typingEl = document.getElementById("chat-widget-typing");
  const typingTextEl = document.getElementById("chat-widget-typing-text");

  let typingStopTimer = null;
  let typingActive = false;
  let pendingImageFile = null;
  let pendingImagePreviewUrl = null;
  let readDebounceTimer = null;
  let oldestMessageTs = null;
  let hasMoreOlder = false;
  let loadingOlder = false;

  function updateSendButtonState() {
    const canSend = !!(pendingImageFile || chatInput.value.trim());
    chatSendBtn.disabled = !canSend || chatInput.disabled;
  }

  function clearPendingImage() {
    if (pendingImagePreviewUrl) {
      URL.revokeObjectURL(pendingImagePreviewUrl);
    }
    pendingImageFile = null;
    pendingImagePreviewUrl = null;
    imagePreviewEl.classList.remove("visible");
    previewThumbEl.removeAttribute("src");
    previewNameEl.textContent = "";
    chatInput.placeholder = "Escribe tu mensaje...";
    updateSendButtonState();
  }

  function setPendingImage(file) {
    clearPendingImage();
    pendingImageFile = file;
    pendingImagePreviewUrl = URL.createObjectURL(file);
    previewThumbEl.src = pendingImagePreviewUrl;
    previewNameEl.textContent = file.name;
    imagePreviewEl.classList.add("visible");
    chatInput.placeholder = "Escribe un mensaje para la imagen (opcional)...";
    chatInput.focus();
    updateSendButtonState();
  }

  function emitClientTyping(isTyping) {
    if (!socket || !socket.connected) return;
    if (typingActive === isTyping) return;
    typingActive = isTyping;
    socket.emit("client_typing", { isTyping });
  }

  function onClientInputChange() {
    const hasText = chatInput.value.trim().length > 0;
    if (!hasText) {
      clearTimeout(typingStopTimer);
      emitClientTyping(false);
      return;
    }
    emitClientTyping(true);
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(() => emitClientTyping(false), 2000);
  }

  function showAgentTyping(displayName, isTyping) {
    if (!isTyping) {
      typingEl.classList.remove("visible");
      return;
    }
    typingTextEl.textContent = (displayName || "Agente") + " está escribiendo…";
    typingEl.classList.add("visible");
  }

  chatInput.addEventListener("input", () => {
    onClientInputChange();
    updateSendButtonState();
  });

  // 5. Cargar dinámicamente Socket.io y conectar
  let socket = null;

  function loadSocketScript(callback) {
    if (typeof io !== "undefined") {
      callback();
      return;
    }
    const script = document.createElement("script");
    script.src = `${serverUrl}/socket.io/socket.io.js`;
    script.onload = callback;
    script.onerror = () => console.error("❌ Error al cargar Socket.io client de: " + serverUrl);
    document.head.appendChild(script);
  }

  function scheduleMarkMessagesRead() {
    if (!socket || !socket.connected) return;
    clearTimeout(readDebounceTimer);
    readDebounceTimer = setTimeout(() => {
      if (socket && socket.connected) {
        socket.emit("mark_messages_read", {});
      }
    }, 3000);
  }

  function ensureLoadOlderButton() {
    let btn = document.getElementById("chat-widget-load-older");
    if (!hasMoreOlder) {
      if (btn) btn.remove();
      return;
    }
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "chat-widget-load-older";
      btn.textContent = "Cargar mensajes anteriores";
      btn.addEventListener("click", loadOlderMessages);
      const first = chatBody.firstChild;
      if (first) chatBody.insertBefore(btn, first);
      else chatBody.appendChild(btn);
    }
    btn.disabled = loadingOlder;
    btn.textContent = loadingOlder ? "Cargando…" : "Cargar mensajes anteriores";
  }

  function trackOldestFromMessages(messages) {
    if (!messages || !messages.length) {
      oldestMessageTs = null;
      return;
    }
    const first = messages[0];
    oldestMessageTs = first.timestamp || null;
  }

  function loadOlderMessages() {
    if (!socket || !socket.connected || !oldestMessageTs || loadingOlder) return;
    loadingOlder = true;
    ensureLoadOlderButton();
    const prevHeight = chatBody.scrollHeight;
    socket.emit("load_older_messages", { before: oldestMessageTs }, (res) => {
      loadingOlder = false;
      if (res && res.success) {
        const older = res.messages || [];
        hasMoreOlder = !!res.hasMore;
        if (older.length) {
          trackOldestFromMessages(older);
          let cursor = document.getElementById("chat-widget-load-older");
          older.forEach((msg) => {
            const bubble = buildMessageBubble(msg);
            if (!bubble) return;
            if (cursor) {
              cursor.after(bubble);
              cursor = bubble;
            } else {
              chatBody.insertBefore(bubble, chatBody.firstChild);
              cursor = bubble;
            }
          });
          chatBody.scrollTop = chatBody.scrollHeight - prevHeight;
        }
      } else {
        console.error("❌ Error cargando historial anterior:", res?.error);
      }
      ensureLoadOlderButton();
    });
  }

  function loadHistoryFromServer() {
    if (!socket || !socket.connected) return;
    socket.emit("join_chat", (res) => {
      if (res && res.success) {
        hasMoreOlder = !!res.hasMore;
        chatBody.innerHTML = `
          <div class="chat-bubble agent">
            Hola ${customerName}, ¿en qué podemos ayudarte hoy?
          </div>
        `;
        const msgs = res.messages || [];
        trackOldestFromMessages(msgs);
        ensureLoadOlderButton();
        msgs.forEach((msg) => appendMessage(msg));
        chatBody.scrollTop = chatBody.scrollHeight;
        scheduleMarkMessagesRead();
      } else {
        console.error("❌ Error al unirse a la sala de chat:", res?.error);
      }
    });
  }

  function initializeSocket() {
    // Conexión súper persistente en namespace /client
    const authPayload = { apiKey, customerId, customerName };
    if (ticketId) authPayload.ticketId = ticketId;

    socket = io(`${serverUrl}/client`, {
      auth: authPayload,
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socket.on("connect", () => {
      console.log("🔌 Conectado al servidor de chat en tiempo real");
      loadHistoryFromServer();
    });

    socket.on("user_typing", (data) => {
      if (data.senderType === "agent") {
        showAgentTyping(data.displayName, data.isTyping);
      }
    });

    socket.on("new_message", (message) => {
      showAgentTyping(null, false);
      appendMessage(message);
      if (widgetContainer.style.display === "flex" && message.senderType === "agent") {
        scheduleMarkMessagesRead();
      }
    });

    // Escuchar si el agente cierra la conversación
    socket.on("conversation_closed", () => {
      chatInput.disabled = true;
      chatSendBtn.disabled = true;
      clearPendingImage();
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble system";
      bubble.innerText = "Esta conversación ha sido cerrada por el agente de soporte.";
      chatBody.appendChild(bubble);
      chatBody.scrollTop = chatBody.scrollHeight;
    });

    socket.on("disconnect", (reason) => {
      console.warn("⚠️ Widget desconectado. Razón: " + reason);
    });
  }

  // 6. Funcionalidad de UI del Widget
  widgetButton.addEventListener("click", () => {
    const isVisible = widgetContainer.style.display === "flex";
    if (isVisible) {
      widgetContainer.style.display = "none";
    } else {
      widgetContainer.style.display = "flex";
      chatBody.scrollTop = chatBody.scrollHeight;
      
      // Inicializar conexión en el primer clic/apertura
      if (!socket) {
        loadSocketScript(() => {
          initializeSocket();
        });
      } else if (socket.connected) {
        loadHistoryFromServer();
      }
    }
  });

  document.getElementById("chat-widget-close").addEventListener("click", () => {
    widgetContainer.style.display = "none";
  });

  function emitSendMessage(payload, onSuccess) {
    if (!socket) return;
    emitClientTyping(false);
    socket.emit("send_message", payload, (res) => {
      if (res && res.success) {
        appendMessage(res.message);
        if (onSuccess) onSuccess();
      } else {
        alert("Error al enviar: " + (res?.error || "Desconocido"));
      }
    });
  }

  async function uploadImageFile(file) {
    const formData = new FormData();
    formData.append("image", file);
    const res = await fetch(`${serverUrl}/api/uploads/image`, {
      method: "POST",
      headers: { "X-Api-Key": apiKey },
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error al subir imagen");
    return data;
  }

  chatAttachBtn.addEventListener("click", () => chatFileInput.click());

  previewRemoveBtn.addEventListener("click", () => clearPendingImage());

  chatFileInput.addEventListener("change", () => {
    const file = chatFileInput.files && chatFileInput.files[0];
    chatFileInput.value = "";
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      alert("La imagen no puede superar 3 MB");
      return;
    }
    setPendingImage(file);
  });

  // Enviar mensaje del cliente (texto o imagen con caption)
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!socket) return;

    const content = chatInput.value.trim();

    if (pendingImageFile) {
      const fileBeingSent = pendingImageFile;
      try {
        chatSendBtn.disabled = true;
        chatAttachBtn.disabled = true;
        const uploaded = await uploadImageFile(fileBeingSent);
        clearPendingImage();
        emitSendMessage({
          messageType: "image",
          content,
          attachment: {
            url: uploaded.url,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
            fileName: uploaded.fileName
          }
        }, () => { chatInput.value = ""; updateSendButtonState(); });
      } catch (err) {
        alert(err.message);
        updateSendButtonState();
      } finally {
        chatAttachBtn.disabled = false;
        updateSendButtonState();
      }
      return;
    }

    if (!content) return;

    emitSendMessage({ messageType: "text", content }, () => {
      chatInput.value = "";
      updateSendButtonState();
    });
  });

  function buildMessageBubble(msg) {
    const msgId = msg._id || msg.timestamp;
    if (document.getElementById(`widget-msg-${msgId}`)) return null;

    const bubble = document.createElement("div");
    bubble.id = `widget-msg-${msgId}`;
    bubble.className = `chat-bubble ${msg.senderType === "agent" ? "agent" : "customer"}`;

    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    if (msg.messageType === "image" && msg.attachment && msg.attachment.url) {
      bubble.classList.add("chat-bubble-image");

      const media = document.createElement("div");
      media.className = "chat-image-media";

      const img = document.createElement("img");
      img.className = "chat-image";
      img.src = msg.attachment.url;
      img.alt = "Imagen adjunta";
      img.loading = "lazy";
      img.addEventListener("click", () => window.open(msg.attachment.url, "_blank"));
      media.appendChild(img);

      if (!msg.content) {
        const overlayTime = document.createElement("span");
        overlayTime.className = "chat-image-time-overlay";
        overlayTime.textContent = time;
        media.appendChild(overlayTime);
      }

      bubble.appendChild(media);

      if (msg.content) {
        const footer = document.createElement("div");
        footer.className = "chat-image-footer";

        const cap = document.createElement("div");
        cap.className = "chat-caption";
        cap.textContent = msg.content;
        footer.appendChild(cap);

        const timeEl = document.createElement("span");
        timeEl.className = "chat-bubble-time";
        timeEl.textContent = time;
        footer.appendChild(timeEl);

        bubble.appendChild(footer);
      }
    } else {
      const text = document.createElement("div");
      text.className = "chat-caption";
      text.textContent = msg.content || "";
      bubble.appendChild(text);

      const timeEl = document.createElement("span");
      timeEl.className = "chat-bubble-time";
      timeEl.textContent = time;
      bubble.appendChild(timeEl);
    }

    return bubble;
  }

  function appendMessage(msg) {
    const bubble = buildMessageBubble(msg);
    if (!bubble) return;
    chatBody.appendChild(bubble);
    chatBody.scrollTop = chatBody.scrollHeight;
  }
})();
