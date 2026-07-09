// chatRoom.js — Durable Object: one instance per chat, holds live WebSocket connections
// and broadcasts new messages to all connected members in real time.

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // userId -> WebSocket
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/ws')) {
      const userId = url.searchParams.get('userId');
      if (!userId) return new Response('Missing userId', { status: 400 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      server.accept();
      this.sessions.set(userId, server);

      server.addEventListener('close', () => this.sessions.delete(userId));
      server.addEventListener('error', () => this.sessions.delete(userId));

      // client can send typing indicators etc; we just relay them
      server.addEventListener('message', (event) => {
        this.relayEvent(userId, event.data);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
      const message = await request.json();
      this.broadcast(message);
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  }

  relayEvent(fromUserId, raw) {
    // Relay typing indicators / presence pings to other members, not persisted.
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (data.type === 'typing') {
      this.broadcast({ type: 'typing', userId: fromUserId }, fromUserId);
    }
  }

  broadcast(message, excludeUserId = null) {
    const payload = JSON.stringify(message);
    for (const [userId, ws] of this.sessions) {
      if (userId === excludeUserId) continue;
      try {
        ws.send(payload);
      } catch {
        this.sessions.delete(userId);
      }
    }
  }
}
