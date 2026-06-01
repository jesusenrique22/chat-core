"use client";

import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";

export default function ChatWidget({ apiKey, customerName, serverUrl = "http://localhost:3000" }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [isClosed, setIsClosed] = useState(false);
  const [agentTyping, setAgentTyping] = useState(false);
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const typingStopTimerRef = useRef(null);
  const typingActiveRef = useRef(false);
  const [customerId, setCustomerId] = useState(null);

  // 1. Inicializar ID de cliente persistente en localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      let storedId = localStorage.getItem("chat_multiservicio_customer_id");
      if (!storedId) {
        storedId = "cust_" + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
        localStorage.setItem("chat_multiservicio_customer_id", storedId);
      }
      setCustomerId(storedId);
    }
  }, []);

  // 2. Conectar a Socket.io cuando se abre el chat y tenemos el customerId
  useEffect(() => {
    if (!isOpen || !customerId) return;

    const socket = io(`${serverUrl}/client`, {
      auth: {
        apiKey,
        customerId,
        customerName,
      },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("🔌 Widget conectado al servidor de chat");
      
      // Unirse a la sala
      socket.emit("join_chat", (res) => {
        if (res && res.success) {
          setMessages(res.messages);
        } else {
          console.error("❌ Error en join_chat:", res?.error);
        }
      });
    });

    socket.on("user_typing", (data) => {
      if (data.senderType === "agent") {
        setAgentTyping(!!data.isTyping);
      }
    });

    socket.on("new_message", (message) => {
      if (message.senderType === "agent") setAgentTyping(false);
      setMessages((prev) => {
        if (prev.some((m) => m._id === message._id)) return prev;
        return [...prev, message];
      });
    });

    socket.on("conversation_closed", () => {
      setIsClosed(true);
    });

    return () => {
      if (socket) socket.disconnect();
    };
  }, [isOpen, customerId, apiKey, customerName, serverUrl]);

  // Auto-scroll al final al recibir mensajes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const emitClientTyping = (isTyping) => {
    if (!socketRef.current?.connected) return;
    if (typingActiveRef.current === isTyping) return;
    typingActiveRef.current = isTyping;
    socketRef.current.emit("client_typing", { isTyping });
  };

  const handleInputChange = (e) => {
    const value = e.target.value;
    setInputText(value);
    if (!value.trim()) {
      clearTimeout(typingStopTimerRef.current);
      emitClientTyping(false);
      return;
    }
    emitClientTyping(true);
    clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = setTimeout(() => emitClientTyping(false), 2000);
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!inputText.trim() || !socketRef.current || isClosed) return;

    emitClientTyping(false);
    socketRef.current.emit("send_message", { content: inputText.trim() }, (res) => {
      if (res && res.success) {
        setMessages((prev) => [...prev, res.message]);
        setInputText("");
        emitClientTyping(false);
      }
    });
  };

  // Formatear hora de los mensajes
  const formatTime = (isoString) => {
    if (!isoString) return "";
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <>
      {/* Botón Flotante */}
      <button onClick={() => setIsOpen(!isOpen)} style={styles.button}>
        <svg viewBox="0 0 24 24" style={styles.icon}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* Contenedor del Chat */}
      {isOpen && (
        <div style={styles.container}>
          <div style={styles.header}>
            <div>
              <h4 style={styles.title}>Soporte en Línea</h4>
              <span style={styles.subtitle}>Conexión Segura y Persistente</span>
            </div>
            <button onClick={() => setIsOpen(false)} style={styles.closeBtn}>&times;</button>
          </div>

          {/* Cuerpo con mensajes */}
          <div style={styles.body}>
            <div style={styles.agentBubble}>
              Hola {customerName}, ¿en qué podemos ayudarte hoy?
            </div>

            {messages.map((msg) => (
              <div
                key={msg._id || msg.timestamp}
                style={{
                  ...styles.bubble,
                  ...(msg.senderType === "agent" ? styles.agentBubble : styles.customerBubble),
                }}
              >
                {msg.content}
                <span style={styles.bubbleTime}>{formatTime(msg.timestamp)}</span>
              </div>
            ))}

            {isClosed && (
              <div style={styles.systemBubble}>
                Esta conversación ha sido cerrada por el agente.
              </div>
            )}
            {agentTyping && (
              <div style={styles.typingIndicator}>
                Agente de soporte está escribiendo…
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Formulario de envío */}
          <div style={styles.footer}>
            <form onSubmit={handleSendMessage} style={styles.form}>
              <input
                type="text"
                value={inputText}
                onChange={handleInputChange}
                placeholder="Escribe tu mensaje..."
                disabled={isClosed}
                style={styles.input}
              />
              <button type="submit" disabled={isClosed || !inputText.trim()} style={styles.sendBtn}>
                Enviar
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

// Estilos Premium Inline para evitar dependencias de frameworks CSS externos
const styles = {
  button: {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    width: "60px",
    height: "60px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)",
    boxShadow: "0 4px 16px rgba(37, 99, 235, 0.4)",
    cursor: "pointer",
    zIndex: 999999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    color: "#ffffff",
    transition: "transform 0.2s",
  },
  icon: {
    width: "28px",
    height: "28px",
  },
  container: {
    position: "fixed",
    bottom: "96px",
    right: "24px",
    width: "370px",
    height: "520px",
    borderRadius: "16px",
    backgroundColor: "#0f172a",
    border: "1px solid rgba(255, 255, 255, 0.1)",
    boxShadow: "0 10px 25px rgba(0, 0, 0, 0.5)",
    zIndex: 999998,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    color: "#f1f5f9",
  },
  header: {
    padding: "16px",
    background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
    borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    margin: 0,
    fontSize: "1rem",
    fontWeight: 600,
    color: "#ffffff",
  },
  subtitle: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    display: "block",
    marginTop: "2px",
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "1.5rem",
    lineHeight: 1,
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    backgroundColor: "#020617",
  },
  bubble: {
    maxWidth: "75%",
    padding: "10px 14px",
    borderRadius: "12px",
    fontSize: "0.88rem",
    lineHeight: "1.4",
    wordWrap: "break-word",
    display: "flex",
    flexDirection: "column",
  },
  agentBubble: {
    maxWidth: "75%",
    padding: "10px 14px",
    borderRadius: "12px",
    fontSize: "0.88rem",
    lineHeight: "1.4",
    backgroundColor: "#1e293b",
    color: "#f1f5f9",
    alignSelf: "flex-start",
    borderBottomLeftRadius: "2px",
    border: "1px solid rgba(255, 255, 255, 0.05)",
  },
  customerBubble: {
    backgroundColor: "#2563eb",
    color: "#ffffff",
    alignSelf: "flex-end",
    borderBottomRightRadius: "2px",
  },
  typingIndicator: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    fontStyle: "italic",
    padding: "4px 8px",
    alignSelf: "flex-start",
  },
  systemBubble: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    color: "#f87171",
    alignSelf: "center",
    padding: "8px 12px",
    borderRadius: "8px",
    fontSize: "0.78rem",
    border: "1px solid rgba(239, 68, 68, 0.2)",
    textAlign: "center",
    width: "90%",
  },
  bubbleTime: {
    fontSize: "0.65rem",
    marginTop: "4px",
    opacity: 0.7,
    textAlign: "right",
  },
  footer: {
    padding: "12px",
    borderTop: "1px solid rgba(255, 255, 255, 0.08)",
    backgroundColor: "#0f172a",
  },
  form: {
    display: "flex",
    gap: "8px",
  },
  input: {
    flex: 1,
    backgroundColor: "#1e293b",
    border: "1px solid rgba(255, 255, 255, 0.1)",
    borderRadius: "8px",
    padding: "10px 12px",
    color: "#ffffff",
    fontSize: "0.88rem",
    outline: "none",
  },
  sendBtn: {
    backgroundColor: "#2563eb",
    color: "#ffffff",
    border: "none",
    borderRadius: "8px",
    padding: "0 16px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.88rem",
  },
};
