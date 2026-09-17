/**
 * ============================================================================
 *  CLIENT-SIDE LOGIC — Minecraft AFK Bot GUI
 *  Handles: socket.io wiring, status badge, chat rendering, MSA login box,
 *  and mirrors the server's 2-minute listening window / 2MB buffer cap
 *  purely for DOM display purposes (server is the source of truth).
 * ============================================================================
 */

(() => {
  const socket = io();

  // --- DOM refs -------------------------------------------------------
  const statusBadge   = document.getElementById('status-badge');
  const msaBox         = document.getElementById('msa-box');
  const usernameInput  = document.getElementById('username');
  const serverNameInput= document.getElementById('server-name');
  const serverIpInput  = document.getElementById('server-ip');
  const serverPortInput= document.getElementById('server-port');
  const chatLog        = document.getElementById('chat-log');
  const chatInput      = document.getElementById('chat-input');
  const btnSend        = document.getElementById('btn-send');
  const btnLogin       = document.getElementById('btn-login');
  const listenIndicator= document.getElementById('listen-indicator');
  const logBox         = document.getElementById('log-box');

  const CHAT_BUFFER_MAX_BYTES = 2 * 1024 * 1024; // mirrors server cap

  let isConnected = false;

  // --- Rendering helpers ------------------------------------------------

  function setStatus(status) {
    statusBadge.textContent = status;
    statusBadge.className = '';
    if (status === 'ON') {
      statusBadge.classList.add('on');
      isConnected = true;
      btnLogin.textContent = 'Ngắt Kết Nối';
      btnLogin.classList.add('connected');
    } else if (status === 'CONNECTING') {
      statusBadge.classList.add('connecting');
    } else {
      isConnected = false;
      btnLogin.textContent = 'Đăng Nhập';
      btnLogin.classList.remove('connected');
    }
  }

  function trimChatDom() {
    // Enforce the 2MB DOM memory cap by dropping oldest rendered lines.
    let size = new Blob([chatLog.innerHTML]).size;
    while (size > CHAT_BUFFER_MAX_BYTES && chatLog.firstChild) {
      chatLog.removeChild(chatLog.firstChild);
      size = new Blob([chatLog.innerHTML]).size;
    }
  }

  function appendChatLine(entry) {
    const line = document.createElement('div');
    line.className = 'chat-line' + (entry.type === 'outgoing' ? ' outgoing' : '');
    const time = new Date(entry.ts).toLocaleTimeString('vi-VN');
    line.innerHTML = `<span class="from">[${time}] ${escapeHtml(entry.from)}:</span>${escapeHtml(entry.text)}`;
    chatLog.appendChild(line);
    chatLog.scrollTop = chatLog.scrollHeight;
    trimChatDom();
  }

  function appendSystemLine(message) {
    const line = document.createElement('div');
    line.className = 'chat-line system';
    line.textContent = message;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // --- Socket.io event handlers ------------------------------------------

  socket.on('status', ({ status }) => setStatus(status));

  socket.on('chatHistory', ({ history }) => {
    chatLog.innerHTML = '';
    history.forEach(appendChatLine);
  });

  socket.on('chatMessage', appendChatLine);

  socket.on('log', ({ message }) => appendSystemLine(message));

  socket.on('msaCode', ({ verificationUri, userCode }) => {
    msaBox.style.display = 'block';
    msaBox.innerHTML = `
      <strong>Yêu cầu đăng nhập Microsoft</strong><br/>
      Mở liên kết: <a href="${verificationUri}" target="_blank" rel="noopener">${verificationUri}</a><br/>
      Nhập mã: <strong>${userCode}</strong>
    `;
  });

  socket.on('listenWindow', ({ listening }) => {
    listenIndicator.classList.toggle('active', !!listening);
    listenIndicator.textContent = listening
      ? 'Cửa sổ nhận tin nhắn: đang BẬT (2 phút kể từ tin nhắn gần nhất)'
      : 'Cửa sổ nhận tin nhắn: đang tắt (gửi tin để bật trong 2 phút)';
  });

  // --- UI event handlers --------------------------------------------------

  btnLogin.addEventListener('click', () => {
    if (isConnected) {
      socket.emit('logout');
      return;
    }
    socket.emit('login', {
      serverName: serverNameInput.value,
      host: serverIpInput.value,
      port: serverPortInput.value,
      username: usernameInput.value
    });
    setStatus('CONNECTING');
    msaBox.style.display = 'none';
  });

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('sendChat', { text });
    chatInput.value = '';
  }

  btnSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
})();
