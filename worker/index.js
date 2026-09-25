// Cloudflare Worker: serves the static game (Workers Assets) and hosts
// multiplayer rooms as Durable Objects (WebSocket relay + host election).
import { DurableObject } from 'cloudflare:workers';

const MAX_PLAYERS = 16;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const room = (url.searchParams.get('room') || 'public').slice(0, 24).replace(/[^\w一-龥-]/g, '') || 'public';
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      const u = new URL(request.url);
      u.searchParams.set('room', room);
      return stub.fetch(new Request(u.toString(), request));
    }
    if (url.pathname === '/api/rooms') {
      const stub = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
      return stub.fetch(new Request('https://lobby/list'));
    }
    return env.ASSETS.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.clients = new Map(); // id -> {ws, name, skin, joined}
    this.seq = 0;
    this.hostId = null;
    this.room = 'public';
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.room = url.searchParams.get('room') || this.room;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    let id = null;

    server.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.sys === 'hello' && !id) {
        if (this.clients.size >= MAX_PLAYERS) { server.send(JSON.stringify({ sys: 'full' })); server.close(1000, 'full'); return; }
        id = 'p' + (++this.seq) + Math.random().toString(36).slice(2, 5);
        const name = String(msg.name || '玩家').slice(0, 14);
        const skin = Number(msg.skin) || 0;
        const peers = [...this.clients.entries()].map(([pid, c]) => ({ id: pid, name: c.name, skin: c.skin }));
        this.clients.set(id, { ws: server, name, skin, joined: Date.now() });
        if (!this.hostId || !this.clients.has(this.hostId)) this.hostId = id;
        server.send(JSON.stringify({ sys: 'welcome', id, host: this.hostId, peers, room: this.room }));
        this.broadcast({ sys: 'join', id, name, skin }, id);
        this.report();
        return;
      }
      if (!id) return;
      if (msg.sys === 'ping') { server.send(JSON.stringify({ sys: 'pong', t: msg.t })); return; }
      if (msg.sys === 'yield' && id === this.hostId && this.clients.size > 1) {
        // host tab went to the background: hand hosting to the longest-connected other player
        let next = null, t = Infinity;
        for (const [pid, c] of this.clients) if (pid !== id && c.joined < t) { t = c.joined; next = pid; }
        if (next) { this.hostId = next; this.broadcast({ sys: 'host', id: next }); }
        return;
      }
      if (!msg.m) return;
      const out = JSON.stringify({ from: id, m: msg.m });
      if (msg.to === 'all') {
        for (const [pid, c] of this.clients) if (pid !== id || msg.echo) safeSend(c.ws, out);
      } else if (msg.to === 'host') {
        const h = this.clients.get(this.hostId);
        if (h) safeSend(h.ws, out);
      } else if (typeof msg.to === 'string') {
        const c = this.clients.get(msg.to);
        if (c) safeSend(c.ws, out);
      }
    });

    const onClose = () => {
      if (!id || !this.clients.has(id)) return;
      this.clients.delete(id);
      this.broadcast({ sys: 'leave', id });
      if (this.hostId === id) {
        let next = null, t = Infinity;
        for (const [pid, c] of this.clients) if (c.joined < t) { t = c.joined; next = pid; }
        this.hostId = next;
        if (next) this.broadcast({ sys: 'host', id: next });
      }
      this.report();
    };
    server.addEventListener('close', onClose);
    server.addEventListener('error', onClose);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const [pid, c] of this.clients) if (pid !== except) safeSend(c.ws, s);
  }

  report() {
    try {
      const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
      const host = this.clients.get(this.hostId);
      this.ctx.waitUntil(stub.fetch(new Request('https://lobby/report', {
        method: 'POST',
        body: JSON.stringify({ room: this.room, count: this.clients.size, host: host ? host.name : '' }),
      })).catch(() => {}));
    } catch { /* lobby optional */ }
  }
}

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/report' && request.method === 'POST') {
      const { room, count, host } = await request.json();
      if (count > 0) this.rooms.set(room, { room, count, host, t: Date.now() });
      else this.rooms.delete(room);
      return new Response('ok');
    }
    const now = Date.now();
    const list = [...this.rooms.values()].filter((r) => now - r.t < 30 * 60 * 1000).sort((a, b) => b.count - a.count).slice(0, 30);
    return new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
}

function safeSend(ws, s) {
  try { ws.send(s); } catch { /* closed */ }
}
