// Cliente web del contrato src/shared/webBridge.ts (spec v1.2).
// - Electron: delega en window.cth (modo intacto).
// - Web headless: WebSocket al gateway tailnet con reconnect/backoff, eco id y timeout ERR-W08.
// Métodos de WEB_ELECTRON_ONLY se rechazan en cliente con ERR-W06 sin tocar la red.
import {
  WEB_DEFAULT_PORT,
  WEB_ELECTRON_ONLY,
  WEB_TAILNET_IP,
  type CthError,
  type CthEvent,
  type CthResponse,
  type WebErrorCode,
} from '@shared/webBridge';

export type { CthError };
export type Unsub = () => void;

const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const TOKEN_KEY = 'cth.token';
const URL_KEY = 'cth.wsUrl';

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cthError(code: WebErrorCode, message: string, http: number): CthError {
  return { code, message, http };
}

/** Subconjunto de window.cth usado por la tabla WEB_V1_INVOKE. */
interface NativeCth {
  spawnPty: (opts: Record<string, unknown>) => Promise<unknown>;
  writePty: (id: string, data: string) => Promise<unknown>;
  resizePty: (id: string, cols: number, rows: number) => Promise<unknown>;
  redrawPty: (id: string) => Promise<unknown>;
  killPty: (id: string) => Promise<unknown>;
  listPtys: () => Promise<unknown>;
  resolveSessionCwd: (sessionId: string) => Promise<unknown>;
  hiveRegistry: () => Promise<unknown>;
  hiveBoard: () => Promise<unknown>;
  hiveTasks: () => Promise<unknown>;
  hiveMemory: (id: string) => Promise<unknown>;
  hiveInbox: (id: string) => Promise<unknown>;
  hiveSend: (msg: unknown, from?: string) => Promise<unknown>;
  memoryStatus: () => Promise<unknown>;
  searchMemory: (query: string) => Promise<unknown>;
  listMissions: () => Promise<unknown>;
  saveMissions: (missions: unknown) => Promise<unknown>;
  telemetryUsage: (agentId: string) => Promise<unknown>;
  telemetrySnapshot: () => Promise<unknown>;
  gitStatus: (cwd: string) => Promise<unknown>;
  gitWorktrees: (cwd: string) => Promise<unknown>;
  gitBranches: (cwd: string) => Promise<unknown>;
  gitLog: (cwd: string, n?: number) => Promise<unknown>;
  onPtyData: (id: string, cb: (data: string) => void) => Unsub;
  onPtyExit: (id: string, cb: (info: unknown) => void) => Unsub;
  onPtyRelaunch: (id: string, cb: () => void) => Unsub;
  onHiveAgentSpawned: (cb: (e: unknown) => void) => Unsub;
  onHiveAgentArchived: (cb: (e: unknown) => void) => Unsub;
  onMissionsUpdated: (cb: () => void) => Unsub;
  onContextTrigger: (cb: (e: unknown) => void) => Unsub;
}

function getNative(): NativeCth | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { cth?: NativeCth; __cthWeb?: boolean };
  if (w.__cthWeb) return null;
  const cth = w.cth;
  return cth && typeof cth.spawnPty === 'function' ? cth : null;
}

/** method -> [fn, orden de params] para delegación Electron. */
function nativeCall(native: NativeCth, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'pty.spawn': return native.spawnPty((params.opts ?? {}) as Record<string, unknown>);
    case 'pty.write': return native.writePty(String(params.id), String(params.data ?? ''));
    case 'pty.resize': return native.resizePty(String(params.id), Number(params.cols), Number(params.rows));
    case 'pty.redraw': return native.redrawPty(String(params.id));
    case 'pty.kill': return native.killPty(String(params.id));
    case 'pty.list': return native.listPtys();
    case 'session.resolveCwd': return native.resolveSessionCwd(String(params.sessionId));
    case 'hive.registry': return native.hiveRegistry();
    case 'hive.board': return native.hiveBoard();
    case 'hive.tasks': return native.hiveTasks();
    case 'hive.memory': return native.hiveMemory(String(params.id));
    case 'hive.inbox': return native.hiveInbox(String(params.id));
    case 'hive.send': return native.hiveSend(params.msg, params.from as string | undefined);
    case 'hive.memoryStatus': return native.memoryStatus();
    case 'hive.searchMemory': return native.searchMemory(String(params.query));
    case 'missions.list': return native.listMissions();
    case 'missions.save': return native.saveMissions(params.missions);
    case 'telemetry.usage': return native.telemetryUsage(String(params.agentId));
    case 'telemetry.snapshot': return native.telemetrySnapshot();
    case 'git.status': return native.gitStatus(String(params.cwd));
    case 'git.worktrees': return native.gitWorktrees(String(params.cwd));
    case 'git.branches': return native.gitBranches(String(params.cwd));
    case 'git.log': return native.gitLog(String(params.cwd), params.limit as number | undefined);
    default:
      return Promise.reject(cthError('ERR-W03', `unknown method: ${method}`, 400));
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: CthError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Saca ?token= de la URL, lo guarda en sessionStorage y lo borra de la barra.
 *  Permite entrar con un link sin tocar la consola. Devuelve el token o ''. */
export function consumeUrlToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    const q = new URLSearchParams(window.location.search).get('token')?.replace(/\s+/g, '') ?? '';
    if (!q) return '';
    try {
      window.sessionStorage.setItem(TOKEN_KEY, q);
    } catch { /* sin storage: se usa solo esta vez */ }
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.toString());
    return q;
  } catch {
    return '';
  }
}

