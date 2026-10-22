'use strict';
/**
 * Goon-Server – zentraler Multiplayer-Server für das Tauben-Spiel.
 * Verwaltet Lobbys (sechsstellige PINs, 2–4 Spieler), Bereit-Status, Spielstart
 * und leitet validierte Spielzustände zwischen den Clients weiter.
 * Keine Geheimnisse nötig: Clients verbinden sich per WebSocket (ws:// oder wss://).
 *
 * Umgebungsvariablen (alle optional):
 *   PORT         Port (Standard 8080; Hosting-Dienste setzen ihn selbst)
 *   MAX_LOBBIES  maximale gleichzeitige Lobbys (Standard 200)
 *   MAX_PER_IP   maximale Verbindungen pro IP (Standard 20)
 *   TRUST_PROXY  "1", wenn der Server hinter einem Proxy läuft (liest X-Forwarded-For)
 */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const MAX_LOBBIES = +process.env.MAX_LOBBIES || 200;
const MAX_PER_IP = +process.env.MAX_PER_IP || 20;
const TRUST = process.env.TRUST_PROXY === '1';

const lobbies = new Map(); // pin -> { pin, df, host, started, peers: Map(id -> peer) }
const perIp = new Map();
let nid = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, lobbies: lobbies.size, uptime: Math.round(process.uptime()) }));
  } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const list = l => [...l.peers.values()].map(p => ({ peer: p.id, pr: p.presence }));
const bcast = (l, o, except) => { for (const p of l.peers.values()) if (p.id !== except) send(p.ws, o); };
const num = (v, a, b) => typeof v === 'number' && isFinite(v) && v >= a && v <= b;
const int = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;

function newPin() {
  for (let i = 0; i < 60; i++) {
    const p = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    if (!lobbies.has(p)) return p;
  }
  return null;
}

/* ---------- Validierung der Spielereignisse (Anti-Fälschung) ---------- */
function cleanEv(list_, peer, isHost, lobby) {
  if (!Array.isArray(list_)) return [];
  const out = [], now = Date.now();
  let maxSeq = peer.seq;
  for (const e of list_.slice(0, 12)) {
    if (!e || typeof e !== 'object' || !Number.isInteger(e.i) || e.i < 0) continue;
    const isNew = e.i > peer.seq;
    let ok = false, c = null;
    switch (e.t) {
      case 's': // Milchfleck
        ok = num(e.x, -100, 100) && num(e.z, -100, 100) && num(e.h, -7, 7);
        c = { t: 's', i: e.i, x: e.x, z: e.z, h: e.h, r: e.r ? 1 : 0 }; break;
      case 'f': // Schuss-Effekt
        ok = Array.isArray(e.a) && Array.isArray(e.b) && e.a.length === 3 && e.b.length === 3 &&
             e.a.every(v => num(v, -300, 300)) && e.b.every(v => num(v, -300, 300));
        c = { t: 'f', i: e.i, a: e.a, b: e.b }; break;
      case 'h': // Treffer auf einen Gegner (Client -> Host); begrenzt in Schaden und Rate
        ok = int(e.f, 1, 1e9) && num(e.d, 1, 30);
        if (ok && isNew) {
          peer.h = peer.h.filter(t => now - t < 1000);
          if (peer.h.length >= 8) ok = false; else peer.h.push(now);
        }
        c = { t: 'h', i: e.i, f: e.f, d: Math.round(e.d) }; break;
      case 'd': // Schaden an einen Spieler: nur der Host darf das
        ok = isHost && typeof e.to === 'string' && lobby.peers.has(e.to) && num(e.d, 1, 25);
        c = { t: 'd', i: e.i, to: e.to, d: Math.round(e.d) }; break;
      case 'l': // Lewanschettn-Drop: nur der Host
        ok = isHost && typeof e.to === 'string' && lobby.peers.has(e.to) && num(e.x, -100, 100) && num(e.z, -100, 100);
        c = { t: 'l', i: e.i, to: e.to, x: e.x, z: e.z }; break;
      case 'p': // Milchprojektil eines Gegners: nur der Host
        ok = isHost && ['x', 'y', 'z', 'vx', 'vy', 'vz'].every(k => num(e[k], -100, 100));
        c = { t: 'p', i: e.i, x: e.x, y: e.y, z: e.z, vx: e.vx, vy: e.vy, vz: e.vz }; break;
    }
    if (ok) { out.push(c); if (isNew && e.i > maxSeq) maxSeq = e.i; }
  }
  peer.seq = maxSeq;
  return out;
}

function cleanPresence(p, peer, lobby) {
  const c = {}, isHost = lobby.host === peer.id;
  if (!p || typeof p !== 'object') return c;
  if (num(p.x, -80, 80)) c.x = p.x;
  if (num(p.y, 0, 15)) c.y = p.y;
  if (num(p.z, -30, 20)) c.z = p.z;
  if (num(p.hd, -7, 7)) c.hd = p.hd;
  if (int(p.hp, 0, 100)) c.hp = p.hp;
  if (p.dd === 0 || p.dd === 1) c.dd = p.dd;
  if (int(p.hr, 0, 5)) c.hr = p.hr;
  if (int(p.hc, 0, 2)) c.hc = p.hc;
  if (p.of === 0 || ['tala', 'suit', 'wolf'].includes(p.of)) c.of = p.of;
  if (p.ea === 0 || p.ea === 1) c.ea = p.ea;
  if ((p.rd === 0 || p.rd === 1) && !lobby.started) c.rd = p.rd;
  if (p.st === 'play') c.st = 'play';
  if ('ev' in p) c.ev = cleanEv(p.ev, peer, isHost, lobby);
  if (isHost) { // nur der Host darf den Gegnerzustand melden
    if (Array.isArray(p.fs) && p.fs.length <= 16 && p.fs.every(a => Array.isArray(a) && a.length === 7 && a.every(v => typeof v === 'number' && isFinite(v)))) c.fs = p.fs;
    if (typeof p.wv === 'string') c.wv = p.wv.slice(0, 60);
    if (int(p.kl, 0, 500)) c.kl = p.kl;
    if (int(p.tt, 0, 500)) c.tt = p.tt;
  }
  return c;
}

