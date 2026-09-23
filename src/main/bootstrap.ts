/**
 * bootstrap — construcción reutilizable del núcleo headless (spec v1.2 web).
 *
 * Reutiliza las MISMAS clases que src/main/index.ts (PtyManager, HiveManager,
 * HookServer, TelemetryCollector, CircuitBreaker, MemoryManager, PersistStore,
 * …): no duplica ningún manager, solo los instancia con un `emit` hacia WS en
 * vez de hacia liveWebContents(). index.ts queda intacto (cero diff): la ruta
 * Electron sigue siendo canónica y este módulo es la gemela headless.
 *
 * Cobertura del slice: hive+router, PTY (datos vía sink falso de WebContents),
 * hooks, memoria, telemetría. Diferido a hitos siguientes (documentado en
 * server.ts): scheduler syncMissions/syncContextTriggers, reflector, broker de
 * integración, Slack auto-start completo y spawnAgentCore (pty.spawn del slice
 * es terminal cruda, sin registro en hive).
 */
import { createRequire } from 'node:module';
import { app, type WebContents } from 'electron';
import { HiveManager } from './hive';
import { HookServer } from './hooks';
import { CircuitBreaker } from './breaker';
import type { PtyManager } from './pty';
import type { PersistStore } from './db';
import { TelemetryCollector } from './telemetry';
import { ControlRegistry } from './control';
import { MemoryManager } from './memory';
import { RosterStore } from './roster';
import { readConfig, writeConfig, type HarnessConfig, type ScheduledMission } from './config';

/** Origen de harnessHome: env HARNESS_HOME (Docker) gana a config.json. */
export function resolveHarnessHome(): string | null {
  const env = process.env.HARNESS_HOME?.trim();
  if (env) return env;
  try {
    return readConfig().harnessHome ?? null;
  } catch {
    return null;
  }
}

export type PushEmit = (channel: string, payload: unknown) => void;

export interface CoreServices {
  pty: PtyManager | null;
  /** false cuando node-pty no cargó (ABI nativa ausente) → ERR-W07 en spawn. */
  ptyAvailable: boolean;
  hive: HiveManager;
  telemetry: TelemetryCollector;
  control: ControlRegistry;
  breaker: CircuitBreaker;
  memory: MemoryManager;
  roster: RosterStore;
  hooks: HookServer;
  persist: PersistStore | null;
  stop: () => void;
  /** PTY id → agent id (como ptyToAgent en index.ts desktop). El PTY y el
   *  agente pueden tener ids distintos (god: PTY pty-god, agente god). */
  ptyToAgent: Map<string, string>;
}

/**
 * Crea todos los managers. Efectos laterales: NINGUNO (no abre DB, no arranca
 * router/servidores, no spawnea). Ver startCore() para el arranque.
 */
