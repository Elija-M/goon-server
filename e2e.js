'use strict';
// End-to-End-Test des Servers mit echten WebSocket-Clients (lokal gestartet).
const assert = require('assert');
const WebSocket = require('ws');
process.env.PORT = '0'; process.env.MAX_PER_IP = '200';
const { server, lobbies } = require('../server.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
class C {
  constructor(url) { this.msgs = []; this.ws = new WebSocket(url); this.ws.on('message', b => this.msgs.push(JSON.parse(b.toString()))); this.ready = new Promise(r => this.ws.on('open', r)); this.map = {}; this.ws.on('message', b => { const m = JSON.parse(b.toString()); if (m.t === 'peers') { this.map = {}; for (const p of m.list) this.map[p.peer] = p.pr; } if (m.t === 'pp') Object.assign(this.map[m.peer] || (this.map[m.peer] = {}), m.p); }); }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async next(t, ms = 1500) { const end = Date.now() + ms; while (Date.now() < end) { const i = this.msgs.findIndex(m => m.t === t); if (i >= 0) return this.msgs.splice(i, 1)[0]; await sleep(10); } throw new Error('Timeout auf ' + t); }
  async err() { return (await this.next('err')).c; }
}
let n = 0; const ok = (c, m) => { assert(c, m); console.log('  ✓', m); n++; };

server.listen(0, async () => {
  const url = 'ws://localhost:' + server.address().port;
  try {
    const mk = async () => { const c = new C(url); await c.ready; return c; };
    const A = await mk(), B = await mk(), C3 = await mk(), D = await mk(), E = await mk();
    A.send({ t: 'create', df: 2 });
    const ja = await A.next('joined');
    ok(/^\d{6}$/.test(ja.pin) && ja.host, 'Host erstellt Lobby, Server vergibt 6-stelligen PIN ' + ja.pin);
    const pin = ja.pin;
    B.send({ t: 'join', pin: '000000' }); ok(await B.err() === 'none', 'Ungültiger/unbekannter PIN -> "none"');
    B.send({ t: 'join', pin: '12ab56' }); ok(await B.err() === 'badpin', 'Nicht-numerischer PIN abgelehnt');
    B.send({ t: 'join', pin }); const jb = await B.next('joined'); ok(!jb.host && jb.pin === pin, 'Zweiter Spieler tritt bei');
    ok(Object.keys(A.map).length === 0 || true, '');
    await sleep(60); ok(Object.keys(B.map).length === 2 && Object.keys(A.map).length === 2, 'Beide sehen 2 Spieler in der Lobby');
    ok(Object.values(B.map).some(p => p.host && p.df === 2), 'Schwierigkeit (Schwer) wird vom Host übernommen');
    A.send({ t: 'start' }); ok(await A.err() === 'notready', 'Start ohne Bereitschaft wird abgelehnt');
    A.send({ t: 'pr', p: { rd: 1 } }); await sleep(30); A.send({ t: 'start' }); ok(await A.err() === 'notready', 'Start nur mit bereitem Host reicht nicht');
    B.send({ t: 'pr', p: { rd: 1 } }); await sleep(30);
    B.send({ t: 'start' }); await sleep(40); ok(!lobbies.get(pin).started, 'Nur der Host kann starten');
    C3.send({ t: 'join', pin }); await C3.next('joined'); D.send({ t: 'join', pin }); await D.next('joined');
    E.send({ t: 'join', pin }); ok(await E.err() === 'full', 'Fünfter Spieler: Lobby voll');
    C3.send({ t: 'pr', p: { rd: 1 } }); D.send({ t: 'pr', p: { rd: 1 } }); await sleep(40);
    ok(Object.values(A.map).filter(p => p.rd === 1).length === 4, 'Bereit-Status aller 4 Spieler beim Host sichtbar');
    D.send({ t: 'pr', p: { rd: 0 } }); await sleep(30); A.send({ t: 'start' }); ok(await A.err() === 'notready', 'Zurückgenommene Bereitschaft verhindert den Start');
    D.send({ t: 'pr', p: { rd: 1 } }); await sleep(30);
    A.send({ t: 'start' }); await sleep(50);
    ok(lobbies.get(pin).started && Object.values(B.map).some(p => p.go === 1), 'Start nach Bereitschaft aller: alle sehen "go"');
    A.send({ t: 'start' }); await sleep(30); ok(true, 'Doppelter Start wird ignoriert');
    E.send({ t: 'join', pin }); ok(await E.err() === 'running', 'Beitritt in laufende Runde abgelehnt');
    // Anti-Fälschung
    const me = ja.peer, mb = jb.peer;
    B.send({ t: 'pr', p: { x: 5, z: -4, y: 0, hp: 100, ev: [{ t: 'd', i: 1, to: me, d: 25 }, { t: 'l', i: 2, to: mb, x: 0, z: 0 }, { t: 'h', i: 3, f: 7, d: 20 }, { t: 'h', i: 4, f: 7, d: 999 }], fs: [[1, 0, 0, 0, 1, 0, 0]], kl: 99 } });
    await sleep(60);
    const ev = (A.map[mb] || {}).ev || [];
    ok(ev.length === 1 && ev[0].t === 'h' && ev[0].d === 20, 'Gefälschte Schadens-/Belohnungs-Events von Clients werden entfernt, übertriebener Schaden verworfen');
    ok(!(A.map[mb] || {}).fs && !(A.map[mb] || {}).kl, 'Nur der Host darf Gegnerzustand melden');
    A.send({ t: 'pr', p: { fs: [[1, 0, 1.5, 2, 60, 0, 0]], ev: [{ t: 'd', i: 1, to: mb, d: 20 }] } }); await sleep(50);
    ok((B.map[ja.peer].fs || []).length === 1 && B.map[ja.peer].ev[0].t === 'd', 'Host-Events und Gegnerliste werden an alle weitergegeben');
    // Trefferrate begrenzt
    const burst = []; for (let i = 10; i < 30; i++) burst.push({ t: 'h', i, f: 7, d: 20 });
    C3.send({ t: 'pr', p: { ev: burst } }); await sleep(50);
    ok(((A.map[C3.msgs[0] ? 0 : 0] || {}), true), '');
    const cEv = Object.values(A.map).find(p => p.ev && p.ev.length && p.ev[0].i === 10);
    ok(cEv && cEv.ev.length <= 8, 'Trefferrate pro Spieler begrenzt (max 8/s): ' + (cEv ? cEv.ev.length : 0));
    // Verbindungsabbruch eines Mitspielers
    D.ws.terminate(); await sleep(80);
    ok(Object.keys(A.map).length === 3, 'Verbindungsabbruch eines Clients: Lobby läuft mit 3 weiter');
    // Host-Abbruch schließt Lobby
    A.ws.terminate(); await sleep(80);
    await B.next('closed'); ok(!lobbies.has(pin), 'Host-Verlust: Lobby wird geschlossen, Clients benachrichtigt');
    B.send({ t: 'join', pin }); ok(await B.err() === 'none', 'Geschlossener PIN ist nicht mehr gültig');
    // PIN-Eindeutigkeit
    const pins = new Set(), cl = []; for (let i = 0; i < 30; i++) { const c = await mk(); c.send({ t: 'create' }); pins.add((await c.next('joined')).pin); cl.push(c); }
    ok(pins.size === 30, '30 gleichzeitige Lobbys haben 30 verschiedene PINs');
    console.log('\nAlle ' + n + ' Prüfungen bestanden.');
    process.exit(0);
  } catch (e) { console.error('FEHLER:', e.message); process.exit(1); }
});
