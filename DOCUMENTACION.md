# Documentación del Proyecto: Chat Multitrabajo Centralizado

¡Bienvenido! Este documento proporciona un desglose completo de la arquitectura de tu sistema de chat multi-servicio, explicando qué componentes están listos, qué base de datos se utiliza, qué elementos hacen falta y cómo integrar tu aplicación móvil o externa.

---

## 1. Arquitectura General del Sistema

El proyecto está diseñado bajo un modelo de **Soporte Centralizado Multi-Plataforma**. Esto significa que tienes un único servidor central que recibe conversaciones de múltiples sitios web y aplicaciones cliente, y las presenta en una sola bandeja de entrada en tiempo real para tus agentes de soporte.

```mermaid
graph TD
    subgraph Clientes Externos (Canales)
        WSM[Web Servicios Maracaibo] -->|Inyecta /widget.js| W1[Widget Flotante HTML]
        WST[Web Sistema de Tickets] -->|Inyecta /widget.js| W2[Widget Flotante HTML]
        APP[App Móvil / Desktop] -->|socket.io-client| SC[Socket Client]
    end

    subgraph Servidor Central (Express + Socket.io + Next.js)
        S_CLI[Namespace /client]
        S_AGE[Namespace /agent]
    end

    subgraph Panel de Control (Agents Dashboard)
        DASH[Dashboard de Agentes Next.js] -->|socket.io-client| S_AGE
    end

    subgraph Base de Datos
        DB[(MongoDB Local / Compass)]
    end

    W1 -->|Conexión con API Key| S_CLI
    W2 -->|Conexión con API Key| S_CLI
    SC -->|Conexión con API Key| S_CLI

    S_CLI -->|Guarda e Historial| DB
    S_AGE -->|Lee e Historial| DB
```

---

## 2. Lo Que Tienes (Componentes Listos)

Tu proyecto cuenta actualmente con una base técnica muy sólida y completa:

### A. Servidor Centralizado Híbrido (`server.js`)
* **Express & Next.js integrados:** Un único servidor web que corre en el puerto `3000` y maneja tanto la API de backend, el servidor en tiempo real (WebSockets), como el renderizado del frontend.
* **WebSockets en Tiempo Real (Socket.io):** Conexión persistente dividida en dos **Namespaces** (espacios de trabajo independientes):
  * `/client`: Para los usuarios finales que escriben desde las páginas web o la app.
  * `/agent`: Para los agentes de soporte que atienden desde el Dashboard central.
* **Recuperación Automática de Conexión:** Tiene activada la propiedad `connectionStateRecovery`, la cual permite que si un cliente pierde la señal de internet por hasta 2 minutos, no se pierdan mensajes y se reconecte automáticamente sin reiniciar el chat.

### B. Persistencia en Base de Datos (Modelos Mongoose en `/src/models/`)
Tienes tres esquemas de datos listos para guardar todo en **MongoDB**:
1. **`Platform` (Plataformas):** Registra qué apps o webs tienen permiso de conectarse. Cada plataforma tiene un `name`, una `apiKey` secreta (usada por los widgets/apps para autenticarse) y una lista de orígenes permitidos (`allowedOrigins` para CORS).
2. **`Conversation` (Conversaciones):** Agrupa los chats. Guarda el cliente (`customerName`, `customerId`), el estado (`active` o `closed`), el último mensaje para previsualizaciones rápidas y la fecha de última actualización.
3. **`Message` (Mensajes):** Almacena cada mensaje enviado. Guarda el ID de la conversación, el tipo de remitente (`customer` o `agent`), el texto del mensaje y la hora exacta (`timestamp`).

> [!NOTE]
> **Tu MongoDB descargado funcionará de forma automática.** El servidor intenta conectarse directamente a tu base de datos local en `mongodb://localhost:27017/chat_multiservicio`. Si por alguna razón tu base de datos local estuviera apagada, el sistema levanta de forma segura un **MongoDB temporal en memoria** para que el servidor nunca se caiga y puedas seguir programando.

