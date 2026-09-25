// Networking: offline loopback and an online WebSocket client that talks to the
// Cloudflare Durable Object room relay (worker/index.js).

export class OfflineNet {
  constructor() { this.online = false; this.id = 'me'; this.hostId = 'me'; }
  sendAll() {}
  sendHost() {}
  sendTo() {}
  chat() {}
  close() {}
}

export class OnlineNet {
  constructor() {
    this.online = true;
    this.id = null;
    this.hostId = null;
    this.handlers = {};
    this.ws = null;
    this.queue = [];
    this.ping = 0;
  }

  on(type, fn) { this.handlers[type] = fn; return this; }
  emit(type, ...args) { const h = this.handlers[type]; if (h) h(...args); }

  connect(room, name, skin) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/ws?room=${encodeURIComponent(room)}`;
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      this.ws = ws;
      const timer = setTimeout(() => { reject(new Error('连接超时')); try { ws.close(); } catch { /* */ } }, 8000);
      ws.onopen = () => ws.send(JSON.stringify({ sys: 'hello', name, skin }));
      ws.onerror = () => { clearTimeout(timer); reject(new Error('无法连接服务器')); };
      ws.onclose = (e) => { clearTimeout(timer); this.emit('close', e); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.sys === 'welcome') {
          clearTimeout(timer);
          this.id = msg.id; this.hostId = msg.host;
          resolve(msg);
          return;
        }
        if (msg.sys === 'full') { clearTimeout(timer); reject(new Error('房间已满')); return; }
        if (msg.sys === 'host') { this.hostId = msg.id; this.emit('host', msg.id); return; }
        if (msg.sys === 'join') { this.emit('join', msg); return; }
        if (msg.sys === 'leave') { this.emit('leave', msg); return; }
        if (msg.sys === 'pong') { this.ping = performance.now() - msg.t; return; }
        if (msg.m) {
          if (msg.m.k === 'chat') this.emit('chat', msg.from, msg.m.text);
          else this.emit('msg', msg.m, msg.from);
        }
      };
      this._pingI = setInterval(() => this._send({ sys: 'ping', t: performance.now() }), 3000);
    });
  }

  _send(o) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
  }

  sendAll(m) { this._send({ to: 'all', m }); }
  sendHost(m) { this._send({ to: 'host', m }); }
  sendTo(id, m) { this._send({ to: id, m }); }
  chat(text) { this._send({ to: 'all', m: { k: 'chat', text }, echo: true }); }
  yieldHost() { this._send({ sys: 'yield' }); }
  close() { clearInterval(this._pingI); try { this.ws && this.ws.close(); } catch { /* */ } }
}

export async function listRooms() {
  try {
    const r = await fetch('/api/rooms');
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}
