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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

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

      // ---------- CHATS ----------
      if (path === '/api/chats' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT c.id, c.type, c.name, c.created_at
           FROM chats c
           JOIN chat_members cm ON cm.chat_id = c.id
           WHERE cm.user_id = ?
           ORDER BY c.created_at DESC`
        ).bind(auth.userId).all();

        // enrich with members + last message
        const chats = [];
        for (const chat of results) {
          const { results: members } = await env.DB.prepare(
            `SELECT u.id, u.username, u.display_name, u.avatar_color
             FROM chat_members cm JOIN users u ON u.id = cm.user_id
             WHERE cm.chat_id = ?`
          ).bind(chat.id).all();

          const lastMessage = await env.DB.prepare(
            `SELECT content, sent_at, sender_id FROM messages
             WHERE chat_id = ? AND deleted = 0
             ORDER BY sent_at DESC LIMIT 1`
          ).bind(chat.id).first();

          chats.push({ ...chat, members, lastMessage: lastMessage || null });
        }
        return json({ chats });
      }

      if (path === '/api/chats' && request.method === 'POST') {
        const { type, memberIds, name } = await request.json();
        if (!['direct', 'group'].includes(type)) return json({ error: 'Invalid chat type' }, 400);
        if (!Array.isArray(memberIds) || memberIds.length === 0) {
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

        const chatId = uuid();
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO chats (id, type, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)`
        ).bind(chatId, type, name || null, auth.userId, now).run();

        for (const memberId of allMembers) {
          const role = memberId === auth.userId ? 'owner' : 'member';
          await env.DB.prepare(
            `INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`
          ).bind(chatId, memberId, role, now).run();
        }

        return json({ chatId, existing: false });
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
        let query = `SELECT m.id, m.sender_id, m.content, m.sent_at, m.edited_at, u.display_name, u.avatar_color
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
        const isMember = await env.DB.prepare(
          'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?'
        ).bind(chatId, auth.userId).first();
        if (!isMember) return json({ error: 'Not a member of this chat' }, 403);

        const { content } = await request.json();
        if (!content || !content.trim()) return json({ error: 'Empty message' }, 400);

        const id = uuid();
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO messages (id, chat_id, sender_id, content, sent_at) VALUES (?, ?, ?, ?, ?)`
        ).bind(id, chatId, auth.userId, content.trim(), now).run();

        const sender = await env.DB.prepare(
          'SELECT display_name, avatar_color FROM users WHERE id = ?'
        ).bind(auth.userId).first();

        const messagePayload = {
          type: 'message',
          message: {
            id, chatId, sender_id: auth.userId, content: content.trim(),
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
        const { results } = await env.DB.prepare(
          `SELECT id, username, display_name, avatar_color FROM users
           WHERE username LIKE ? AND id != ? LIMIT 20`
        ).bind(`%${q}%`, auth.userId).all();
        return json({ users: results });
      }

      if (path === '/api/me' && request.method === 'GET') {
        const user = await env.DB.prepare(
          'SELECT id, username, display_name, avatar_color FROM users WHERE id = ?'
        ).bind(auth.userId).first();
        return json({ user });
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message || 'Internal error' }, 500);
    }
  },
};