export function defaultWsUrl(): string {  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(URL_KEY);
      if (saved) return saved;
    } catch { /* sin storage — usa default */ }
  }
  return `ws://${WEB_TAILNET_IP}:${WEB_DEFAULT_PORT}/cth/v1`;
}

export class CthApi {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wantClose = false;

  /** true cuando delega en el preload Electron (sin WS). */
  get isElectron(): boolean {
    return getNative() !== null;
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (WEB_ELECTRON_ONLY.includes(method)) {
      return Promise.reject(cthError('ERR-W06', `electron-only method: ${method}`, 501));
    }
    const native = getNative();
    if (native) {
      return nativeCall(native, method, params) as Promise<T>;
    }
    return this.wsRequest<T>(method, params);
  }

  on(channel: string, cb: (payload: unknown) => void): Unsub {
    const native = getNative();
    if (native) return this.nativeOn(native, channel, cb);
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(cb);
    this.ensureConnected();
    return () => {
      const s = this.listeners.get(channel);
      if (s) {
        s.delete(cb);
        if (s.size === 0) this.listeners.delete(channel);
      }
    };
  }

  close(): void {
    this.wantClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  // ── WS ──

  private wsRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.ensureConnected();
    const id = newId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(cthError('ERR-W08', `request timeout: ${method}`, 504));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v: unknown) => resolve(v as T),
        reject,
        timer,
      });
      const send = (): void => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ id, method, params }));
        } else {
          // Sin socket aún: el timeout ERR-W08 manda si nunca conecta.
          const retry = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              clearInterval(retry);
              if (this.pending.has(id)) this.ws?.send(JSON.stringify({ id, method, params }));
            } else if (!this.pending.has(id)) {
              clearInterval(retry);
            }
          }, 250);
        }
      };
      send();
    });
  }

  private ensureConnected(): void {
    if (typeof window === 'undefined') return;
    if (getNative()) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.wantClose = false;
    const url = this.buildUrl();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.reconnects = 0;
    };
    ws.onmessage = (ev: MessageEvent) => this.dispatch(ev.data);
    ws.onclose = () => {
      this.ws = null;
      if (!this.wantClose) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose sigue y reintenta con backoff.
    };
  }

  private buildUrl(): string {
    const base = defaultWsUrl();
    if (typeof window === 'undefined') return base;
    let token = consumeUrlToken();
    if (!token) {
      try {
        token = window.sessionStorage.getItem(TOKEN_KEY) ?? '';
      } catch { /* sin storage */ }
    }
    if (!token) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}token=${encodeURIComponent(token)}`;
  }

  private scheduleReconnect(): void {
    if (this.wantClose || typeof window === 'undefined') return;
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnects, RECONNECT_MAX_MS);
    this.reconnects += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, delay);
  }

  private dispatch(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: CthResponse & CthEvent;
    try {
      msg = JSON.parse(raw) as CthResponse & CthEvent;
    } catch {
      return;
    }
    // Respuesta a request (eco id).
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(msg.error ?? cthError('ERR-W05', 'handler error', 500));
      }
      return;
    }
    // Push WEB_V1_PUSH {channel, payload}.
    if (msg.channel) {
      const exact = this.listeners.get(msg.channel);
      if (exact) for (const cb of [...exact]) cb(msg.payload);
      // Prefijos pty:data: / pty:exit: / pty:relaunch:.
      for (const [key, set] of this.listeners) {
        if (key !== msg.channel && key.endsWith(':') && msg.channel.startsWith(key)) {
          for (const cb of [...set]) cb(msg.payload);
        }
      }
    }
  }

  /** Suscripciones push en modo Electron (canales WEB_V1_PUSH). */
  private nativeOn(native: NativeCth, channel: string, cb: (payload: unknown) => void): Unsub {
    if (channel.startsWith('pty:data:')) {
      const id = channel.slice('pty:data:'.length);
      return id ? native.onPtyData(id, (d) => cb(d)) : () => undefined;
    }
    if (channel.startsWith('pty:exit:')) {
      const id = channel.slice('pty:exit:'.length);
      return id ? native.onPtyExit(id, (info) => cb(info)) : () => undefined;
    }
    if (channel.startsWith('pty:relaunch:')) {
      const id = channel.slice('pty:relaunch:'.length);
      return id ? native.onPtyRelaunch(id, () => cb(undefined)) : () => undefined;
    }
    switch (channel) {
      case 'hive:agentSpawned': return native.onHiveAgentSpawned((e) => cb(e));
      case 'hive:agentArchived': return native.onHiveAgentArchived((e) => cb(e));
      case 'missions:updated': return native.onMissionsUpdated(() => cb(undefined));
      case 'trigger:context': return native.onContextTrigger((e) => cb(e));
      default: return () => undefined;
    }
  }
}

/** Singleton para las vistas. */
export const cth = new CthApi();
