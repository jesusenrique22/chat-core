"use client";

import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import styles from "./page.module.css";

// Determinar dinámicamente la URL del backend central (puerto 4000)
// Usa el mismo hostname del navegador para funcionar tanto en localhost como VPN
function getBackendUrl() {
  if (typeof window === 'undefined') return 'http://localhost:4000';
  return `http://${window.location.hostname}:4000`;
}

const TICKETS_API_KEY = 'tickets_secret_key_2026';
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export default function AgentDashboard() {
  const [conversations, setConversations] = useState([]);
  const [selectedConv, setSelectedConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [typingInChat, setTypingInChat] = useState(null);
  const [typingInSidebar, setTypingInSidebar] = useState({});
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const selectedConvRef = useRef(null);
  const typingStopTimerRef = useRef(null);
  const agentTypingActiveRef = useRef(false);
  const fileInputRef = useRef(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [pendingImage, setPendingImage] = useState(null);
  selectedConvRef.current = selectedConv;

  const clearPendingImage = () => {
    setPendingImage((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
  };

  useEffect(() => {
    return () => {
      if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
    };
  }, [pendingImage]);

  // 1. Inicializar conexión Socket.io para el Agente (/agent)
  useEffect(() => {
    // Conectar al namespace de agentes en el backend central (puerto 4000)
    const backendUrl = getBackendUrl();
    const socket = io(`${backendUrl}/agent`, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("👷 Agente conectado al Socket Server");
      setIsConnected(true);
    });

    socket.on("disconnect", () => {
      console.log("👷 Agente desconectado del Socket Server");
      setIsConnected(false);
    });

    // Escucha actualizaciones globales de conversaciones
    socket.on("conversation_updated", (updatedConv) => {
      setConversations((prev) => {
        // Si la conversación fue cerrada, la removemos del listado activo
        if (updatedConv.status === "closed") {
          if (selectedConvRef.current?._id === updatedConv._id) {
            setSelectedConv(null);
            setMessages([]);
          }
          return prev.filter((c) => c._id !== updatedConv._id);
        }

        // Si ya existe en la lista, la actualizamos y la movemos arriba
        const exists = prev.some((c) => c._id === updatedConv._id);
        if (exists) {
          const filtered = prev.filter((c) => c._id !== updatedConv._id);
          return [updatedConv, ...filtered];
        }
        // Si es nueva conversación, la agregamos al tope
        return [updatedConv, ...prev];
      });
    });

    // Escucha avisos de nuevos mensajes para actualizar la previsualización del sidebar
    socket.on("conversation_message_received", ({ conversationId, lastMessage }) => {
      setConversations((prev) => {
        return prev.map((c) => {
          if (c._id === conversationId) {
            return { ...c, lastMessage, updatedAt: new Date().toISOString() };
          }
          return c;
        }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      });
    });

    // Escucha mensajes en tiempo real dentro del chat activo
    socket.on("new_message", (message) => {
      if (message.senderType === "customer") {
        setTypingInSidebar((prev) => {
          const next = { ...prev };
          delete next[message.conversationId];
          return next;
        });
        if (selectedConvRef.current?._id === message.conversationId) {
          setTypingInChat(null);
        }
      }
      // Verificar si el mensaje pertenece a la conversación actualmente abierta
      if (selectedConvRef.current && message.conversationId === selectedConvRef.current._id) {
        setMessages((prev) => {
          // Evitar mensajes duplicados por micro-reconexiones
          if (prev.some((m) => m._id === message._id)) return prev;
          return [...prev, message];
        });
      }
    });

    socket.on("user_typing", (data) => {
      if (data.senderType !== "customer") return;
      if (selectedConvRef.current?._id === data.conversationId) {
        setTypingInChat(data.isTyping ? data.displayName : null);
      }
    });

    socket.on("conversation_typing", (data) => {
      if (data.senderType !== "customer") return;
      setTypingInSidebar((prev) => {
        const next = { ...prev };
        if (data.isTyping) {
          next[data.conversationId] = data.displayName;
        } else {
          delete next[data.conversationId];
        }
        return next;
      });
    });

    // Escucha si una conversación se cerró remotamente
    socket.on("conversation_closed", ({ conversationId }) => {
      if (selectedConvRef.current?._id === conversationId) {
        setSelectedConv(null);
        setMessages([]);
        alert("Esta conversación ha sido cerrada.");
      }
      setConversations((prev) => prev.filter((c) => c._id !== conversationId));
    });

    // Cargar conversaciones activas iniciales mediante REST API
    fetchConversations();

    return () => {
      if (socket) socket.disconnect();
    };
  }, []);

  // Hacer scroll automático al final cuando hay nuevos mensajes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Cargar conversaciones activas de la API
  const fetchConversations = async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/conversations`);
      if (res.ok) {
        const data = await res.json();
        setConversations(data);
      }
    } catch (err) {
      console.error("Error cargando conversaciones:", err);
    }
  };

  const emitAgentTyping = (conversationId, isTyping) => {
    if (!socketRef.current || !conversationId) return;
    if (agentTypingActiveRef.current === isTyping) return;
    agentTypingActiveRef.current = isTyping;
    socketRef.current.emit("agent_typing", { conversationId, isTyping });
  };

  const handleInputChange = (e) => {
    const value = e.target.value;
    setInputText(value);
    if (!selectedConv) return;
    const convId = selectedConv._id;
    if (!value.trim()) {
      clearTimeout(typingStopTimerRef.current);
      emitAgentTyping(convId, false);
      return;
    }
    emitAgentTyping(convId, true);
    clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = setTimeout(() => emitAgentTyping(convId, false), 2000);
  };

  // Seleccionar conversación e ingresar a la sala del socket
  const handleSelectConversation = async (conv) => {
    clearPendingImage();
    setSelectedConv(conv);
    setTypingInChat(null);
    agentTypingActiveRef.current = false;
    
    // Unirse a la sala de socket para esta conversación
    if (socketRef.current) {
      socketRef.current.emit("agent_join", { conversationId: conv._id });
    }

    // Cargar historial de mensajes de la API
    try {
      const res = await fetch(`${getBackendUrl()}/api/conversations/${conv._id}/messages`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data);
      }
    } catch (err) {
      console.error("Error cargando historial de mensajes:", err);
    }
  };

  // Enviar mensaje del agente (texto o imagen con caption)
  const uploadImageFile = async (file) => {
    const formData = new FormData();
    formData.append("image", file);
    const res = await fetch(`${getBackendUrl()}/api/uploads/image`, {
      method: "POST",
      headers: { "X-Api-Key": TICKETS_API_KEY },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error al subir imagen");
    return data;
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!selectedConv || !socketRef.current) return;

    const content = inputText.trim();
    if (!pendingImage && !content) return;

    emitAgentTyping(selectedConv._id, false);

    if (pendingImage) {
      try {
        setUploadingImage(true);
        const uploaded = await uploadImageFile(pendingImage.file);
        clearPendingImage();

        socketRef.current.emit(
          "agent_send_message",
          {
            conversationId: selectedConv._id,
            messageType: "image",
            content,
            attachment: {
              url: uploaded.url,
              mimeType: uploaded.mimeType,
              sizeBytes: uploaded.sizeBytes,
              fileName: uploaded.fileName,
            },
          },
          (response) => {
            if (response && response.success) {
              setInputText("");
            } else {
              alert("Error al enviar imagen: " + (response?.error || "Desconocido"));
            }
          }
        );
      } catch (err) {
        alert(err.message);
      } finally {
        setUploadingImage(false);
      }
      return;
    }

    socketRef.current.emit(
      "agent_send_message",
      {
        conversationId: selectedConv._id,
        messageType: "text",
        content,
      },
      (response) => {
        if (response && response.success) {
          setInputText("");
          emitAgentTyping(selectedConv._id, false);
        } else {
          console.error("Error enviando mensaje:", response?.error);
        }
      }
    );
  };

  const handleImageSelect = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      alert("La imagen no puede superar 3 MB");
      return;
    }
    setPendingImage((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return {
        file,
        previewUrl: URL.createObjectURL(file),
        fileName: file.name,
      };
    });
  };

  // Cerrar/Resolver conversación
  const handleCloseConversation = () => {
    if (!selectedConv || !socketRef.current) return;
    if (!confirm(`¿Estás seguro de que deseas cerrar la conversación de ${selectedConv.customerName}?`)) return;

    socketRef.current.emit("close_conversation", { conversationId: selectedConv._id }, (response) => {
      if (response && response.success) {
        setSelectedConv(null);
        setMessages([]);
      } else {
        console.error("Error al cerrar conversación:", response?.error);
      }
    });
  };

  // Formatear fecha para legibilidad
  const formatTime = (isoString) => {
    if (!isoString) return "";
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  // Estilo de insignia según la plataforma
  const getPlatformClass = (platformName) => {
    if (!platformName) return styles.platformDefault;
    const name = platformName.toLowerCase();
    if (name.includes("maracaibo")) return styles.platformMaracaibo;
    if (name.includes("tickets")) return styles.platformTickets;
    return styles.platformDefault;
  };

  return (
    <div className={styles.container}>
      {/* 1. Barra Lateral: Lista de Conversaciones Activas */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h1>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            Agente Central
          </h1>
          <div className={styles.connectionStatus}>
            <span className={`${styles.statusDot} ${isConnected ? styles.connected : styles.disconnected}`} />
            {isConnected ? "Conectado al servidor" : "Desconectado"}
          </div>
        </div>

        <div className={styles.conversationList}>
          {conversations.length === 0 ? (
            <div className={styles.emptyState}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10"/>
                <path d="M8 12h8"/>
              </svg>
              <p>No hay conversaciones activas en este momento</p>
            </div>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv._id}
                className={`${styles.convCard} ${selectedConv?._id === conv._id ? styles.active : ""}`}
                onClick={() => handleSelectConversation(conv)}
              >
                <div className={styles.convHeader}>
                  <span className={styles.customerName}>{conv.customerName}</span>
                  <span className={`${styles.platformBadge} ${getPlatformClass(conv.platformId?.name)}`}>
                    {conv.platformId?.name || "Desconocido"}
                  </span>
                </div>
                <p className={styles.lastMessage}>
                  {typingInSidebar[conv._id] ? (
                    <span className={styles.typingPreview}>
                      {typingInSidebar[conv._id]} está escribiendo…
                    </span>
                  ) : (
                    conv.lastMessage || <i>Conversación iniciada</i>
                  )}
                </p>
                <div className={styles.convFooter}>
                  <span>
                    {conv.externalTicketId ? `Ticket: ${conv.externalTicketId}` : `ID: ${conv.customerId.substring(0, 8)}...`}
                  </span>
                  <span>{formatTime(conv.updatedAt)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* 2. Área Principal: Chat Activo */}
      <main className={styles.chatPanel}>
        {selectedConv ? (
          <>
            {/* Cabecera del Chat Abierto */}
            <div className={styles.chatHeader}>
              <div className={styles.activeClientInfo}>
                <h3>{selectedConv.customerName}</h3>
                <div className={styles.activeClientMeta}>
                  <span className={`${styles.platformBadge} ${getPlatformClass(selectedConv.platformId?.name)}`}>
                    {selectedConv.platformId?.name || "Plataforma externa"}
                  </span>
                  <span className={styles.customerIdText}>
                    | Cliente ID: {selectedConv.customerId}
                    {selectedConv.externalTicketId && (
                      <> | Ticket: <strong>{selectedConv.externalTicketId}</strong></>
                    )}
                  </span>
                </div>
              </div>
              <button className={styles.closeButton} onClick={handleCloseConversation}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
                Cerrar Caso
              </button>
            </div>

            {/* Listado de Mensajes */}
            <div className={styles.messagesArea}>
              {messages.map((msg) => (
                <div
                  key={msg._id || msg.timestamp}
                  className={`${styles.messageRow} ${msg.senderType === "agent" ? styles.agent : styles.customer}`}
                >
                  <div
                    className={`${styles.bubble} ${
                      msg.messageType === "image" && msg.attachment?.url ? styles.imageBubble : ""
                    }`}
                  >
                    {msg.messageType === "image" && msg.attachment?.url ? (
                      <>
                        <div className={styles.imageBubbleMedia}>
                          <img
                            src={msg.attachment.url}
                            alt="Imagen adjunta"
                            className={styles.chatImage}
                            loading="lazy"
                            onClick={() => window.open(msg.attachment.url, "_blank")}
                          />
                          {!msg.content && (
                            <span className={styles.imageBubbleTimeOverlay}>
                              {formatTime(msg.timestamp)}
                            </span>
                          )}
                        </div>
                        {msg.content && (
                          <div className={styles.imageBubbleFooter}>
                            <p className={styles.imageBubbleCaption}>{msg.content}</p>
                            <span className={styles.imageBubbleTime}>{formatTime(msg.timestamp)}</span>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <p style={{ margin: 0 }}>{msg.content}</p>
                        <span className={styles.bubbleTime}>{formatTime(msg.timestamp)}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {typingInChat && (
                <div className={styles.typingIndicator}>
                  <span className={styles.typingDots}>
                    <span /><span /><span />
                  </span>
                  {typingInChat} está escribiendo…
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Formulario de Entrada de Mensajes */}
            <div className={styles.inputArea}>
              {pendingImage && (
                <div className={styles.imagePreviewBar}>
                  <img
                    src={pendingImage.previewUrl}
                    alt="Vista previa"
                    className={styles.previewThumb}
                  />
                  <div className={styles.previewInfo}>
                    <strong>{pendingImage.fileName}</strong>
                    <span>Escribe un mensaje y pulsa Enviar</span>
                  </div>
                  <button
                    type="button"
                    className={styles.previewRemove}
                    title="Quitar imagen"
                    onClick={clearPendingImage}
                  >
                    &times;
                  </button>
                </div>
              )}
              <form onSubmit={handleSendMessage} className={styles.inputForm}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  hidden
                  onChange={handleImageSelect}
                />
                <button
                  type="button"
                  className={styles.attachButton}
                  title="Enviar imagen"
                  disabled={uploadingImage}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploadingImage ? "…" : "📷"}
                </button>
                <input
                  type="text"
                  placeholder={
                    pendingImage
                      ? "Escribe un mensaje para la imagen (opcional)..."
                      : `Responder a ${selectedConv.customerName}...`
                  }
                  value={inputText}
                  onChange={handleInputChange}
                  className={styles.textInput}
                  autoComplete="off"
                />
                <button
                  type="submit"
                  className={styles.sendButton}
                  disabled={(!inputText.trim() && !pendingImage) || uploadingImage}
                >
                  Enviar
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: "8px" }}>
                    <line x1="22" y1="2" x2="11" y2="13"/>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className={styles.noChatSelected}>
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="2" y="2" width="20" height="20" rx="2" ry="2"/>
              <path d="M16 8H8M16 12H8M12 16H8"/>
            </svg>
            <h2>Bandeja de Entrada Centralizada</h2>
            <p>Selecciona una conversación de la izquierda para comenzar a chatear en tiempo real.</p>
          </div>
        )}
      </main>
    </div>
  );
}
