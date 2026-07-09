// app.js — Vira frontend logic

// ⚠️ Замени на адрес своего задеплоенного Worker после `wrangler deploy`
const API_BASE = 'https://vira-messenger.alibahsburiev20.workers.dev';
const WS_BASE = API_BASE.replace('https://', 'wss://');

let state = {
  token: localStorage.getItem('vira_token') || null,
  user: JSON.parse(localStorage.getItem('vira_user') || 'null'),
  currentChatId: null,
  currentChatName: null,
  ws: null,
  selectedUserIds: new Set(),
};

// ---------- helpers ----------
function $(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  $(id).classList.remove('hidden');
}

function avatarColorFor(seed) {
  const colors = ['#B8D4C8', '#E8B4A0', '#C9B8D4', '#B4C7E8', '#D4C8A0'];
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % colors.length;
  return colors[Math.abs(hash) % colors.length];
}

function initials(name) {
  return name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------- splash ----------
function runSplash() {
  setTimeout(() => {
    $('splash').style.transition = 'opacity 0.4s ease';
    $('splash').style.opacity = '0';
    setTimeout(() => {
      $('splash').classList.add('hidden');
      if (state.token && state.user) {
        showScreen('chats-screen');
        loadChats();
      } else {
        showScreen('auth-screen');
      }
    }, 400);
  }, 2000);
}

// ---------- auth ----------
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    $('login-form').classList.toggle('hidden', target !== 'login');
    $('register-form').classList.toggle('hidden', target !== 'register');
  });
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('login-username').value.trim(),
        password: $('login-password').value,
      }),
    });
    persistAuth(data);
    showScreen('chats-screen');
    loadChats();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('register-error').textContent = '';
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        username: $('register-username').value.trim(),
        password: $('register-password').value,
        displayName: $('register-displayname').value.trim(),
      }),
    });
    persistAuth(data);
    showScreen('chats-screen');
    loadChats();
  } catch (err) {
    $('register-error').textContent = err.message;
  }
});

function persistAuth(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('vira_token', data.token);
  localStorage.setItem('vira_user', JSON.stringify(data.user));
}

// ---------- chats list ----------
async function loadChats() {
  try {
    const { chats } = await api('/api/chats');
    renderChats(chats);
  } catch (err) {
    console.error(err);
  }
}

function chatDisplayName(chat) {
  if (chat.type === 'group') return chat.name || 'Группа';
  const other = chat.members.find(m => m.id !== state.user.id);
  return other ? other.display_name : 'Чат';
}

