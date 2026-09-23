import './electronStub';

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { app } from 'electron';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  WEB_DEFAULT_HOST,
  WEB_DEFAULT_PORT,
  WEB_ELECTRON_ONLY,
  WEB_V1_INVOKE,
  WEB_V1_PUSH,
  type CthError,
  type CthEvent,
  type CthResponse
} from '../shared/webBridge';
import { checkAuth, err, expectedToken, writeJsonError } from './webAuth';
import { createCore, saveMissions, startCore, type CoreServices, type PushEmit } from './bootstrap';
import { readConfig, writeConfig, ensureHarnessHome, type HarnessConfig } from './config';
import { expandTilde, listDir, readFileBinary, readFileText, statAbs, writeFileText } from './fs';
import {
  checkoutRef, compareRefs, getAheadBehind, getBranch, getBranches, getCommitFiles, getDiff,
  getFileAtRev, getLog, getLogGraph, getStatus, isRepo, listWorktrees, mainRepoRoot
} from './git';
import { readAgentUsage, readContextTokens, resolveSessionCwd } from './transcript';
import { SlackWebhookServer } from './slack';
import { normalizeAgentProvider, providerPreset } from '../shared/agentProvider';
import { resolveCommand as resolveCliCommand } from './shellEnv';
import { toolCatalog } from '../shared/toolCatalog';
import { listLocalSkills, loadCatalog } from './skills';
import { loadHero } from './hero';
import { loadModelCatalog } from './modelCatalog';
import { listTriggerHistory } from './triggerHistory';
import { DEFAULT_ORG_TRIGGER, type WebhookTrigger } from '../shared/triggers';
import { INTEGRATION_TEMPLATES } from '../shared/integrations';
import { listRecordsRedacted } from './integrations';
import { KnowledgeManager } from './knowledge';

const knowledge = new KnowledgeManager();

// Diferido a hitos posteriores (ver bootstrap.ts): scheduler syncMissions/
// syncContextTriggers (missions:list/save persisten bien, sin re-arme en vivo),
// reflector, broker de integración, spawnAgentCore completo (pty.spawn del slice
// es terminal cruda sin registro en hive) y multiplexar /hooks/slack en :8888
// (hoy SlackWebhookServer reutilizado en su propio puerto, como en Electron).

const WS_PATH = '/cth/v1';
const staticRoot = resolve(__dirname, '..', '..', 'renderer');

export interface WebBind {
  host: string;
  port: number;
}

export function resolveWebBind(): WebBind {
  let cfgHost: string | undefined;
  let cfgPort: number | undefined;
  try {
    const c = readConfig();
    cfgHost = c.webHost ?? undefined;
    cfgPort = typeof c.webPort === 'number' ? c.webPort : undefined;
  } catch { /* config rota: mandan env/defaults */ }
  const portRaw = process.env.WEB_PORT?.trim() ?? '';
  const portParsed = portRaw ? Number.parseInt(portRaw, 10) : NaN;
  return {
    host: process.env.WEB_HOST?.trim() || cfgHost || WEB_DEFAULT_HOST,
    port: Number.isFinite(portParsed) && portParsed > 0 ? portParsed : (cfgPort ?? WEB_DEFAULT_PORT)
  };
}

/** ¿Este canal se reemite por WS? Entradas exactas + prefijos 'pty:*:' + familia 'hive:*'. */
export function matchesPush(channel: string): boolean {
  if (WEB_V1_PUSH.some((e) => channel === e || (e.endsWith(':') && channel.startsWith(e)))) {
    return true;
  }
  // La familia hive:* se suscribe en bloque en el renderer (webBridge.ts); p.
  // ej. 'hive:message' que emite hive.send() también viaja por WS.
  return channel.startsWith('hive:');
}

type Handler = (params: Record<string, unknown>, core: CoreServices, broadcast?: PushEmit) => unknown | Promise<unknown>;