export function createCore(emit: PushEmit): CoreServices {
  const getHome = resolveHarnessHome;
  const hive = new HiveManager(getHome, (channel, payload) => {
    try { emit(channel, payload); } catch { /* un push nunca tumba el core */ }
  });
  const control = new ControlRegistry();
  const telemetry = new TelemetryCollector({
    emit: (channel, payload) => {
      try { emit(channel, payload); } catch { /* idem */ }
    },
    resolveCwd: (agentId) => hive.registry().agents[agentId]?.cwd ?? null,
    resolveSessionId: (agentId) => hive.lastSession(agentId)
  });
  telemetry.onApiError((agentId) => breaker.recordError(agentId));
  const breaker = new CircuitBreaker(() => {
    const c = readConfig();
    return {
      ...(c.circuitBreaker ?? {}),
      costCapUsd: c.costCapUsd,
      costCapTokens: c.costCapTokens,
      agentTokenCaps: c.agentTokenCaps
    };
  });
  const memory = new MemoryManager(getHome, () => {
    const c = readConfig();
    return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' };
  });
  const roster = new RosterStore(getHome);
  const hooks = new HookServer(
    hive,
    () => null,     // headless: sin WebContents; los eventos de hook ya quedan en hive/log
    () => readConfig(),
    control,
    breaker,
    (agentId) => {
      // standingGoalFromRoster (idem index.ts): el roster en disco manda.
      try {
        const snap = roster.read();
        if (!snap || !Array.isArray(snap.agents)) return null;
        for (const entry of snap.agents) {
          if (!entry || typeof entry !== 'object') continue;
          const a = entry as { id?: unknown; goal?: unknown };
          if (a.id !== agentId) continue;
          return typeof a.goal === 'string' && a.goal.trim() ? a.goal.trim() : null;
        }
      } catch { /* roster roto: sin goal, sin caída */ }
      return null;
    }
  );

  // Deps nativas (node-pty, better-sqlite3) con carga perezosa: si el ABI no
  // coincide (Docker sin rebuild) el core SIGUE vivo y el método responde el
  // error contractado en vez de tumbar el proceso al importar.
  const require = createRequire(__filename);
  const ptyToAgent = new Map<string, string>();
  let pty: PtyManager | null = null;
  let ptyAvailable = false;
  try {
    const mod = require('./pty') as { PtyManager: new () => PtyManager };
    pty = new mod.PtyManager();
    ptyAvailable = true;
    // PtyManager.safeSend necesita un WebContents; le damos un sink mínimo que
    // reemite pty:data:<id> / pty:exit:<id> hacia WS (sin ventanas de verdad).
    const sink = {
      send: (channel: string, payload: unknown) => emit(channel, payload),
      isDestroyed: () => false
    } as unknown as WebContents;
    (pty as unknown as { attachWebContents: (wc: WebContents) => void }).attachWebContents(sink);
    pty.setExitHandler((id, exitCode, info) => {
      console.log(`[web] pty exit ${id} code=${exitCode ?? '?'} cmd=${info?.command ?? '?'}`);
      const agentId = ptyToAgent.get(id) ?? id;
      ptyToAgent.delete(id);
      try { hive.setArchived(agentId, true); } catch { /* best-effort */ }
      emit('hive:agentArchived', { id: agentId });
    });
  } catch (e) {
    console.error('[web] node-pty unavailable (ERR-W07 on pty.spawn):', e instanceof Error ? e.message : String(e));
  }

  let persist: PersistStore | null = null;
  try {
    const mod = require('./db') as { PersistStore: new (dbPath?: string) => PersistStore };
    persist = new mod.PersistStore();
  } catch (e) {
    console.error('[web] persist unavailable (history/kv off):', e instanceof Error ? e.message : String(e));
  }

  const stop = (): void => {
    try { hive.stopRouter(); } catch { /* noop */ }
    try { memory.stop(); } catch { /* noop */ }
    try { telemetry.stop(); } catch { /* noop */ }
    try { hooks.stop(); } catch { /* noop */ }
    try { persist?.close(); } catch { /* noop */ }
    try {
      const all = pty as unknown as { killAll?: () => void } | null;
      all?.killAll?.();
    } catch { /* noop */ }
  };

  return { pty, ptyAvailable, hive, telemetry, control, breaker, memory, roster, hooks, persist, stop, ptyToAgent };
}
/** Arranca los servicios ligados al hive. Todo best-effort con log, nunca throw. */
export function startCore(core: CoreServices): void {
  try { core.persist?.open(); } catch (e) {
    console.error('[web] persist.open failed (degraded):', e instanceof Error ? e.message : String(e));
  }
  try {
    core.hive.setRuntimeInfo({
      version: app.getVersion(),
      packaged: app.isPackaged,
      appPath: app.getAppPath()
    });
  } catch { /* stub roto: no bloquea */ }
  try {
    core.hive.setOrchestratorMaySpawn(readConfig().orchestratorMaySpawn === true);
  } catch { /* noop */ }
  if (!core.hive.enabled()) {
    console.log('[web] no harnessHome (config/HARNESS_HOME): hive off, PTY cruda on');
    return;
  }
  try {
    core.hive.ensureHive();
    core.hive.startRouter();
  } catch (e) {
    console.error('[web] hive bootstrap failed:', e instanceof Error ? e.message : String(e));
  }
  try { core.hooks.start(); } catch (e) {
    console.error('[web] hook server failed:', e instanceof Error ? e.message : String(e));
  }
  try { core.memory.start(); } catch (e) {
    console.error('[web] memory failed:', e instanceof Error ? e.message : String(e));
  }
  void core.telemetry.start().then((r) => {
    if (r.ok && r.endpoint) {
      core.hive.setOtelEndpoint(r.endpoint);
      console.log('[web] telemetry', r.endpoint);
    } else if (!r.ok) {
      console.error('[web] telemetry off:', r.error);
    }
  });
}

/**
 * Guarda misiones con el MISMO merge que index.ts (missions:save): lastFiredAt
 * es del scheduler — un array rancio del cliente nunca lo borra.
 * (Sin syncMissions en el slice: el scheduler en vivo es hito posterior.)
 */
export function saveMissions(incoming: unknown): { ok: boolean; error?: string } {
  if (!Array.isArray(incoming)) return { ok: false, error: 'missions must be an array' };
  const list = incoming as ScheduledMission[];
  let current: HarnessConfig;
  try {
    current = readConfig();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const persistedById = new Map((current.missions ?? []).map((m) => [m.id, m] as const));
  const merged = list.map((m) => {
    const prevLastFired = persistedById.get(m.id)?.lastFiredAt ?? 0;
    const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
    return { ...m, lastFiredAt };
  });
  try {
    writeConfig({ missions: merged });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true };
}
