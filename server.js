/**
 * ============================================================================
 *  MINECRAFT BEDROCK AFK BOT — SERVER
 * ============================================================================
 *  Stack: Node.js + Express + Socket.io + bedrock-protocol
 *
 *  This file is the single backend entry point. It:
 *   1. Serves the static web GUI from /public
 *   2. Opens a Socket.io channel for realtime status/chat updates
 *   3. Owns the bedrock-protocol client lifecycle (connect/auth/chat/disconnect)
 *   4. Implements the "2-minute listening window" chat gating rule
 *   5. Implements the "2 MB rolling chat buffer" memory cap
 *
 *  Run:      npm install && npm start
 *  Build exe: npm run build   (see bottom of file for notes)
 * ============================================================================
 */

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const bedrock = require('bedrock-protocol');

// ---------------------------------------------------------------------------
// App / server bootstrap
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // relax CORS since this is a locally-run tool
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Constants (defaults per spec)
// ---------------------------------------------------------------------------

const DEFAULT_HOST = 'catmine.net';
const DEFAULT_PORT = 19132;

const LISTEN_WINDOW_MS = 2 * 60 * 1000;      // 2 minutes
const CHAT_BUFFER_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

// ---------------------------------------------------------------------------
// In-memory state (single bot instance; the GUI is a single-operator tool)
// ---------------------------------------------------------------------------