function renderChats(chats) {
  const list = $('chats-list');
  list.innerHTML = '';
  $('chats-empty').classList.toggle('hidden', chats.length > 0);

  chats.forEach(chat => {
    const name = chatDisplayName(chat);
    const el = document.createElement('div');
    el.className = 'chat-item';
    el.innerHTML = `
      <div class="avatar" style="background:${avatarColorFor(chat.id)}">${initials(name)}</div>
      <div class="chat-item-body">
        <div class="chat-item-name">${escapeHtml(name)}</div>
        <div class="chat-item-preview">${chat.lastMessage ? escapeHtml(chat.lastMessage.content) : 'Нет сообщений'}</div>
      </div>
    `;
    el.addEventListener('click', () => openChat(chat.id, name));
    list.appendChild(el);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- new chat modal ----------
$('new-chat-btn').addEventListener('click', () => {
  state.selectedUserIds.clear();
  $('user-search-input').value = '';
  $('user-search-results').innerHTML = '';
  $('selected-users').classList.add('hidden');
  $('create-group-btn').classList.add('hidden');
  $('new-chat-modal').classList.remove('hidden');
});

$('close-modal-btn').addEventListener('click', () => {
  $('new-chat-modal').classList.add('hidden');
});

let searchTimeout;
$('user-search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  if (q.length < 2) { $('user-search-results').innerHTML = ''; return; }
  searchTimeout = setTimeout(async () => {
    try {
      const { users } = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      renderUserResults(users);
    } catch (err) { console.error(err); }
  }, 250);
});

function renderUserResults(users) {
  const container = $('user-search-results');
  container.innerHTML = '';
  users.forEach(u => {
    const el = document.createElement('div');
    el.className = 'user-result';
    if (state.selectedUserIds.has(u.id)) el.classList.add('selected');
    el.innerHTML = `
      <div class="avatar" style="background:${avatarColorFor(u.id)}; width:36px; height:36px; font-size:13px;">${initials(u.display_name)}</div>
      <span>${escapeHtml(u.display_name)} <span style="color:var(--text-soft)">@${escapeHtml(u.username)}</span></span>
    `;
    el.addEventListener('click', () => toggleUserSelection(u));
    container.appendChild(el);
  });
}

function toggleUserSelection(user) {
  if (state.selectedUserIds.has(user.id)) {
    state.selectedUserIds.delete(user.id);
  } else {
    state.selectedUserIds.add(user.id);
  }

  if (state.selectedUserIds.size === 0) {
    $('selected-users').classList.add('hidden');
    $('create-group-btn').classList.add('hidden');
  } else if (state.selectedUserIds.size === 1) {
    // direct chat — create immediately
    createChat('direct', [...state.selectedUserIds]);
  } else {
    $('selected-users').classList.remove('hidden');
    $('create-group-btn').classList.remove('hidden');
  }

  document.querySelectorAll('.user-result').forEach(el => el.classList.remove('selected'));
}

$('create-group-btn').addEventListener('click', () => {
  createChat('group', [...state.selectedUserIds]);
});

async function createChat(type, memberIds) {
  try {
    const { chatId } = await api('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ type, memberIds }),
    });
    $('new-chat-modal').classList.add('hidden');
    await loadChats();
    openChat(chatId, null);
  } catch (err) {
    alert(err.message);
  }
}

// ---------- chat view ----------
$('back-btn').addEventListener('click', () => {
  closeWs();
  showScreen('chats-screen');
  loadChats();
});

async function openChat(chatId, name) {
  state.currentChatId = chatId;
  state.currentChatName = name;
  $('chat-title').textContent = name || 'Чат';
  showScreen('chat-screen');
  $('messages-list').innerHTML = '';

  try {
    const { messages } = await api(`/api/chats/${chatId}/messages`);
    messages.forEach(renderMessage);
    scrollToBottom();
  } catch (err) {
    console.error(err);
  }

  connectWs(chatId);
}

function renderMessage(msg) {
  const mine = msg.sender_id === state.user.id;
  const row = document.createElement('div');
  row.className = `msg-row ${mine ? 'mine' : 'theirs'}`;
  row.dataset.msgId = msg.id;
  const time = new Date(msg.sent_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  row.innerHTML = `
    <div class="msg-bubble">
      ${!mine ? `<div class="msg-sender">${escapeHtml(msg.display_name || '')}</div>` : ''}
      <div>${escapeHtml(msg.content)}</div>
      <div class="msg-time">${time}</div>
    </div>
  `;
  $('messages-list').appendChild(row);
}

function scrollToBottom() {
  const list = $('messages-list');
  list.scrollTop = list.scrollHeight;
}

$('message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('message-input');
  const content = input.value.trim();
  if (!content || !state.currentChatId) return;
  input.value = '';
  try {
    await api(`/api/chats/${state.currentChatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    // message will also arrive via WS broadcast; render locally right away for snappy feel
  } catch (err) {
    alert(err.message);
  }
});

// ---------- websocket ----------
function connectWs(chatId) {
  closeWs();
  // Browsers can't send custom headers during WS handshake, so the token
  // travels as a query param; the Worker checks it the same way as Authorization.
  const url = `${WS_BASE}/api/chats/${chatId}/ws?token=${encodeURIComponent(state.token)}`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'message' && data.message.chatId === state.currentChatId) {
        if (document.querySelector(`[data-msg-id="${data.message.id}"]`)) return; // already rendered
        renderMessage(data.message);
        scrollToBottom();
      }
    } catch (err) { console.error(err); }
  });
}

function closeWs() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
}

// ---------- boot ----------
runSplash();
