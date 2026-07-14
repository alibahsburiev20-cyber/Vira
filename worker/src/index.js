// index.js — Vira Worker API
import { hashPassword, verifyPassword, signJWT, verifyJWT, uuid } from './crypto.js';
export { ChatRoom } from './chatRoom.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function getAuthUser(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  let token = authHeader.replace('Bearer ', '');
  if (!token) {
    // WebSocket handshakes can't set custom headers, so allow token via query param
    const url = new URL(request.url);
    token = url.searchParams.get('token') || '';
  }
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  return payload; // { userId, username, iat, exp }
}

async function hashToken(token) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Sends a message into a chat "as" the given userId (used by Mama_Boss and third-party bots),
// persisting it and broadcasting over the chat's Durable Object exactly like a normal user message.
async function sendMessageAsUser(env, chatId, userId, content) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO messages (id, chat_id, sender_id, content, sent_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, chatId, userId, content, now).run();

  const sender = await env.DB.prepare(
    'SELECT display_name, avatar_color FROM users WHERE id = ?'
  ).bind(userId).first();

  const payload = {
    type: 'message',
    message: {
      id, chatId, sender_id: userId, content, media_url: null,
      sent_at: now, display_name: sender?.display_name || 'Бот', avatar_color: sender?.avatar_color || '#7A9E8E',
    },
  };

  const roomId = env.CHAT_ROOM.idFromName(chatId);
  const room = env.CHAT_ROOM.get(roomId);
  await room.fetch('https://internal/broadcast', { method: 'POST', body: JSON.stringify(payload) });
}