function needStr(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

const SHELL_BUILTINS = new Set(['true', 'false', 'echo', 'exit', 'test', 'printf', ':']);

/** Tabla de despacho: cada método WEB_V1_INVOKE → llamada directa al core. */
function buildHandlers(): Map<string, Handler> {
  const h = new Map<string, Handler>();
  // ── PTY ──
  h.set('pty.spawn', async (p, core, broadcast) => {
    if (!core.ptyAvailable || !core.pty) throw httpErr('ERR-W07', 'node-pty unavailable', 503);
    const opts = p.opts as { id?: unknown; cwd?: unknown; command?: unknown } | undefined;
    const id = opts && needStr(opts.id);
    const cwd = opts && needStr(opts.cwd);
    const command = opts && needStr(opts.command);
    if (!opts || !id || !cwd || !command) {
      throw httpErr('ERR-W03', 'pty.spawn needs opts.{id,cwd,command} strings', 400);
    }
    const bin = command.trim().split(/\s+/)[0] || command;
    if (!SHELL_BUILTINS.has(bin) && !core.pty.isCommandAvailable(bin)) {
      throw httpErr('ERR-W07', `engine CLI not installed: ${bin}`, 503);
    }
    const full: Record<string, unknown> = { ...(opts as Record<string, unknown>), id, cwd: expandTilde(cwd), command };
    // Desktop Add-agent manda hive meta: provisionar igual que hive.spawn para que
    // el agente quede registrado (floor/tasks/inbox) y no sea una PTY cruda.
    let seedPrompt: string | null = null;
    const meta = (full.hive ?? null) as { id?: unknown; name?: unknown; provider?: unknown; role?: unknown } | null;
    if (meta && typeof meta === 'object' && core.hive.enabled()) {
      const provider = normalizeAgentProvider(meta.provider) ?? 'claude';
      const inj = await core.hive.ensureAgent(
        {
          id,
          name: typeof meta.name === 'string' && meta.name ? meta.name : id,
          provider,
          cwd: full.cwd as string,
          role: typeof meta.role === 'string' && meta.role ? meta.role : 'agent'
        },
        { semanticMemory: core.memory.active(), theme: 'dark' }
      );
      full.args = [...((full.args as string[] | undefined) ?? []), ...inj.args];
      full.env = { ...((full.env as Record<string, string> | undefined) ?? {}), ...inj.env };
      seedPrompt = inj.seedPrompt ?? null;
    }
    const res = core.pty.spawn(full as never, null);
    if (meta && typeof meta === 'object') broadcast?.('hive:agentSpawned', { id });
    return { ...res, ...(seedPrompt ? { seedPrompt } : {}) };
  });
  h.set('pty.write', (p, core) => {
    if (!core.ptyAvailable || !core.pty) throw httpErr('ERR-W07', 'node-pty unavailable', 503);
    const id = needStr(p.id);
    if (!id || typeof p.data !== 'string') throw httpErr('ERR-W03', 'pty.write needs {id,data} strings', 400);
    return core.pty.write(id, p.data);
  });
  h.set('pty.resize', (p, core) => {
    if (!core.ptyAvailable || !core.pty) throw httpErr('ERR-W07', 'node-pty unavailable', 503);
    const id = needStr(p.id);
    if (!id || typeof p.cols !== 'number' || typeof p.rows !== 'number') {
      throw httpErr('ERR-W03', 'pty.resize needs {id,cols,rows}', 400);
    }
    return core.pty.resize(id, p.cols, p.rows);
  });
  h.set('pty.redraw', (p, core) => {
    if (!core.ptyAvailable || !core.pty) throw httpErr('ERR-W07', 'node-pty unavailable', 503);
    const id = needStr(p.id);
    if (!id) throw httpErr('ERR-W03', 'pty.redraw needs {id}', 400);
    return core.pty.redraw(id);
  });
  h.set('pty.kill', (p, core, broadcast) => {
    if (!core.ptyAvailable || !core.pty) throw httpErr('ERR-W07', 'node-pty unavailable', 503);
    const id = needStr(p.id);
    if (!id) throw httpErr('ERR-W03', 'pty.kill needs {id}', 400);
    const r = core.pty.kill(id);
    try { core.hive.setArchived(id, true); } catch { /* PTY cruda: no-op */ }
    broadcast?.('hive:agentArchived', { id });
    return r;
  });
  h.set('pty.list', (_p, core) => {
    if (!core.ptyAvailable || !core.pty) throw httpErr('ERR-W07', 'node-pty unavailable', 503);
    return core.pty.list();
  });
  h.set('session.resolveCwd', (p) => {
    if (typeof p.sessionId !== 'string') throw httpErr('ERR-W03', 'session.resolveCwd needs {sessionId}', 400);
    return resolveSessionCwd(p.sessionId);
  });
  // ── Hive ──
  h.set('hive.registry', (_p, core) => core.hive.registry());
  h.set('hive.board', (_p, core) => core.hive.board());
  h.set('hive.tasks', (_p, core) => core.hive.tasks());
  h.set('hive.memory', (p, core) => {
    if (typeof p.id !== 'string') throw httpErr('ERR-W03', 'hive.memory needs {id}', 400);
    return core.hive.memory(p.id);
  });
  h.set('hive.inbox', (p, core) => {
    if (typeof p.id !== 'string') throw httpErr('ERR-W03', 'hive.inbox needs {id}', 400);
    return core.hive.inbox(p.id);
  });
  h.set('hive.send', (p, core) => {
    if (!p.msg || typeof p.msg !== 'object') throw httpErr('ERR-W03', 'hive.send needs {msg}', 400);
    const from = typeof p.from === 'string' ? p.from : 'system';
    return core.hive.send(p.msg as Record<string, never>, from);
  });
  h.set('hive.spawn', async (p, core, broadcast) => {
    if (!core.ptyAvailable || !core.pty) throw httpErr('ERR-W07', 'node-pty unavailable', 503);
    if (!core.hive.enabled()) throw httpErr('ERR-W03', 'hive off (HARNESS_HOME unset)', 400);
    const a = (p.agent ?? {}) as Record<string, unknown>;
    const rawId = needStr(a.id);
    const name = needStr(a.name);
    const cwdIn = needStr(a.cwd);
    if (!rawId || !name || !cwdIn) {
      throw httpErr('ERR-W03', 'hive.spawn needs agent.{id,name,cwd}', 400);
    }
    const id = rawId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48);
    const provider = normalizeAgentProvider(a.provider) ?? 'claude';
    const preset = providerPreset(provider);
    const cmdLine = typeof a.command === 'string' && a.command.trim() ? a.command.trim() : preset.defaultCommand;
    const [bin, ...extraArgs] = cmdLine.split(/\s+/);
    if (!core.pty.isCommandAvailable(bin)) {
      throw httpErr('ERR-W07', `engine CLI not installed: ${bin}`, 503);
    }
    const cwd = expandTilde(cwdIn);
    const inj = await core.hive.ensureAgent(
      { id, name, provider, cwd, role: typeof a.role === 'string' && a.role ? a.role : 'agent' },
      { semanticMemory: core.memory.active(), theme: 'dark' }
    );
    const res = core.pty.spawn(
      { id, cwd, command: bin, args: [...extraArgs, ...inj.args], env: { ...inj.env }, cols: 100, rows: 30 } as never,
      null
    );
    if (!res.ok) throw httpErr('ERR-W05', res.error ?? 'spawn failed', 500);
    broadcast?.('hive:agentSpawned', { id });
    return { ok: true, ptyId: id, agentId: id, seedPrompt: inj.seedPrompt ?? null };
  });
  h.set('hive.memoryStatus', (_p, core) => core.memory.refresh());
  h.set('hive.searchMemory', async (p, core) => {
    if (typeof p.query !== 'string' || !p.query.trim()) {
      return { ok: false, output: '', error: 'empty query' };
    }
    return core.memory.search(p.query, { wing: typeof p.wing === 'string' ? p.wing : undefined });
  });
  // ── Scheduler ──
  h.set('missions.list', () => {
    try {
      return readConfig().missions ?? [];
    } catch (e) {
      throw httpErr('ERR-W05', e instanceof Error ? e.message : String(e), 500);
    }
  });
  h.set('missions.save', (p) => saveMissions(p.missions));
  // ── Observabilidad ──
  h.set('telemetry.usage', (p, core) => {
    if (typeof p.agentId !== 'string') throw httpErr('ERR-W03', 'telemetry.usage needs {agentId}', 400);
    return core.telemetry.getAgentUsage(p.agentId);
  });
  h.set('telemetry.snapshot', (_p, core) => core.telemetry.snapshot());
  // ── Git (misma coerción que index.ts) ──
  h.set('git.status', async (p) => {
    const cwd = needStr(p.cwd);
    if (!cwd) return { error: 'invalid cwd' };
    return getStatus(cwd);
  });
  h.set('git.worktrees', async (p) => {
    const cwd = needStr(p.cwd);
    if (!cwd) return { error: 'invalid args' };
    return listWorktrees(cwd);
  });
  h.set('git.branches', async (p) => {
    const cwd = needStr(p.cwd);
    if (!cwd) return { error: 'invalid cwd' };
    return getBranches(cwd);
  });
  h.set('git.log', async (p) => {
    const cwd = needStr(p.cwd);
    if (!cwd) throw httpErr('ERR-W03', 'git.log needs {cwd}', 400);
    const count = typeof p.limit === 'number' ? Math.min(500, Math.max(1, p.limit)) : 50;
    return getLog(cwd, count);
  });
  // ── Config ──
  h.set('config.get', () => readConfig());
  h.set('config.update', (p) => writeConfig(((p.patch ?? {}) as Partial<HarnessConfig>)));
  h.set('config.setAgentTokenCap', (p) => {
    const id = needStr(p.id);
    if (!id) throw httpErr('ERR-W03', 'config.setAgentTokenCap needs {id}', 400);
    const caps = { ...(readConfig().agentTokenCaps ?? {}) };
    if (typeof p.cap !== 'number') delete caps[id];
    else caps[id] = p.cap;
    return writeConfig({ agentTokenCaps: caps });
  });
  h.set('config.ensureHome', (p) => ensureHarnessHome(needStr(p.path) ?? ''));
  h.set('config.changeHome', () => ({ ok: true, home: readConfig().harnessHome }));
  // ── FS (puenteado como en Electron; el sandbox vive en fs.ts) ──
  h.set('fs.listDir', (p) => listDir(needStr(p.root) ?? '', typeof p.rel === 'string' ? p.rel : ''));
  h.set('fs.readFile', (p) => readFileText(needStr(p.root) ?? '', typeof p.rel === 'string' ? p.rel : ''));
  h.set('fs.readBinary', (p) => readFileBinary(needStr(p.root) ?? '', typeof p.rel === 'string' ? p.rel : ''));
  h.set('fs.writeFile', (p) => writeFileText(
    needStr(p.root) ?? '', typeof p.rel === 'string' ? p.rel : '', typeof p.text === 'string' ? p.text : ''
  ));
  h.set('fs.statAbs', (p) => statAbs(needStr(p.path) ?? ''));
  // ── Git completo ──
  h.set('git.isRepo', (p) => isRepo(needStr(p.cwd) ?? ''));
  h.set('git.mainRepo', (p) => mainRepoRoot(needStr(p.cwd) ?? ''));
  h.set('git.branch', (p) => getBranch(needStr(p.cwd) ?? ''));
  h.set('git.aheadBehind', (p) => getAheadBehind(needStr(p.cwd) ?? ''));
  h.set('git.diff', (p) => getDiff(needStr(p.cwd) ?? '', typeof p.relPath === 'string' ? p.relPath : ''));
  h.set('git.logGraph', (p) => getLogGraph(needStr(p.cwd) ?? '', num(p.n, 50), num(p.skip, 0)));
  h.set('git.commitFiles', (p) => getCommitFiles(needStr(p.cwd) ?? '', needStr(p.sha) ?? ''));
  h.set('git.showFile', (p) => getFileAtRev(needStr(p.cwd) ?? '', needStr(p.rev) ?? '', needStr(p.relPath) ?? ''));
  h.set('git.compareRefs', (p) => compareRefs(
    needStr(p.cwd) ?? '', needStr(p.base) ?? '', needStr(p.head) ?? '',
    p.mode === 'two' ? 'two' : 'three'
  ));
  h.set('git.checkout', (p) => checkoutRef(needStr(p.cwd) ?? '', needStr(p.ref) ?? '', p.detach === true));
  // ── Hive completo ──
  h.set('hive.patchAgentRole', (_p, core) => core.hive.patchAgentRole(needStr(_p.id) ?? '', needStr(_p.role) ?? ''));
  h.set('hive.renameAgent', (_p, core) => core.hive.renameAgent(needStr(_p.id) ?? '', needStr(_p.name) ?? ''));
  h.set('hive.setAgentHold', (_p, core) => core.hive.setAgentHold(needStr(_p.id) ?? '', _p.hold === true));
  h.set('hive.setArchived', (_p, core) => core.hive.setArchived(needStr(_p.id) ?? '', _p.archived === true));
  h.set('hive.log', (_p, core) => core.hive.logTail(typeof _p.n === 'number' ? _p.n : 200));
  h.set('hive.messages', (_p, core) => core.hive.voiceMessages(((_p.opts ?? {}) as Record<string, unknown>) as never));
  h.set('hive.agentDirectory', (_p, core) => {
    if (!core.hive.enabled()) return { godId: null, agents: [] };
    const reg = core.hive.registry();
    let snap: { usage: Array<{ agentId: string; input: number; output: number; cacheRead: number; cacheCreation: number }>; spans: Record<string, unknown[]> } = { usage: [], spans: {} };
    try { snap = core.telemetry.snapshot() as typeof snap; } catch { /* sin telemetría: directorio igual */ }
    const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
    return {
      godId: reg.godId,
      agents: Object.entries(reg.agents).map(([id, a]) => {
        const u = usageById.get(id);
        return { ...a, id, tokens: u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0 };
      })
    };
  });
  h.set('hive.agentUsage', (p) => (needStr(p.cwd) ? readAgentUsage(needStr(p.cwd) as string) : null));
  h.set('hive.agentContext', (p, core) => {
    const id = needStr(p.id);
    if (!id) return null;
    try {
      const tp = core.hooks.transcriptPath(id);
      if (!tp) return null;
      return readContextTokens(tp) ?? 0;
    } catch {
      return null;
    }
  });
  h.set('hive.addTask', (_p, core) => ({ ok: core.hive.addTask((_p.task ?? {}) as never) }));
  h.set('hive.patchTask', (_p, core) => core.hive.patchTask(needStr(_p.id) ?? '', ((_p.patch ?? {}) as Record<string, unknown>) as never));
  h.set('hive.deleteTask', (_p, core) => core.hive.deleteTask(needStr(_p.id) ?? ''));
  h.set('hive.memoryWakeUp', (p, core) => core.memory.wakeUp(typeof p.wing === 'string' ? p.wing : undefined));
  h.set('hive.mineNow', (p, core) => { void core.memory.mineNow(); return { ok: true }; });
  h.set('hive.reflectNow', () => []);
  h.set('hive.textSearch', (p, core) => {
    const q = needStr(p.query);
    if (!q || !q.trim()) return { ok: false, results: [] };
    const root = core.hive.root();
    if (!root) return { ok: false, results: [] };
    const needle = q.toLowerCase();
    const targets: Array<{ path: string; source: string }> = [
      { path: join(root, 'board.md'), source: 'board.md' },
      { path: join(root, 'tasks.json'), source: 'tasks.json' }
    ];
    const agentsDir = join(root, 'agents');
    if (existsSync(agentsDir)) {
      for (const id of readdirSync(agentsDir)) {
        targets.push({ path: join(agentsDir, id, 'memory.md'), source: `${id}/memory.md` });
      }
    }
    const results: Array<{ source: string; excerpt: string }> = [];
    for (const t of targets) {
      try {
        const text = readFileSync(t.path, 'utf8');
        const idx = text.toLowerCase().indexOf(needle);
        if (idx >= 0 && results.length < 20) {
          results.push({ source: t.source, excerpt: text.slice(Math.max(0, idx - 80), idx + 200) });
        }
      } catch { /* archivo ausente: se salta */ }
    }
    return { ok: true, results };
  });
  // ── Control ──
  h.set('control.snapshot', (p, core) => {
    const id = needStr(p.id);
    return id ? core.control.snapshot(id) : null;
  });
  h.set('control.pause', (p, core) => {
    const id = needStr(p.id);
    if (!id) return null;
    core.control.pause(id, p.on === true);
    return core.control.snapshot(id);
  });
  h.set('control.autoDelivery', (p, core) => {
    const id = needStr(p.id);
    if (!id) return null;
    core.control.pauseAutoDelivery(id, p.paused === true);
    return core.control.snapshot(id);
  });
  h.set('control.resume', (p, core) => {
    const id = needStr(p.id);
    if (!id) return null;
    core.control.resume(id);
    return core.control.snapshot(id);
  });
  h.set('control.gateTool', (p, core) => {
    const id = needStr(p.id);
    const tool = needStr(p.tool);
    if (!id || !tool) return null;
    core.control.gateTool(id, tool, p.on === true);
    return core.control.snapshot(id);
  });
  h.set('control.steer', (p, core) => {
    const id = needStr(p.id);
    if (!id || typeof p.text !== 'string') return null;
    core.control.steer(id, p.text);
    return core.control.snapshot(id);
  });
  h.set('control.halt', (p, core) => {
    const id = needStr(p.id);
    if (!id) return null;
    core.control.halt(id);
    return core.control.snapshot(id);
  });
  h.set('control.setBreakerState', (_p, _core, broadcast) => {
    broadcast?.('control:breakerState', _p.state ?? null);
    return { ok: true };
  });
  // ── Historial ──
  h.set('history.add', (p, core) => {
    if (!core.persist || typeof p.agentId !== 'string' || typeof p.text !== 'string') {
      return { ok: false, error: 'invalid args' };
    }
    core.persist.addHistory({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text });
    return { ok: true };
  });
  h.set('history.list', (p, core) => {
    if (!core.persist) return [];
    return core.persist.listHistory(
      typeof p.agentId === 'string' && p.agentId ? p.agentId : undefined,
      typeof p.limit === 'number' ? p.limit : undefined
    );
  });
  h.set('history.search', (p, core) => {
    if (!core.persist) return [];
    return core.persist.searchHistory(typeof p.query === 'string' ? p.query : '', typeof p.limit === 'number' ? p.limit : undefined);
  });
  // ── Herramientas / catálogos ──
  h.set('tools.status', (_p, core) => {
    const win = process.platform === 'win32';
    const mem = (() => { try { core.memory.resetBinCache(); return core.memory.status(); } catch { return null; } })();
    return toolCatalog().map((spec) => {
      const installCommand = win ? spec.install.win32 : spec.install.posix;
      if (spec.id === 'mempalace') {
        return {
          ...spec, installCommand,
          found: !!mem?.available, path: mem?.bin ?? null,
          detail: mem?.available ? (mem.initialized ? 'palace initialised' : 'installed — palace not built yet') : undefined
        };
      }
      if (!spec.bin) return { ...spec, installCommand, found: false, path: null };
      let path: string | null = null;
      try {
        const resolved = resolveCliCommand(spec.bin);
        if (resolved !== spec.bin && existsSync(resolved)) path = resolved;
      } catch { /* un probe nunca tumba el panel */ }
      return { ...spec, installCommand, found: !!path, path };
    });
  });
  h.set('hero.payload', () => loadHero(join(app.getPath('userData'), 'hero.json'), { force: false }));
  h.set('models.catalog', () => loadModelCatalog(join(app.getPath('userData'), 'model-catalog.json'), { force: false }));
  h.set('skills.local', (p) => {
    const cfg = readConfig();
    const cwds = [...(typeof p.cwd === 'string' && p.cwd ? [p.cwd] : []), ...(cfg.registeredRepos ?? [])];
    try {
      return listLocalSkills({ cwds, bundledDir: null });
    } catch (e) {
      console.error('[skills] local scan failed:', e);
      return [];
    }
  });
  h.set('skills.catalog', () => loadCatalog(join(app.getPath('userData'), 'skill-catalog.json'), { force: false }));
  h.set('skills.install', () => ({ ok: false, error: 'web: installs disabled' }));
  h.set('skills.uninstall', () => ({ ok: false, error: 'web: uninstalls disabled' }));
  // ── Triggers / org / webhooks / historial ──
  h.set('triggers.getContext', () => readConfig().contextTrigger ?? null);
  h.set('triggers.setContext', (p) => {
    const cur = readConfig().contextTrigger ?? {};
    const next = { ...cur, ...((p.trigger ?? {}) as Record<string, unknown>) };
    return writeConfig({ contextTrigger: next as HarnessConfig['contextTrigger'] }).contextTrigger ?? null;
  });
  h.set('org.getTrigger', () => readConfig().orgTrigger ?? DEFAULT_ORG_TRIGGER);
  h.set('org.setTrigger', (p) => writeConfig({ orgTrigger: (p.trigger ?? {}) as HarnessConfig['orgTrigger'] }).orgTrigger ?? null);
  h.set('webhooks.list', () => readConfig().webhookTriggers ?? []);
  h.set('webhooks.save', (p) => {
    const incoming = (Array.isArray(p.triggers) ? p.triggers : []) as WebhookTrigger[];
    const list = incoming.filter((t) => t && typeof t.id === 'string' && t.id.trim());
    writeConfig({ webhookTriggers: list });
    return list;
  });
  h.set('webhooks.delete', (p) => {
    const id = needStr(p.id) ?? '';
    const list = (readConfig().webhookTriggers ?? []).filter((t) => t.id !== id);
    writeConfig({ webhookTriggers: list });
    return list;
  });
  h.set('webhooks.generateSecret', () => randomBytes(32).toString('hex'));
  h.set('webhooks.status', () => ({ running: false, url: undefined, endpoints: [] }));
  h.set('triggerHistory.list', () => { try { return listTriggerHistory(); } catch { return []; } });
  h.set('triggerHistory.decide', () => ({ ok: true }));
  h.set('triggerHistory.clear', () => ({ ok: true }));
  // ── Knowledge ──
  h.set('kg.status', () => knowledge.status());
  h.set('kg.list', () => knowledge.list());
  h.set('kg.search', (p) => {
    if (typeof p.query !== 'string' || !p.query.trim()) return [];
    return knowledge.search(p.query, typeof p.limit === 'number' ? p.limit : undefined);
  });
  h.set('kg.get', (p) => (typeof p.id === 'string' && p.id ? knowledge.get(p.id) : null));
  h.set('kg.remove', (p) => ({ ok: typeof p.id === 'string' && !!p.id && knowledge.remove(p.id as string) }));
  // ── Integraciones: lista redacted real; mutaciones siempre denegadas en web ──
  h.set('integrations.list', () => { try { return listRecordsRedacted(); } catch { return []; } });
  h.set('integrations.templates', () => INTEGRATION_TEMPLATES);
  h.set('integrations.upsert', () => ({ ok: false, error: 'web: read-only' }));
  h.set('integrations.setSecret', () => ({ ok: false, error: 'web: read-only' }));
  h.set('integrations.remove', () => ({ ok: false, error: 'web: read-only' }));
  h.set('integrations.test', () => ({ ok: false, error: 'web: read-only' }));
  h.set('providerKey.has', () => false);
  h.set('providerKey.set', () => ({ ok: false, error: 'web: read-only' }));
  h.set('providerKey.clear', () => ({ ok: false, error: 'web: read-only' }));
  // ── Slack / GitHub: lectura segura; control e ingress por sus vías ──
  h.set('slack.status', () => ({ running: false }));
  h.set('slack.start', () => ({ ok: false, error: 'web: managed on host' }));
  h.set('slack.stop', () => ({ ok: false, error: 'web: managed on host' }));
  h.set('slack.reply', () => ({ ok: false, error: 'web: managed on host' }));
  h.set('slack.replyScriptPath', () => '');
  h.set('slack.setConfig', () => ({ ok: false, error: 'web: managed on host' }));
  h.set('github.issues', () => ({ ok: false, error: 'web: gh CLI not wired' }));
  h.set('github.ciRuns', () => ({ ok: false, error: 'web: gh CLI not wired' }));
  // ── App / roster ──
  h.set('app.info', () => ({ version: app.getVersion(), changelog: '' }));
  h.set('roster.write', (_p, core) => core.roster.write(_p.snap ?? null));
  return h;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function httpErr(code: CthError['code'], message: string, http: number): CthError {
  return { code, message, http };
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  core: CoreServices,
  handlers: Map<string, Handler>,
  broadcast: PushEmit
): Promise<{ data?: unknown; error?: CthError }> {
  const fn = handlers.get(method);
  if (!fn) {
    if (WEB_ELECTRON_ONLY.includes(method)) {
      return { error: err('ERR-W06', `method ${method} is Electron-only`, 501) };
    }
    const known = WEB_V1_INVOKE.some((d) => d.method === method);
    if (!known) return { error: err('ERR-W03', `unknown method ${method}`, 400) };
    return { error: err('ERR-W05', `method ${method} has no web handler yet`, 500) };
  }
  try {
    const data = await fn(params, core, broadcast);
    return { data: data === undefined ? null : data };
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && 'http' in e) {
      return { error: e as CthError };
    }
    return { error: err('ERR-W05', e instanceof Error ? e.message : String(e), 500) };
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const file = resolve(join(staticRoot, rel));
  // Contención: nunca servir fuera de staticRoot.
  if (!file.startsWith(staticRoot)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  const fallback = join(staticRoot, 'index.html');
  const target = existsSync(file) && statSync(file).isFile() ? file : fallback;
  if (!existsSync(target)) {
    // Sin build de renderer (backend puro): JSON informativo, no 404 seco.
    const body = JSON.stringify({
      ok: true,
      mode: 'web',
      version: app.getVersion(),
      ws: WS_PATH,
      note: 'renderer not built; WS API live'
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  try {
    const data = readFileSync(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(500).end('read error');
  }
}

export interface RunningServer {
  server: Server;
  sockets: Set<WebSocket>;
  core: CoreServices;
  broadcast: (channel: string, payload: unknown) => void;
  close: () => Promise<void>;
  port: number;
}

export async function startWebServer(opts?: {
  port?: number;
  host?: string;
  token?: string;
}): Promise<RunningServer> {
  const token = opts?.token ?? expectedToken();
  if (!token) {
    throw new Error('WEB_TOKEN is required (refusing to serve unauthenticated)');
  }
  if (opts?.token) process.env.WEB_TOKEN = opts.token;

  const sockets = new Set<WebSocket>();
  const broadcast: PushEmit = (channel, payload) => {
    if (!matchesPush(channel)) return;
    const evt: CthEvent = { channel, payload };
    const body = JSON.stringify(evt);
    for (const ws of sockets) {
      if (ws.readyState === 1) {
        try { ws.send(body); } catch { /* cliente caído: se limpia en close */ }
      }
    }
  };

  const core = createCore(broadcast);
  startCore(core);
  // missions.save avisa como en Electron (syncMissions → send('missions:updated')).
  const rawBroadcast = broadcast;

  const handlers = buildHandlers();
  // Envoltorio: solo missions.save necesita emitir post-escritura.
  const missionsSave = handlers.get('missions.save');
  if (missionsSave) {
    handlers.set('missions.save', async (p, c) => {
      const r = (await missionsSave(p, c)) as { ok: boolean; error?: string };
      if (r?.ok) rawBroadcast('missions:updated', {});
      return r;
    });
  }

  // Slack reutilizado en su propio puerto (como en Electron); sus mensajes
  // entran al floor por WS en vez de por liveWebContents().
  let slackServer: SlackWebhookServer | null = null;
  try {
    const cfg = readConfig();
    if (cfg.slackEnabled && cfg.slackSigningSecret) {
      slackServer = new SlackWebhookServer({
        port: cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847,
        signingSecret: cfg.slackSigningSecret,
        channelId: cfg.slackChannelId,
        onMessage: (m) => {
          rawBroadcast('slack:incomingMessage', {
            text: m.text,
            channel: m.channel,
            ts: m.ts,
            thread_ts: m.thread_ts
          });
        }
      });
      const r = await slackServer.start();
      if (!r.ok) {
        console.error('[web] slack failed:', r.error);
        slackServer = null;
      } else {
        console.log('[web] slack listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
      }
    }
  } catch (e) {
    console.error('[web] slack bootstrap failed:', e instanceof Error ? e.message : String(e));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        mode: 'web',
        version: app.getVersion(),
        pty: core.ptyAvailable,
        hive: core.hive.enabled()
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/agentes' || !url.pathname.startsWith('/cth'))) {
      if (url.pathname === '/agentes') {
        const agentesFile = join(staticRoot, 'agentes.html');
        if (existsSync(agentesFile)) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(readFileSync(agentesFile));
          return;
        }
      }
      serveStatic(req, res);
      return;
    }
    // Cualquier otra ruta HTTP exige auth (el WS vive en upgrade, abajo).
    const a = checkAuth(req as IncomingMessage);
    if (!a.ok) {
      writeJsonError(res, a.error!);
      return;
    }
    const body = JSON.stringify({ ok: true, mode: 'web', ws: WS_PATH });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const a = checkAuth(req);
    if (!a.ok) {
      const body = JSON.stringify({ ok: false, error: a.error });
      socket.write(
        `HTTP/1.1 ${a.error!.http} ${a.error!.code}\r\n` +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          'Connection: close\r\n\r\n' +
          body
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => { sockets.delete(ws); });
      ws.on('message', (raw) => {
        void (async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(String(raw)) as unknown;
          } catch {
            const r: CthResponse = {
              id: 'unknown',
              ok: false,
              error: err('ERR-W03', 'invalid JSON envelope', 400)
            };
            try { ws.send(JSON.stringify(r)); } catch { /* noop */ }
            return;
          }
          const msg =
            parsed && typeof parsed === 'object'
              ? (parsed as { id?: unknown; method?: unknown; params?: unknown })
              : null;
          if (!msg || typeof msg.id !== 'string' || typeof msg.method !== 'string') {
            const r: CthResponse = {
              id: typeof msg?.id === 'string' ? (msg.id as string) : 'unknown',
              ok: false,
              error: err('ERR-W03', 'envelope needs {id,method,params}', 400)
            };
            try { ws.send(JSON.stringify(r)); } catch { /* noop */ }
            return;
          }
          const params =
            msg.params && typeof msg.params === 'object'
              ? (msg.params as Record<string, unknown>)
              : {};
          const out = await dispatch(msg.method, params, core, handlers, broadcast);
          const r: CthResponse = out.error
            ? { id: msg.id, ok: false, error: out.error }
            : { id: msg.id, ok: true, data: out.data };
          try { ws.send(JSON.stringify(r)); } catch { /* noop */ }
        })();
      });
    });
  });

  const bind = {
    host: opts?.host ?? resolveWebBind().host,
    port: opts?.port ?? resolveWebBind().port
  };
  await new Promise<void>((resolveP, rejectP) => {
    server.once('error', rejectP);
    server.listen(bind.port, bind.host, () => {
      server.off('error', rejectP);
      resolveP();
    });
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : bind.port;
  console.log(`[web] listening on ${bind.host}:${port} (tailnet single-user)`);

  const close = async (): Promise<void> => {
    for (const ws of sockets) {
      try { ws.close(); } catch { /* noop */ }
    }
    sockets.clear();
    try { slackServer?.stop(); } catch { /* noop */ }
    core.stop();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { server, sockets, core, broadcast, close, port };
}

// Entry CLI: `WEB_PORT=8888 WEB_TOKEN=... node out/web/main/server.js`
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('/server.js') || process.argv[1].endsWith('\\server.js'));
if (invokedDirectly) {
  startWebServer().catch((e) => {
    console.error('[web] fatal:', e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
  const shutdown = (): void => {
    // El close real lo hace el test/PM2; aquí basta con salir limpio.
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