const state = {
  client: null,          // active bedrock-protocol client instance
  status: 'OFF',         // 'ON' | 'OFF' | 'CONNECTING'
  chatLog: [],           // rolling buffer of { from, text, ts }
  listening: false,      // whether we currently render incoming chat
  listenTimer: null,     // setTimeout handle for the 2-minute window
  config: {
    serverName: 'CatMine',
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    username: ''
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Broadcasts the current ON/OFF status to every connected browser tab. */
function broadcastStatus() {
  io.emit('status', { status: state.status });
}

/** Pushes a system/log line to the console AND the web UI's log panel. */
function log(message) {
  console.log(`[BOT] ${message}`);
  io.emit('log', { message, ts: Date.now() });
}

/**
 * Appends a chat entry to the rolling buffer, then trims the OLDEST entries
 * until the total serialized size is back under the 2 MB cap.
 */
function pushChatEntry(entry) {
  state.chatLog.push(entry);

  let size = Buffer.byteLength(JSON.stringify(state.chatLog));
  while (size > CHAT_BUFFER_MAX_BYTES && state.chatLog.length > 0) {
    state.chatLog.shift(); // drop oldest first
    size = Buffer.byteLength(JSON.stringify(state.chatLog));
  }
}

/**
 * Opens the 2-minute "listening window". While open, incoming chat packets
 * from the server are forwarded to the UI. Once the window elapses without
 * the user sending another message, incoming chat is silently ignored
 * (still nothing is stored) until the user sends another message.
 */
function openListenWindow() {
  state.listening = true;
  if (state.listenTimer) clearTimeout(state.listenTimer);
  state.listenTimer = setTimeout(() => {
    state.listening = false;
    io.emit('listenWindow', { listening: false });
  }, LISTEN_WINDOW_MS);
  io.emit('listenWindow', { listening: true, durationMs: LISTEN_WINDOW_MS });
}

// ---------------------------------------------------------------------------
// bedrock-protocol client lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates and wires up a bedrock-protocol client.
 * Supports Microsoft device-code auth: when Microsoft requires user action,
 * bedrock-protocol (via prismarine-auth) invokes `onMsaCode` with the
 * verification URL + user code, which we relay straight to the UI/console.
 */
function startBot({ serverName, host, port, username }) {
  if (state.client) {
    log('Đã có một phiên kết nối đang chạy. Hãy ngắt kết nối trước khi đăng nhập lại.');
    return;
  }

  state.config = { serverName, host, port, username };
  state.status = 'CONNECTING';
  broadcastStatus();
  log(`Đang kết nối tới ${serverName} (${host}:${port}) với tài khoản "${username}"...`);

  let client;
  try {
    client = bedrock.createClient({
      host,
      port: Number(port),
      username,
      offline: false,   // false => use real Microsoft account auth
      auth: 'microsoft', // Microsoft Device Code Flow
      version: false,    // auto-negotiate protocol version with the server

      // Called by prismarine-auth when the user must complete the
      // Microsoft OAuth device-code flow in a browser.
      onMsaCode: (data) => {
        const msg = `[ĐĂNG NHẬP MICROSOFT] Mở ${data.verification_uri} và nhập mã: ${data.user_code}`;
        console.log(msg);
        io.emit('msaCode', {
          verificationUri: data.verification_uri,
          userCode: data.user_code,
          message: msg
        });
      }
    });
  } catch (err) {
    state.status = 'OFF';
    broadcastStatus();
    log(`Lỗi khởi tạo kết nối: ${err.message}`);
    return;
  }

  state.client = client;

  // --- Lifecycle events -----------------------------------------------

  client.on('spawn', () => {
    state.status = 'ON';
    broadcastStatus();
    log('Bot đã vào server thành công và đang AFK.');
  });

  client.on('disconnect', (packet) => {
    state.status = 'OFF';
    state.client = null;
    broadcastStatus();
    log(`Bot bị ngắt kết nối: ${packet && packet.reason ? packet.reason : 'không rõ lý do'}`);
  });

  client.on('kick', (reason) => {
    state.status = 'OFF';
    state.client = null;
    broadcastStatus();
    log(`Bot bị kick khỏi server: ${JSON.stringify(reason)}`);
  });

  client.on('error', (err) => {
    log(`Lỗi kết nối: ${err.message}`);
  });

  client.on('close', () => {
    state.status = 'OFF';
    state.client = null;
    broadcastStatus();
    log('Kết nối tới server đã đóng.');
  });

  // --- Chat handling -----------------------------------------------------
  // bedrock-protocol emits the 'text' packet for chat/system messages.
  client.on('text', (packet) => {
    // Only render chat while the 2-minute listening window is open.
    if (!state.listening) return;

    const entry = {
      from: packet.source_name || 'SERVER',
      text: packet.message || '',
      ts: Date.now(),
      type: packet.type || 'raw'
    };

    pushChatEntry(entry);
    io.emit('chatMessage', entry);
  });
}

/** Gracefully tears down the active bedrock-protocol client, if any. */
function stopBot(reason = 'Người dùng yêu cầu ngắt kết nối') {
  if (state.client) {
    try {
      state.client.disconnect ? state.client.disconnect() : state.client.close();
    } catch (_) { /* ignore double-close errors */ }
    state.client = null;
  }
  state.status = 'OFF';
  broadcastStatus();
  log(reason);
}

/** Sends a chat message into the Minecraft server through the bot. */
function sendChat(text) {
  if (!state.client || state.status !== 'ON') {
    log('Không thể gửi tin nhắn: bot chưa đăng nhập vào server.');
    return;
  }

  // bedrock-protocol: queue an outbound chat text packet.
  state.client.queue('text', {
    type: 'chat',
    needs_translation: false,
    source_name: state.config.username,
    xuid: '',
    platform_chat_id: '',
    filtered_message: '',
    message: text
  });

  // Sending a message (re)opens the 2-minute listening window.
  openListenWindow();

  // Reflect the outgoing message in our own UI immediately.
  const entry = { from: `${state.config.username} (bạn)`, text, ts: Date.now(), type: 'outgoing' };
  pushChatEntry(entry);
  io.emit('chatMessage', entry);
}

// ---------------------------------------------------------------------------
// Socket.io wiring (browser <-> server)
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  // Sync new tab with current state immediately.
  socket.emit('status', { status: state.status });
  socket.emit('chatHistory', { history: state.chatLog });
  socket.emit('listenWindow', { listening: state.listening });

  socket.on('login', (payload) => {
    const serverName = (payload.serverName || 'CatMine').trim();
    const host = (payload.host || DEFAULT_HOST).trim();
    const port = Number(payload.port) || DEFAULT_PORT;
    const username = (payload.username || '').trim();

    if (!username) {
      socket.emit('log', { message: 'Vui lòng nhập tên tài khoản trước khi đăng nhập.', ts: Date.now() });
      return;
    }

    startBot({ serverName, host, port, username });
  });

  socket.on('logout', () => stopBot());

  socket.on('sendChat', (payload) => {
    const text = (payload && payload.text || '').toString().trim();
    if (text) sendChat(text);
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`✅ Máy chủ web đang chạy tại http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  stopBot('Đang tắt máy chủ...');
  process.exit(0);
});

/**
 * ----------------------------------------------------------------------
 * PACKAGING NOTES (single-file executable):
 *
 *   npm install
 *   npm run build
 *
 * This runs `pkg` (configured in package.json) and produces standalone
 * binaries in /dist for Windows, Linux, and macOS — no Node.js install
 * required on the target machine. The `public/` folder is embedded via
 * the "assets" field in package.json's "pkg" config, so the GUI ships
 * inside the single executable.
 * ----------------------------------------------------------------------
 */
