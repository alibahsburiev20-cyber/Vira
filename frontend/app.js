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
        startChatsAutoRefresh();
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
    startChatsAutoRefresh();
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
    startChatsAutoRefresh();
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
let chatsRefreshInterval = null;

async function loadChats() {
  try {
    const { chats } = await api('/api/chats');
    renderChats(chats);
  } catch (err) {
    console.error(err);
  }
}

function startChatsAutoRefresh() {
  stopChatsAutoRefresh();
  chatsRefreshInterval = setInterval(loadChats, 15_000);
}

function stopChatsAutoRefresh() {
  if (chatsRefreshInterval) {
    clearInterval(chatsRefreshInterval);
    chatsRefreshInterval = null;
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

  const ONLINE_THRESHOLD_MS = 30_000;
  const now = Date.now();

  chats.forEach(chat => {
    const name = chatDisplayName(chat);
    const other = chat.type === 'direct' ? chat.members.find(m => m.id !== state.user.id) : null;
    const isOnline = other && (now - other.last_seen < ONLINE_THRESHOLD_MS);

    const el = document.createElement('div');
    el.className = 'chat-item';
    el.innerHTML = `
      <div class="avatar-wrap">
        <div class="avatar" style="background:${avatarColorFor(chat.id)}">${initials(name)}</div>
        ${isOnline ? '<span class="online-dot"></span>' : ''}
      </div>
      <div class="chat-item-body">
        <div class="chat-item-name">${escapeHtml(name)}</div>
        <div class="chat-item-preview">${chat.lastMessage ? escapeHtml(chat.lastMessage.media_url && !chat.lastMessage.content ? '📷 Фото' : chat.lastMessage.content) : 'Нет сообщений'}</div>
      </div>
      ${chat.unreadCount > 0 ? `<div class="unread-badge">${chat.unreadCount > 99 ? '99+' : chat.unreadCount}</div>` : ''}
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
let newChatType = 'direct';

$('new-chat-btn').addEventListener('click', () => {
  state.selectedUserIds.clear();
  newChatType = 'direct';
  document.querySelectorAll('.chat-type-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.chat-type-tab[data-type="direct"]').classList.add('active');
  $('new-chat-name-input').classList.add('hidden');
  $('new-chat-name-input').value = '';
  $('user-search-input').value = '';
  $('user-search-results').innerHTML = '';
  $('selected-users').classList.add('hidden');
  $('selected-users').innerHTML = '';
  $('create-group-btn').classList.add('hidden');
  $('create-group-btn').textContent = 'Создать';
  $('new-chat-modal').classList.remove('hidden');
});

document.querySelectorAll('.chat-type-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.chat-type-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    newChatType = tab.dataset.type;
    $('new-chat-name-input').classList.toggle('hidden', newChatType === 'direct');
    updateCreateButtonVisibility();
  });
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
      <span>${escapeHtml(u.display_name)}${u.is_bot ? ' <span class="bot-badge">бот</span>' : ''} <span style="color:var(--text-soft)">@${escapeHtml(u.username)}</span></span>
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

  if (newChatType === 'direct' && state.selectedUserIds.size === 1) {
    createChat('direct', [...state.selectedUserIds]);
    return;
  }

  $('selected-users').classList.toggle('hidden', state.selectedUserIds.size === 0);
  updateCreateButtonVisibility();
  document.querySelectorAll('.user-result').forEach(el => el.classList.remove('selected'));
}

function updateCreateButtonVisibility() {
  const hasEnough = newChatType === 'channel' ? true : state.selectedUserIds.size >= 1;
  $('create-group-btn').classList.toggle('hidden', newChatType === 'direct' || !hasEnough);
  $('create-group-btn').textContent = newChatType === 'channel' ? 'Создать канал' : 'Создать группу';
}

$('create-group-btn').addEventListener('click', () => {
  const name = $('new-chat-name-input').value.trim();
  if (!name) { alert('Введите название'); return; }
  createChat(newChatType, [...state.selectedUserIds], name);
});

async function createChat(type, memberIds, name) {
  try {
    const { chatId } = await api('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ type, memberIds, name }),
    });
    $('new-chat-modal').classList.add('hidden');
    await loadChats();
    openChat(chatId, name || null);
  } catch (err) {
    alert(err.message);
  }
}

// ---------- chat view ----------
$('back-btn').addEventListener('click', () => {
  closeWs();
  stopTypingPing();
  showScreen('chats-screen');
  loadChats();
  startChatsAutoRefresh();
});

async function openChat(chatId, name) {
  stopChatsAutoRefresh();
  state.currentChatId = chatId;
  state.currentChatName = name;
  $('chat-title').textContent = name || 'Чат';
  $('chat-subtitle').textContent = '';
  showScreen('chat-screen');
  $('messages-list').innerHTML = '';
  $('message-form').classList.remove('hidden');
  const existingBanner = document.querySelector('.readonly-banner');
  if (existingBanner) existingBanner.remove();

  try {
    const { chat } = await api(`/api/chats/${chatId}`);
    state.currentChat = chat;
    $('chat-title').textContent = chat.type === 'direct'
      ? (chat.members.find(m => m.id !== state.user.id)?.display_name || 'Чат')
      : chat.name;

    if (chat.type === 'channel' && chat.myRole === 'member') {
      $('message-form').classList.add('hidden');
      const banner = document.createElement('div');
      banner.className = 'readonly-banner';
      banner.textContent = 'Только администраторы канала могут писать здесь';
      $('chat-screen').insertBefore(banner, null);
      $('chat-screen').appendChild(banner);
    }
  } catch (err) {
    console.error(err);
  }

  try {
    const { messages } = await api(`/api/chats/${chatId}/messages`);
    messages.forEach(renderMessage);
    scrollToBottom();
    if (messages.length > 0) {
      markAsRead(chatId, messages[messages.length - 1].id);
    }
  } catch (err) {
    console.error(err);
  }

  connectWs(chatId);
  if (state.currentChat && state.currentChat.type === 'direct') {
    refreshPresence(chatId);
  } else if (state.currentChat) {
    $('chat-subtitle').textContent = `${state.currentChat.members.length} участников`;
  }
}

async function markAsRead(chatId, messageId) {
  try {
    await api(`/api/chats/${chatId}/read`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    });
  } catch (err) { console.error(err); }
}

async function refreshPresence(chatId) {
  try {
    const { presence } = await api(`/api/chats/${chatId}/presence`);
    const other = presence.find(p => p.userId !== state.user.id);
    if (other) {
      $('chat-subtitle').textContent = other.online ? 'в сети' : 'был(а) недавно';
    }
  } catch (err) { console.error(err); }
}

function renderMessage(msg) {
  const mine = msg.sender_id === state.user.id;
  const row = document.createElement('div');
  row.className = `msg-row ${mine ? 'mine' : 'theirs'}`;
  row.dataset.msgId = msg.id;
  const time = new Date(msg.sent_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const photoHtml = msg.media_url ? `<img src="${escapeHtml(msg.media_url)}" class="msg-photo" alt="" />` : '';
  row.innerHTML = `
    <div class="msg-bubble">
      ${!mine ? `<div class="msg-sender">${escapeHtml(msg.display_name || '')}</div>` : ''}
      ${photoHtml}
      ${msg.content ? `<div>${escapeHtml(msg.content)}</div>` : ''}
      <div class="msg-time">${time}${mine ? ' <span class="read-tick">✓</span>' : ''}</div>
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
    const { message } = await api(`/api/chats/${state.currentChatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    // render locally right away for snappy feel; WS broadcast will skip it via dedupe
    renderMessage(message);
    scrollToBottom();
    markAsRead(state.currentChatId, message.id);
  } catch (err) {
    alert(err.message);
  }
});

let typingTimeout;
$('message-input').addEventListener('input', () => {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  clearTimeout(typingTimeout);
  state.ws.send(JSON.stringify({ type: 'typing' }));
  typingTimeout = setTimeout(() => {}, 2000);
});

function stopTypingPing() {
  clearTimeout(typingTimeout);
}

// ---------- websocket ----------
let typingIndicatorTimeout;

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
        markAsRead(state.currentChatId, data.message.id);
      }

      if (data.type === 'typing' && data.userId !== state.user.id) {
        $('chat-subtitle').textContent = 'печатает...';
        clearTimeout(typingIndicatorTimeout);
        typingIndicatorTimeout = setTimeout(() => refreshPresence(state.currentChatId), 2500);
      }

      if (data.type === 'read' && data.userId !== state.user.id) {
        markMessagesAsSeenInUI(data.messageId);
      }
    } catch (err) { console.error(err); }
  });
}

function markMessagesAsSeenInUI(upToMessageId) {
  // add a small "read" tick to own messages up to and including this id
  const rows = [...document.querySelectorAll('.msg-row.mine')];
  let reached = false;
  for (const row of rows) {
    const tick = row.querySelector('.read-tick');
    if (tick) tick.textContent = '✓✓';
    if (row.dataset.msgId === upToMessageId) reached = true;
  }
}

function closeWs() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
}

// ---------- my profile ----------
$('my-profile-btn').addEventListener('click', openMyProfile);
$('profile-back-btn').addEventListener('click', () => {
  stopChatsAutoRefresh();
  showScreen('chats-screen');
  loadChats();
  startChatsAutoRefresh();
});

async function openMyProfile() {
  showScreen('my-profile-screen');
  $('profile-save-status').textContent = '';
  try {
    const { user } = await api('/api/me');
    $('my-profile-avatar').style.background = avatarColorFor(user.id);
    $('my-profile-avatar').textContent = initials(user.display_name);
    $('profile-displayname-input').value = user.display_name;
    $('my-profile-username').textContent = `@${user.username}`;
    $('profile-bio-input').value = user.bio || '';
  } catch (err) { console.error(err); }
}

$('save-profile-btn').addEventListener('click', async () => {
  const displayName = $('profile-displayname-input').value.trim();
  const bio = $('profile-bio-input').value.trim();
  if (!displayName) { $('profile-save-status').textContent = 'Имя не может быть пустым'; return; }
  try {
    const { user } = await api('/api/me', {
      method: 'PUT',
      body: JSON.stringify({ displayName, bio }),
    });
    state.user.displayName = user.display_name;
    localStorage.setItem('vira_user', JSON.stringify(state.user));
    $('profile-save-status').textContent = 'Сохранено';
    setTimeout(() => { $('profile-save-status').textContent = ''; }, 2000);
  } catch (err) {
    $('profile-save-status').textContent = err.message;
  }
});

$('delete-account-btn').addEventListener('click', async () => {
  if (!confirm('Удалить аккаунт навсегда? Это действие необратимо.')) return;
  try {
    await api('/api/me', { method: 'DELETE' });
    localStorage.removeItem('vira_token');
    localStorage.removeItem('vira_user');
    location.reload();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- other user's profile ----------
$('user-profile-back-btn').addEventListener('click', () => {
  showScreen('chat-screen');
});

async function openUserProfile(userId) {
  showScreen('user-profile-screen');
  try {
    const { user } = await api(`/api/users/${userId}`);
    $('user-profile-avatar').style.background = avatarColorFor(user.id);
    $('user-profile-avatar').textContent = initials(user.display_name);
    $('user-profile-name').textContent = user.display_name;
    $('user-profile-username').textContent = `@${user.username}`;
    $('user-profile-status').textContent = user.online ? 'в сети' : 'был(а) недавно';
    $('user-profile-bio').textContent = user.bio || '';
  } catch (err) { console.error(err); }
}

// ---------- chat info (group/channel members) ----------
$('chat-info-btn').addEventListener('click', openChatInfo);
$('chat-info-back-btn').addEventListener('click', () => showScreen('chat-screen'));

async function openChatInfo() {
  if (!state.currentChatId) return;

  if (state.currentChat && state.currentChat.type === 'direct') {
    const other = state.currentChat.members.find(m => m.id !== state.user.id);
    if (other) openUserProfile(other.id);
    return;
  }

  showScreen('chat-info-screen');
  try {
    const { chat } = await api(`/api/chats/${state.currentChatId}`);
    $('chat-info-avatar').style.background = chat.avatar_color || avatarColorFor(chat.id);
    $('chat-info-avatar').textContent = initials(chat.name || 'Чат');
    $('chat-info-name').textContent = chat.name;
    $('chat-info-description').textContent = chat.description || '';

    const membersContainer = $('chat-info-members');
    membersContainer.innerHTML = '';
    chat.members.forEach(m => {
      const row = document.createElement('div');
      row.className = 'member-row';
      row.innerHTML = `
        <div class="avatar" style="background:${avatarColorFor(m.id)}; width:36px; height:36px; font-size:13px;">${initials(m.display_name)}</div>
        <span class="member-name">${escapeHtml(m.display_name)}</span>
        <span class="member-role">${m.role === 'owner' ? 'владелец' : m.role === 'admin' ? 'админ' : ''}</span>
      `;
      if (m.id !== state.user.id) {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => openUserProfile(m.id));
      }
      membersContainer.appendChild(row);
    });
  } catch (err) { console.error(err); }
}

$('leave-chat-btn').addEventListener('click', async () => {
  if (!confirm('Покинуть этот чат?')) return;
  try {
    await api(`/api/chats/${state.currentChatId}/members`, {
      method: 'DELETE',
      body: JSON.stringify({ userId: state.user.id }),
    });
    showScreen('chats-screen');
    loadChats();
    startChatsAutoRefresh();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- boot ----------
runSplash();