// Mama_Boss: a small stateful conversation for creating/managing bots, similar to @BotFather.
// State is kept minimal by re-deriving it from the `bots` table each time rather than a session store.
async function handleMamaBossMessage(env, chatId, userId, text) {
  const mamaBoss = await env.DB.prepare("SELECT id FROM users WHERE username = 'Mama_Boss'").first();
  if (!mamaBoss) return;

  const trimmed = text.trim();
  const reply = async (msg) => sendMessageAsUser(env, chatId, mamaBoss.id, msg);

  if (trimmed === '/start' || trimmed === '/help') {
    await reply(
      'Привет! Я помогу создать бота для Vira.\n\n' +
      '/newbot — создать нового бота\n' +
      '/mybots — список ваших ботов\n' +
      '/token <username бота> — показать токен ещё раз\n' +
      '/setwebhook <username бота> <url> — задать адрес сервера бота\n' +
      '/deletebot <username бота> — удалить бота'
    );
    return;
  }

  if (trimmed === '/newbot') {
    await reply('Как назвать бота? Отправьте имя в следующем сообщении (например: Напоминалка).');
    // Store a lightweight pending-state marker as a system message flag via bio field misuse is messy;
    // instead we use a simple convention: the next non-command message from this user is treated as
    // a bot name IF their last received message from Mama_Boss was this prompt. We check that here:
    await env.DB.prepare(
      `UPDATE chat_members SET last_read_message_id = 'PENDING_BOT_NAME' WHERE chat_id = ? AND user_id = ?`
    ).bind(chatId, userId).run();
    return;
  }

  if (trimmed === '/mybots') {
    const { results } = await env.DB.prepare(
      `SELECT u.username, u.display_name FROM bots b JOIN users u ON u.id = b.user_id
       WHERE b.owner_user_id = ?`
    ).bind(userId).all();
    if (results.length === 0) {
      await reply('У вас пока нет ботов. Отправьте /newbot, чтобы создать первого.');
    } else {
      await reply('Ваши боты:\n' + results.map(b => `@${b.username} (${b.display_name})`).join('\n'));
    }
    return;
  }

  if (trimmed.startsWith('/token ')) {
    const botUsername = trimmed.slice(7).trim().replace(/^@/, '');
    const bot = await env.DB.prepare(
      `SELECT b.id FROM bots b JOIN users u ON u.id = b.user_id
       WHERE u.username = ? AND b.owner_user_id = ?`
    ).bind(botUsername, userId).first();
    if (!bot) { await reply('Бот не найден или принадлежит не вам.'); return; }
    await reply(
      'Токен нельзя показать повторно из соображений безопасности — он показывается только один раз ' +
      'при создании бота. Если вы его потеряли, удалите бота (/deletebot) и создайте нового.'
    );
    return;
  }

  if (trimmed.startsWith('/setwebhook ')) {
    const parts = trimmed.slice(12).trim().split(/\s+/);
    const botUsername = (parts[0] || '').replace(/^@/, '');
    const webhookUrl = parts[1];
    if (!botUsername || !webhookUrl) {
      await reply('Использование: /setwebhook username_бота https://ваш-сервер.com/webhook');
      return;
    }
    const bot = await env.DB.prepare(
      `SELECT b.id FROM bots b JOIN users u ON u.id = b.user_id
       WHERE u.username = ? AND b.owner_user_id = ?`
    ).bind(botUsername, userId).first();
    if (!bot) { await reply('Бот не найден или принадлежит не вам.'); return; }
    await env.DB.prepare('UPDATE bots SET webhook_url = ? WHERE id = ?').bind(webhookUrl, bot.id).run();
    await reply(`Webhook для @${botUsername} обновлён.`);
    return;
  }

  if (trimmed.startsWith('/deletebot ')) {
    const botUsername = trimmed.slice(11).trim().replace(/^@/, '');
    const bot = await env.DB.prepare(
      `SELECT b.id, b.user_id FROM bots b JOIN users u ON u.id = b.user_id
       WHERE u.username = ? AND b.owner_user_id = ?`
    ).bind(botUsername, userId).first();
    if (!bot) { await reply('Бот не найден или принадлежит не вам.'); return; }
    await env.DB.prepare('DELETE FROM bots WHERE id = ?').bind(bot.id).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(bot.user_id).run();
    await reply(`Бот @${botUsername} удалён.`);
    return;
  }

  // Check if we're mid-flow waiting for a bot name (set by /newbot above)
  const membership = await env.DB.prepare(
    'SELECT last_read_message_id FROM chat_members WHERE chat_id = ? AND user_id = ?'
  ).bind(chatId, userId).first();

  if (membership && membership.last_read_message_id === 'PENDING_BOT_NAME') {
    const displayName = trimmed.slice(0, 40);
    const suggestedUsername = displayName.replace(/[^a-zA-Z0-9_]/g, '') + '_bot';

    const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind(suggestedUsername).first();
    const finalUsername = existing ? `${suggestedUsername}${Math.floor(Math.random() * 10000)}` : suggestedUsername;

    const botUserId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, password_salt, avatar_color, created_at, last_seen, is_bot)
       VALUES (?, ?, ?, '', '', '#C9B8D4', ?, ?, 1)`
    ).bind(botUserId, finalUsername, displayName, now, now).run();

    const token = randomToken();
    const tokenHash = await hashToken(token);
    const botId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO bots (id, user_id, owner_user_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(botId, botUserId, userId, tokenHash, now).run();

    await env.DB.prepare(
      `UPDATE chat_members SET last_read_message_id = NULL WHERE chat_id = ? AND user_id = ?`
    ).bind(chatId, userId).run();

    await reply(
      `Готово! Бот @${finalUsername} создан.\n\n` +
      `Токен (сохраните его, он больше не будет показан):\n${token}\n\n` +
      `Настройте webhook командой:\n/setwebhook ${finalUsername} https://ваш-сервер.com/webhook\n\n` +
      `Ваш сервер будет получать POST-запросы с сообщениями от пользователей и должен отвечать, ` +
      `вызывая POST /api/bot/sendMessage с заголовком Authorization: Bearer <токен>.`
    );
    return;
  }

  await reply('Не понимаю эту команду. Отправьте /help, чтобы увидеть список команд.');
}