/* ---------- Lobby-Verwaltung ---------- */
function leaveLobby(peer) {
  const l = peer.lobby;
  if (!l) return;
  l.peers.delete(peer.id);
  peer.lobby = null;
  if (l.host === peer.id) { // Host weg: Lobby ordentlich schließen
    for (const q of l.peers.values()) { q.lobby = null; send(q.ws, { t: 'closed' }); }
    lobbies.delete(l.pin);
  } else if (l.peers.size === 0) lobbies.delete(l.pin);
  else bcast(l, { t: 'peers', list: list(l) });
}

function handle(peer, m) {
  if (!m || typeof m !== 'object') return;
  const err = c => send(peer.ws, { t: 'err', c });
  switch (m.t) {
    case 'create': {
      if (peer.lobby) return err('err');
      if (lobbies.size >= MAX_LOBBIES) return err('srvbusy');
      const pin = newPin();
      if (!pin) return err('srvbusy');
      const df = int(m.df, 0, 2) ? m.df : (m.df === 0 ? 0 : 1);
      const l = { pin, df, host: peer.id, started: false, peers: new Map([[peer.id, peer]]) };
      lobbies.set(pin, l);
      peer.lobby = l;
      peer.presence = { gm: 1, host: 1, lobby: 1, rd: 0, pin, df };
      send(peer.ws, { t: 'joined', pin, peer: peer.id, host: true });
      send(peer.ws, { t: 'peers', list: list(l) });
      break;
    }
    case 'join': {
      if (peer.lobby) return err('err');
      if (typeof m.pin !== 'string' || !/^\d{6}$/.test(m.pin)) return err('badpin');
      const l = lobbies.get(m.pin);
      if (!l) return err('none');
      if (l.started) return err('running');
      if (l.peers.size >= 4) return err('full');
      l.peers.set(peer.id, peer);
      peer.lobby = l;
      peer.presence = { gm: 1, rd: 0 };
      send(peer.ws, { t: 'joined', pin: l.pin, peer: peer.id, host: false });
      bcast(l, { t: 'peers', list: list(l) });
      break;
    }
    case 'pr': {
      const l = peer.lobby;
      if (!l) return;
      const c = cleanPresence(m.p, peer, l);
      Object.assign(peer.presence, c);
      if (Object.keys(c).length) bcast(l, { t: 'pp', peer: peer.id, p: c }, peer.id);
      break;
    }
    case 'start': {
      const l = peer.lobby;
      if (!l || l.host !== peer.id || l.started) return;
      const ps = [...l.peers.values()];
      if (ps.length < 2 || ps.length > 4 || !ps.every(p => p.presence.rd === 1)) return err('notready');
      l.started = true;
      peer.presence.go = 1; peer.presence.ep = Date.now();
      bcast(l, { t: 'pp', peer: peer.id, p: { go: 1, ep: peer.presence.ep } });
      send(peer.ws, { t: 'pp', peer: peer.id, p: { go: 1, ep: peer.presence.ep } });
      break;
    }
    case 'leave': leaveLobby(peer); break;
  }
}

wss.on('connection', (ws, req) => {
  const ip = ((TRUST && req.headers['x-forwarded-for']) || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const n = (perIp.get(ip) || 0) + 1;
  if (n > MAX_PER_IP) { ws.close(1013, 'zu viele Verbindungen'); return; }
  perIp.set(ip, n);
  const peer = { id: 'p' + (++nid).toString(36) + crypto.randomBytes(2).toString('hex'), ws, lobby: null, presence: {}, seq: 0, h: [], tokens: 60, last: Date.now(), drops: 0, alive: true };
  ws.on('pong', () => { peer.alive = true; });
  ws.on('message', (buf, isBinary) => {
    if (isBinary) return;
    const now = Date.now();
    peer.tokens = Math.min(60, peer.tokens + (now - peer.last) / 1000 * 40); // 40 Nachrichten/s im Mittel
    peer.last = now;
    if (--peer.tokens < 0) { if (++peer.drops > 400) ws.terminate(); return; }
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    try { handle(peer, m); } catch (e) { console.error('handler', e.message); }
  });
  ws.on('close', () => {
    perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1));
    leaveLobby(peer);
  });
  ws.on('error', () => {});
});

setInterval(() => { // tote Verbindungen entfernen
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  }
}, 25000).unref();
wss.on('connection', ws => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

if (require.main === module) {
  server.listen(PORT, () => console.log('goon-server läuft auf Port ' + PORT));
  process.on('SIGTERM', () => { wss.close(); server.close(() => process.exit(0)); });
}
module.exports = { server, wss, lobbies };