### C. Widget de Chat Web Universal (`public/widget.js`)
* Un script de Vanilla JS ultra-ligero que se puede inyectar en **cualquier página web** usando una sola línea de código HTML.
* **Persistencia Extrema:** Genera un identificador único (UUID) para el cliente en el `localStorage` del navegador. Esto significa que si el usuario refresca la página web, cambia de sección o cierra la pestaña, al volver a abrir el chat verá todo su historial intacto.
* Renders premium con animaciones fluidas y colores configurables.

### D. Componente de Chat en React (`src/components/ChatWidget.jsx`)
* La versión React lista del widget de chat. Permite a futuros proyectos construidos en React o Next.js importar el chat de forma nativa como un componente de interfaz de usuario.

### E. Dashboard Central de Agentes (`src/app/page.js` & `src/app/page.module.css`)
* Una interfaz visual de última generación para tus agentes.
* Lista todas las conversaciones activas provenientes de cualquier origen.
* Muestra distintivos visuales de colores (ej. un badge para **Servicios Maracaibo** y otro para **Sistema de Tickets**) para saber de dónde proviene el cliente.
* Permite chatear en tiempo real y cerrar los casos resueltos.

### F. Entornos de Demostración y Pruebas
* **`public/maracaibo.html`:** Portal del ciudadano de "Servicios Maracaibo". Simula la web oficial y carga el chat inyectándole su clave correspondiente.
* **`public/tickets.html`:** Portal corporativo de tickets. Simula otro origen de chat con su propia API Key y nombre de usuario.
* **`seed.js`:** Script automatizado para limpiar y sembrar las plataformas de prueba en tu base de datos MongoDB local.

---

## 3. Persistencia en MongoDB: ¿Cómo se guardan las conversaciones?

Como ya descargaste MongoDB y tienes MongoDB Compass (como se muestra en tu captura de pantalla), las conversaciones **ya se guardan automáticamente allí**.

### ¿Cómo comprobar que se está guardando en tu MongoDB?

1. Abre tu **MongoDB Compass**.
2. Haz clic en **"Connect"** (usando la dirección por defecto `mongodb://localhost:27017`).
3. En el panel izquierdo verás que se crea una base de datos llamada **`chat_multiservicio`**.
4. Dentro de ella, tendrás tres tablas (colecciones):
   * **`platforms`**: Contiene las aplicaciones autorizadas (se creará "Servicios Maracaibo" y "Sistema de Tickets").
   * **`conversations`**: Guarda cada chat abierto. Si abres el chat desde `maracaibo.html`, verás un registro aquí.
   * **`messages`**: Almacena cada línea de chat intercambiada en tiempo real con su fecha y el emisor correspondientes.

---

## 4. Lo Que NO Tienes (Pendientes)

Aunque el ecosistema está sumamente completo, hay tres elementos principales que el proyecto no incluye de forma nativa en su código actual:

1. **El código de la App Móvil:** Tienes las páginas web de demostración y el widget web (`widget.js`), pero no hay un desarrollo móvil (como Flutter o React Native) dentro de la carpeta del proyecto.
2. **Autenticación del Agente:** El Dashboard central carga directamente en `localhost:3000` y el WebSocket de agentes `/agent` acepta conexiones de forma abierta. Para un entorno de producción, hace falta un login para los agentes.
3. **Panel de Gestión de Plataformas:** Actualmente, las plataformas autorizadas y sus API Keys se registran mediante código en el archivo `seed.js`. No tienes una pantalla visual para crear o desactivar plataformas.

---

## 5. Lo Que Hace Falta e Integración de la App (Qué debes hacer)

Para lograr tu objetivo de conectar **la Web de Servicios Maracaibo, el Dashboard y tu App** guardando todo en tu MongoDB local, debes seguir estos pasos:

### Paso 1: Levantar tu MongoDB Local y Sembrar los Datos
Asegúrate de que tu servicio de MongoDB esté iniciado en tu Mac. Luego ejecuta en la terminal de tu proyecto:
```bash
# Instala las dependencias si no lo has hecho
npm install

# Crea las plataformas iniciales en tu MongoDB local
node seed.js
```
*Este comando creará la base de datos `chat_multiservicio` en tu MongoDB local con los registros de las API Keys.*

### Paso 2: Integrar tu App Móvil (Flutter, React Native o nativa)
Para que los mensajes enviados desde la **App** también se guarden en MongoDB y aparezcan en tu Dashboard, debes hacer que tu App se conecte al servidor de chat a través de **Socket.io Client** usando el namespace `/client`.

#### ¿Cómo debe conectarse tu App? (Guía técnica)

Tanto en iOS como en Android (sea con Flutter o React Native), debes usar la librería cliente de Socket.io. Al iniciar la conexión, la App debe enviar tres parámetros obligatorios en la sección `auth`:
1. `apiKey`: La API Key correspondiente a la App (por ejemplo, puedes registrar una plataforma llamada `'App Móvil'` con su propia Key).
2. `customerId`: Un identificador único del usuario de la App (puedes usar el ID del usuario en tu base de datos de la App o generar un UUID y guardarlo en el teléfono).
3. `customerName`: El nombre del cliente para mostrarle al agente.

Aquí tienes un ejemplo de cómo se vería la conexión desde una App en **React Native**:

```javascript
import { io } from "socket.io-client";

// Reemplaza con la IP de tu Mac o tu dominio de servidor en producción
const SERVER_URL = "http://localhost:3000/client"; 

const socket = io(SERVER_URL, {
  auth: {
    apiKey: "maracaibo_secret_key_2026", // La API Key autorizada
    customerId: "app_user_99812",        // ID único persistente en el celular
    customerName: "Carlos Mendoza (App)" // Nombre del usuario
  },
  transports: ["websocket"]
});

// 1. Conectarse y unirse al chat activo para recibir el historial de MongoDB
socket.on("connect", () => {
  console.log("¡Conectado al servidor de chat!");

  socket.emit("join_chat", (response) => {
    if (response.success) {
      console.log("Historial de mensajes cargado desde MongoDB:", response.messages);
      // Aquí renderizas los mensajes en la UI de tu app
    }
  });
});

// 2. Escuchar cuando el agente responda desde el Dashboard
socket.on("new_message", (message) => {
  console.log("Nuevo mensaje recibido del Agente:", message.content);
  // Añadir mensaje a la pantalla de la app
});

// 3. Enviar un mensaje desde la App (se guardará en MongoDB automáticamente)
function enviarMensajeAlAgente(texto) {
  socket.emit("send_message", { content: texto }, (response) => {
    if (response.success) {
      console.log("Mensaje enviado con éxito y guardado en DB:", response.message);
    }
  });
}
```

---

## 6. Resumen de Flujo de Datos (Cómo viaja la información)

1. **Desde la Web o la App:** El usuario escribe un mensaje.
2. **El Servidor Central (`server.js`):** Recibe el mensaje a través del WebSocket (`/client`), lo inserta en tu base de datos local **MongoDB** (`Message.save()`) y actualiza el último mensaje de la conversación (`Conversation.findByIdAndUpdate()`).
3. **El Dashboard de Agentes:** Recibe una alerta en tiempo real a través del WebSocket (`/agent`), actualiza la lista lateral instantáneamente y, si el agente tiene ese chat abierto, renderiza la burbuja del mensaje de inmediato.
4. **Respuesta del Agente:** El agente escribe su respuesta. Viaja al servidor central, se guarda en **MongoDB**, y se emite instantáneamente de vuelta a la Web o la App del cliente a través del socket.

¡Todo el canal está perfectamente conectado en tiempo real y asegurado con persistencia de base de datos!