// Delivers an incoming user message to a third-party bot's webhook, if one is configured.
async function deliverToBot(env, botUserId, chatId, fromUserId, content) {
  const bot = await env.DB.prepare('SELECT webhook_url FROM bots WHERE user_id = ?').bind(botUserId).first();
  if (!bot || !bot.webhook_url) return;

  try {
    await fetch(bot.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, fromUserId, content, timestamp: Date.now() }),
    });
  } catch (err) {
    // Webhook delivery failures are non-fatal — the bot's server may be down or slow.
    console.error('Bot webhook delivery failed:', err.message);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Public media GET — no auth required (images are served by unguessable UUID key,
    // same trust model as most messenger CDN links). Must be checked before the auth gate below.
    const publicMediaGet = path.match(/^\/api\/media\/(.+)$/);
    if (publicMediaGet && request.method === 'GET') {
      if (!env.MEDIA_BUCKET) return json({ error: 'Media storage not configured' }, 501);
      const key = decodeURIComponent(publicMediaGet[1]);
      const object = await env.MEDIA_BUCKET.get(key);
      if (!object) return json({ error: 'Not found' }, 404);
      return new Response(object.body, {
        headers: {
          'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
          ...CORS_HEADERS,
        },
      });
    }

    // ---------- BOT API (separate auth: bot token, not user JWT) ----------
    if (path === '/api/bot/sendMessage' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '');
      if (!token) return json({ error: 'Missing bot token' }, 401);

      const tokenHash = await hashToken(token);
      const bot = await env.DB.prepare('SELECT user_id FROM bots WHERE token_hash = ?').bind(tokenHash).first();
      if (!bot) return json({ error: 'Invalid bot token' }, 401);

      const { chatId, content } = await request.json();
      if (!chatId || !content) return json({ error: 'chatId and content required' }, 400);

      const isMember = await env.DB.prepare(
        'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?'
      ).bind(chatId, bot.user_id).first();
      if (!isMember) return json({ error: 'Bot is not a member of this chat' }, 403);

      await sendMessageAsUser(env, chatId, bot.user_id, content.trim());
      return json({ ok: true });
    }

    try {
      // ---------- AUTH ----------
      if (path === '/api/register' && request.method === 'POST') {
        const { username, password, displayName } = await request.json();
        if (!username || !password || password.length < 6) {
          return json({ error: 'Invalid username or password (min 6 chars)' }, 400);
        }
        const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
          .bind(username).first();
        if (existing) return json({ error: 'Username already taken' }, 409);

        const { hash, salt } = await hashPassword(password);
        const id = uuid();
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO users (id, username, display_name, password_hash, password_salt, created_at, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, username, displayName || username, hash, salt, now, now).run();

        const token = await signJWT({ userId: id, username }, env.JWT_SECRET);
        return json({ token, user: { id, username, displayName: displayName || username } });
      }

      if (path === '/api/login' && request.method === 'POST') {
        const { username, password } = await request.json();
        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
          .bind(username).first();
        if (!user) return json({ error: 'Invalid credentials' }, 401);

        const valid = await verifyPassword(password, user.password_hash, user.password_salt);
        if (!valid) return json({ error: 'Invalid credentials' }, 401);

        await env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?')
          .bind(Date.now(), user.id).run();

        const token = await signJWT({ userId: user.id, username: user.username }, env.JWT_SECRET);
        return json({
          token,
          user: { id: user.id, username: user.username, displayName: user.display_name },
        });
      }

      // ---------- Everything below requires auth ----------
      const auth = await getAuthUser(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401);

      // lightweight online tracking: any authenticated request refreshes last_seen
      await env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?')
        .bind(Date.now(), auth.userId).run();

      // ---------- CHATS ----------
      if (path === '/api/chats' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT c.id, c.type, c.name, c.description, c.avatar_color, c.created_at, c.created_by,
                  cm.last_read_message_id, cm.role as my_role
           FROM chats c
           JOIN chat_members cm ON cm.chat_id = c.id
           WHERE cm.user_id = ?
           ORDER BY c.created_at DESC`
        ).bind(auth.userId).all();

        // enrich with members + last message + unread count
        const chats = [];
        for (const chat of results) {
          const { results: members } = await env.DB.prepare(
            `SELECT u.id, u.username, u.display_name, u.avatar_color, u.last_seen
             FROM chat_members cm JOIN users u ON u.id = cm.user_id
             WHERE cm.chat_id = ?`
          ).bind(chat.id).all();

          const lastMessage = await env.DB.prepare(
            `SELECT id, content, sent_at, sender_id, media_url FROM messages
             WHERE chat_id = ? AND deleted = 0
             ORDER BY sent_at DESC LIMIT 1`
          ).bind(chat.id).first();

          // unread count: messages sent after the last one this user has read, not sent by them
          let unreadCount = 0;
          const lastReadMsg = chat.last_read_message_id
            ? await env.DB.prepare('SELECT sent_at FROM messages WHERE id = ?')
                .bind(chat.last_read_message_id).first()
            : null;
          const sinceTs = lastReadMsg ? lastReadMsg.sent_at : 0;
          const unreadRow = await env.DB.prepare(
            `SELECT COUNT(*) as cnt FROM messages
             WHERE chat_id = ? AND sent_at > ? AND sender_id != ? AND deleted = 0`
          ).bind(chat.id, sinceTs, auth.userId).first();
          unreadCount = unreadRow.cnt;

          chats.push({ ...chat, members, lastMessage: lastMessage || null, unreadCount });
        }
        return json({ chats });
      }

      if (path === '/api/chats' && request.method === 'POST') {
        const { type, memberIds, name, description } = await request.json();
        if (!['direct', 'group', 'channel'].includes(type)) return json({ error: 'Invalid chat type' }, 400);
        if (type !== 'direct' && (!name || !name.trim())) {
          return json({ error: 'Название обязательно для группы или канала' }, 400);
        }
        if (!Array.isArray(memberIds)) return json({ error: 'memberIds required' }, 400);
        if (type === 'direct' && memberIds.length === 0) {
          return json({ error: 'memberIds required' }, 400);
        }

        const allMembers = [...new Set([auth.userId, ...memberIds])];

        // for direct chats, reuse existing chat if one already exists between the two users
        if (type === 'direct' && allMembers.length === 2) {
          const existing = await env.DB.prepare(
            `SELECT c.id FROM chats c
             JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = ?
             JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = ?
             WHERE c.type = 'direct'`
          ).bind(allMembers[0], allMembers[1]).first();
          if (existing) return json({ chatId: existing.id, existing: true });
        }

        const avatarPalette = ['#B8D4C8', '#E8B4A0', '#C9B8D4', '#B4C7E8', '#D4C8A0'];
        const chatId = uuid();
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO chats (id, type, name, description, avatar_color, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          chatId, type, name ? name.trim() : null, description ? description.trim() : null,
          avatarPalette[Math.floor(Math.random() * avatarPalette.length)], auth.userId, now
        ).run();

        for (const memberId of allMembers) {
          const role = memberId === auth.userId ? 'owner' : 'member';
          await env.DB.prepare(
            `INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`
          ).bind(chatId, memberId, role, now).run();
        }

        return json({ chatId, existing: false });
      }

      // ---------- PHOTO UPLOAD ----------
      const uploadMatch = path.match(/^\/api\/chats\/([^/]+)\/upload-url$/);
      if (uploadMatch && request.method === 'POST') {
        if (!env.MEDIA_BUCKET) {
          return json({ error: 'Отправка фото пока не настроена на сервере' }, 501);
        }
        const chatId = uploadMatch[1];
        const isMember = await env.DB.prepare(
          'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, auth.userId).first();
        if (!isMember) return json({ error: 'Not a member of this chat' }, 403);

        const { contentType } = await request.json();
        const key = `${chatId}/${uuid()}`;

        // R2 doesn't do presigned PUT URLs the same way S3 does via binding;
        // instead we proxy the upload through this same worker at /api/media/:key
        return json({
          uploadUrl: `${url.origin}/api/media/${encodeURIComponent(key)}`,
          publicUrl: `${url.origin}/api/media/${encodeURIComponent(key)}`,
          key,
        });
      }

      const mediaMatch = path.match(/^\/api\/media\/(.+)$/);
      if (mediaMatch && request.method === 'PUT') {
        if (!env.MEDIA_BUCKET) return json({ error: 'Media storage not configured' }, 501);
        const key = decodeURIComponent(mediaMatch[1]);
        await env.MEDIA_BUCKET.put(key, request.body, {
          httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
        });
        return json({ ok: true });
      }

      // ---------- PROFILE ----------
      if (path === '/api/me' && request.method === 'GET') {
        const user = await env.DB.prepare(
          'SELECT id, username, display_name, avatar_color, bio, created_at FROM users WHERE id = ?'
        ).bind(auth.userId).first();
        return json({ user });
      }

      if (path === '/api/me' && request.method === 'PUT') {
        const { displayName, bio, avatarColor } = await request.json();
        if (displayName !== undefined && !displayName.trim()) {
          return json({ error: 'Имя не может быть пустым' }, 400);
        }
        const updates = [];
        const binds = [];
        if (displayName !== undefined) { updates.push('display_name = ?'); binds.push(displayName.trim()); }
        if (bio !== undefined) { updates.push('bio = ?'); binds.push(bio.trim().slice(0, 200)); }
        if (avatarColor !== undefined) { updates.push('avatar_color = ?'); binds.push(avatarColor); }
        if (updates.length === 0) return json({ error: 'Nothing to update' }, 400);
        binds.push(auth.userId);

        await env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
        const user = await env.DB.prepare(
          'SELECT id, username, display_name, avatar_color, bio, created_at FROM users WHERE id = ?'
        ).bind(auth.userId).first();
        return json({ user });
      }

      if (path === '/api/me' && request.method === 'DELETE') {
        // Wipe personal data but keep message rows intact (so other chat members
        // still see history) — sender_id stays, but their user row is anonymized.
        await env.DB.prepare(
          `UPDATE users SET username = ?, display_name = 'Удалённый пользователь', bio = NULL,
                            password_hash = '', password_salt = '' WHERE id = ?`
        ).bind(`deleted_${auth.userId.slice(0, 8)}`, auth.userId).run();
        return json({ ok: true });
      }

      const userProfileMatch = path.match(/^\/api\/users\/([^/]+)$/);
      if (userProfileMatch && request.method === 'GET') {
        const targetId = userProfileMatch[1];
        const user = await env.DB.prepare(
          'SELECT id, username, display_name, avatar_color, bio, last_seen, created_at FROM users WHERE id = ?'
        ).bind(targetId).first();
        if (!user) return json({ error: 'User not found' }, 404);
        const ONLINE_THRESHOLD_MS = 30_000;
        return json({
          user: { ...user, online: Date.now() - user.last_seen < ONLINE_THRESHOLD_MS },
        });
      }

      // ---------- CHANNEL / GROUP MANAGEMENT ----------
      const membersMatch = path.match(/^\/api\/chats\/([^/]+)\/members$/);
      if (membersMatch && request.method === 'POST') {
        const chatId = membersMatch[1];
        const membership = await env.DB.prepare(
          'SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, auth.userId).first();
        if (!membership || membership.role === 'member') {
          return json({ error: 'Только владелец или администратор может добавлять участников' }, 403);
        }
        const { userIds } = await request.json();
        const now = Date.now();
        for (const uid of userIds) {
          const exists = await env.DB.prepare(
            'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?'
          ).bind(chatId, uid).first();
          if (!exists) {
            await env.DB.prepare(
              'INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
            ).bind(chatId, uid, 'member', now).run();
          }
        }
        return json({ ok: true });
      }

      if (membersMatch && request.method === 'DELETE') {
        const chatId = membersMatch[1];
        const { userId: targetUserId } = await request.json();
        const membership = await env.DB.prepare(
          'SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, auth.userId).first();

        // allow leaving yourself, or owner/admin removing someone else
        if (targetUserId !== auth.userId && (!membership || membership.role === 'member')) {
          return json({ error: 'Недостаточно прав' }, 403);
        }
        await env.DB.prepare(
          'DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, targetUserId).run();
        return json({ ok: true });
      }

      const chatDetailMatch = path.match(/^\/api\/chats\/([^/]+)$/);
      if (chatDetailMatch && request.method === 'GET') {
        const chatId = chatDetailMatch[1];
        const isMember = await env.DB.prepare(
          'SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, auth.userId).first();
        if (!isMember) return json({ error: 'Not a member of this chat' }, 403);

        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(chatId).first();
        const { results: members } = await env.DB.prepare(
          `SELECT u.id, u.username, u.display_name, u.avatar_color, u.last_seen, cm.role
           FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ?`
        ).bind(chatId).all();

        return json({ chat: { ...chat, members, myRole: isMember.role } });
      }

      if (chatDetailMatch && request.method === 'PUT') {
        const chatId = chatDetailMatch[1];
        const membership = await env.DB.prepare(
          'SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, auth.userId).first();
        if (!membership || membership.role === 'member') {
          return json({ error: 'Только владелец или администратор может изменять чат' }, 403);
        }
        const { name, description } = await request.json();
        const updates = [];
        const binds = [];
        if (name !== undefined) { updates.push('name = ?'); binds.push(name.trim()); }
        if (description !== undefined) { updates.push('description = ?'); binds.push(description.trim()); }
        if (updates.length === 0) return json({ error: 'Nothing to update' }, 400);
        binds.push(chatId);
        await env.DB.prepare(`UPDATE chats SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
        return json({ ok: true });
      }

      // ---------- READ RECEIPTS ----------
      const readMatch = path.match(/^\/api\/chats\/([^/]+)\/read$/);
      if (readMatch && request.method === 'POST') {
        const chatId = readMatch[1];
        const { messageId } = await request.json();

        const isMember = await env.DB.prepare(
          'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, auth.userId).first();
        if (!isMember) return json({ error: 'Not a member of this chat' }, 403);

        await env.DB.prepare(
          'UPDATE chat_members SET last_read_message_id = ? WHERE chat_id = ? AND user_id = ?'
        ).bind(messageId, chatId, auth.userId).run();

        // notify other members in real time so they see "read" ticks update
        const roomId = env.CHAT_ROOM.idFromName(chatId);
        const room = env.CHAT_ROOM.get(roomId);
        await room.fetch('https://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify({ type: 'read', chatId, userId: auth.userId, messageId }),
        });

        return json({ ok: true });
      }

      // ---------- PRESENCE (who's online in a chat) ----------
      const presenceMatch = path.match(/^\/api\/chats\/([^/]+)\/presence$/);
      if (presenceMatch && request.method === 'GET') {
        const chatId = presenceMatch[1];
        const isMember = await env.DB.prepare(
          'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, auth.userId).first();
        if (!isMember) return json({ error: 'Not a member of this chat' }, 403);

        const { results: members } = await env.DB.prepare(
          `SELECT u.id, u.last_seen FROM chat_members cm JOIN users u ON u.id = cm.user_id
           WHERE cm.chat_id = ?`
        ).bind(chatId).all();

        const ONLINE_THRESHOLD_MS = 30_000; // considered "online" if seen in the last 30s
        const now = Date.now();
        const presence = members.map(m => ({
          userId: m.id,
          online: now - m.last_seen < ONLINE_THRESHOLD_MS,
          lastSeen: m.last_seen,
        }));

        return json({ presence });
      }

      // ---------- MESSAGES ----------
      const msgMatch = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
      if (msgMatch && request.method === 'GET') {
        const chatId = msgMatch[1];
        const isMember = await env.DB.prepare(
          'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, auth.userId).first();
        if (!isMember) return json({ error: 'Not a member of this chat' }, 403);

        const before = url.searchParams.get('before');
        const limit = 50;
        let query = `SELECT m.id, m.sender_id, m.content, m.sent_at, m.edited_at, m.media_url, u.display_name, u.avatar_color
                     FROM messages m JOIN users u ON u.id = m.sender_id
                     WHERE m.chat_id = ? AND m.deleted = 0`;
        const binds = [chatId];
        if (before) {
          query += ' AND m.sent_at < ?';
          binds.push(Number(before));
        }
        query += ' ORDER BY m.sent_at DESC LIMIT ?';
        binds.push(limit);

        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json({ messages: results.reverse() });
      }

      if (msgMatch && request.method === 'POST') {
        const chatId = msgMatch[1];
        const membership = await env.DB.prepare(
          'SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, auth.userId).first();
        if (!membership) return json({ error: 'Not a member of this chat' }, 403);

        const chat = await env.DB.prepare('SELECT type FROM chats WHERE id = ?').bind(chatId).first();
        if (chat.type === 'channel' && membership.role === 'member') {
          return json({ error: 'Только владелец и администраторы канала могут отправлять сообщения' }, 403);
        }

        const { content, mediaUrl } = await request.json();
        if ((!content || !content.trim()) && !mediaUrl) return json({ error: 'Empty message' }, 400);

        const id = uuid();
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO messages (id, chat_id, sender_id, content, sent_at, media_url) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(id, chatId, auth.userId, (content || '').trim(), now, mediaUrl || null).run();

        const sender = await env.DB.prepare(
          'SELECT display_name, avatar_color FROM users WHERE id = ?'
        ).bind(auth.userId).first();

        const messagePayload = {
          type: 'message',
          message: {
            id, chatId, sender_id: auth.userId, content: (content || '').trim(), media_url: mediaUrl || null,
            sent_at: now, display_name: sender.display_name, avatar_color: sender.avatar_color,
          },
        };

        // broadcast via Durable Object
        const roomId = env.CHAT_ROOM.idFromName(chatId);
        const room = env.CHAT_ROOM.get(roomId);
        await room.fetch('https://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify(messagePayload),
        });

        // If the other party in this chat is a bot, notify it. Mama_Boss (the
        // built-in bot-creation assistant) is handled inline; third-party bots
        // are notified via their registered webhook URL.
        const { results: otherMembers } = await env.DB.prepare(
          `SELECT u.id, u.is_bot, u.username FROM chat_members cm JOIN users u ON u.id = cm.user_id
           WHERE cm.chat_id = ? AND cm.user_id != ?`
        ).bind(chatId, auth.userId).all();

        for (const other of otherMembers) {
          if (!other.is_bot) continue;
          if (other.username === 'Mama_Boss') {
            await handleMamaBossMessage(env, chatId, auth.userId, (content || '').trim());
          } else {
            await deliverToBot(env, other.id, chatId, auth.userId, (content || '').trim());
          }
        }

        return json({ message: messagePayload.message });
      }

      // ---------- WEBSOCKET ----------
      const wsMatch = path.match(/^\/api\/chats\/([^/]+)\/ws$/);
      if (wsMatch) {
        const chatId = wsMatch[1];
        const isMember = await env.DB.prepare(
          'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, auth.userId).first();
        if (!isMember) return json({ error: 'Not a member of this chat' }, 403);

        const roomId = env.CHAT_ROOM.idFromName(chatId);
        const room = env.CHAT_ROOM.get(roomId);
        const forwardUrl = new URL(request.url);
        forwardUrl.pathname = '/ws';
        forwardUrl.searchParams.set('userId', auth.userId);
        return room.fetch(forwardUrl.toString(), request);
      }

      // ---------- USER SEARCH (to start new chats) ----------
      if (path === '/api/users/search' && request.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        if (q.length < 2) return json({ users: [] });
        // rank exact username prefix matches first, then display_name matches
        const { results } = await env.DB.prepare(
          `SELECT id, username, display_name, avatar_color, is_bot,
                  (CASE WHEN username LIKE ? THEN 0 ELSE 1 END) as rank
           FROM users
           WHERE (username LIKE ? OR display_name LIKE ?) AND id != ?
           ORDER BY rank ASC, username ASC
           LIMIT 20`
        ).bind(`${q}%`, `%${q}%`, `%${q}%`, auth.userId).all();
        return json({ users: results });
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message || 'Internal error' }, 500);
    }
  },
};
