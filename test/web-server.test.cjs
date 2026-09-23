'use strict';
// Slice web vertical: 401 sin token (ERR-W01), pty.list ok, push hive:* en vivo.
// Requiere build previo (`npm run build:web`). Sin node-pty nativo el caso de
// pty se salta con mensaje (el server debe seguir vivo: ERR-W07, no crash).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const TOKEN = 'smoke-test-token-12345';
let srv, base, wsUrl, stateDir, harnessHome;

async function http(path, headers = {}) {
  const r = await fetch(base + path, { headers });
  let body = null;
  try { body = await r.json(); } catch { /* no-json */ }
  return { status: r.status, body };
}

function wsConnect(headersOrQuery) {
  const { WebSocket } = require('ws');
  const url = typeof headersOrQuery === 'string' && headersOrQuery.startsWith('?')
    ? wsUrl + headersOrQuery
    : wsUrl;
  const headers = typeof headersOrQuery === 'object' ? headersOrQuery : undefined;
  return new WebSocket(url, headers ? { headers } : undefined);
}

function wsInvoke(ws, method, params = {}) {
  const id = `${method}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 15000);
    const onMsg = (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg && msg.id === id) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

before(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'md-web-smoke-userdata-'));
  harnessHome = mkdtempSync(join(tmpdir(), 'md-web-smoke-hive-'));
  process.env.MD_USERDATA = stateDir;
  process.env.HARNESS_HOME = harnessHome;
  process.env.WEB_TOKEN = TOKEN;
  const { startWebServer } = require('../out/web/main/server.js');
  srv = await startWebServer({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${srv.port}`;
  wsUrl = `ws://127.0.0.1:${srv.port}/cth/v1`;
});

after(async () => {
  await srv?.close();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(harnessHome, { recursive: true, force: true });
});

test('sin token → 401 ERR-W01 (upgrade WS)', async () => {
  const { WebSocket } = require('ws');
  const err = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.on('open', () => resolve({ status: 101 }));
    ws.on('error', () => {});
  });
  assert.equal(err.status, 401);
});

test('sin token → 401 ERR-W01 (HTTP)', async () => {
  const r = await http('/cth/v1');
  assert.equal(r.status, 401);
  assert.equal(r.body?.error?.code, 'ERR-W01');
});

test('healthz abierto (Docker HEALTHCHECK)', async () => {
  const r = await http('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body?.ok, true);
  assert.equal(r.body?.mode, 'web');
});

test('pty.list ok + método Electron-only → ERR-W06', async (t) => {
  if (!srv.core.ptyAvailable) {
    t.skip('node-pty nativo ausente en esta máquina');
    return;
  }
  const ws = wsConnect(`?token=${TOKEN}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const list = await wsInvoke(ws, 'pty.list');
  assert.equal(list.ok, true);
  assert.ok(Array.isArray(list.data));
  const w06 = await wsInvoke(ws, 'dialog:chooseFolder');
  assert.equal(w06.ok, false);
  assert.equal(w06.error?.code, 'ERR-W06');
  ws.close();
});

test('hive.send en vivo → push hive:* por el mismo WS', async () => {
  const ws = wsConnect({ Authorization: `Bearer ${TOKEN}` });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const push = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting hive push')), 15000);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg && typeof msg.channel === 'string' && msg.channel.startsWith('hive:')) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
  const resp = await wsInvoke(ws, 'hive.send', {
    msg: { to: 'god', subject: 'smoke', body: 'ping' },
    from: 'web-smoke'
  });
  assert.equal(resp.ok, true);
  const evt = await push;
  assert.ok(evt.channel.startsWith('hive:'));
  ws.close();
});

test('pty.spawn sale rápido → push pty:exit:<id>', async (t) => {
  if (!srv.core.ptyAvailable) {
    t.skip('node-pty nativo ausente en esta máquina');
    return;
  }
  const ws = wsConnect(`?token=${TOKEN}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const id = `smoke-${Date.now()}`;
  const exitPush = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting pty exit push')), 20000);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg && msg.channel === `pty:exit:${id}`) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
  const spawned = await wsInvoke(ws, 'pty.spawn', {
    opts: { id, cwd: harnessHome, command: 'true' }
  });
  assert.equal(spawned.ok, true);
  const evt = await exitPush;
  assert.equal(evt.channel, `pty:exit:${id}`);
  ws.close();
});
