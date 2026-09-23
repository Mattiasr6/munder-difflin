// Vista /agentes "Mis agentes" (spec v1.2): Floor + Worktrees + Hive + terminal live.
// Consume el contrato src/shared/webBridge.ts vía api/cthClient (WS o window.cth).
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { cth } from '@/api/cthClient';
import type { FleetCard, FleetSnapshot } from '@shared/webBridge';
import { PtyTerminalView } from '@/components/PtyTerminalView';
// Pixi solo existe en el bundle cuando corre en Electron: lazy para que el
// entry web /agentes no arrastre la escena (ni falle si Pixi no carga en browser).
const OfficeFloor = lazy(() =>
  import('@/scene/office/OfficeFloor').then((m) => ({ default: m.OfficeFloor }))
);

type UiState = 'loading' | 'empty' | 'error' | 'success';

interface RegistryAgent {
  id: string;
  name?: string;
  role?: string;
  provider?: string;
  status?: string;
  cwd?: string;
}

interface Worktree {
  path?: string;
  branch?: string;
  bare?: boolean;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const panelStyle: CSSProperties = {
  background: 'var(--cth-paper-100)',
  border: '1px solid var(--cth-ink-300)',
  borderRadius: 4,
  padding: 12,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  overflow: 'auto',
};

const hStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--cth-font-display)',
  fontSize: 11,
  color: 'var(--cth-ink-500)',
};

/** Terminal live para modo web: xterm mínimo cableado a cthClient (sin pool). */
function WebLiveTerminal({ ptyId }: { ptyId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({ fontSize: 13, cursorBlink: true, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    const unsubData = cth.on(`pty:data:${ptyId}`, (payload) => {
      term.write(str(payload));
    });
    const unsubExit = cth.on(`pty:exit:${ptyId}`, () => {
      term.writeln('\r\n─ process exited ─');
    });
    const disp = term.onData((data) => {
      void cth.request('pty.write', { id: ptyId, data }).catch(() => undefined);
    });
    const onResize = (): void => {
      try {
        fit.fit();
        void cth.request('pty.resize', { id: ptyId, cols: term.cols, rows: term.rows }).catch(() => undefined);
      } catch { /* host colapsado */ }
    };
    window.addEventListener('resize', onResize);
    void cth.request('pty.resize', { id: ptyId, cols: term.cols, rows: term.rows }).catch(() => undefined);
    return () => {
      window.removeEventListener('resize', onResize);
      unsubData();
      unsubExit();
      disp.dispose();
      term.dispose();
    };
  }, [ptyId]);

  return <div ref={hostRef} style={{ width: '100%', height: 280, background: '#111' }} />;
}

const PROVIDERS = ['opencode', 'gemini', 'copilot', 'agy', 'claude', 'codex', 'qwen'];

function AddAgentForm({ cwdDefault, onSpawned }: { cwdDefault: string; onSpawned: (ptyId: string) => void }) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('opencode');
  const [cwd, setCwd] = useState(cwdDefault);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const spawn = async (): Promise<void> => {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    setErr('');
    try {
      const slug = clean.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 24) || 'agent';
      const id = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
      const res = await cth.request<{ ptyId?: string; seedPrompt?: string | null }>('hive.spawn', {
        agent: { id, name: clean, provider, cwd: cwd.trim() || '.', role: 'agent' },
      });
      if (res.seedPrompt) {
        setTimeout(() => {
          void cth.request('pty.write', { id, data: `${res.seedPrompt}\r` }).catch(() => undefined);
        }, 2000);
      }
      onSpawned(res.ptyId ?? id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'spawn failed');
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void spawn(); }}
        placeholder="Agent name (e.g. Pam)"
        aria-label="Agent name"
        style={{ padding: 6 }}
      />
      <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
        {PROVIDERS.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
      <input
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        placeholder="Working dir"
        aria-label="Working dir"
        style={{ padding: 6, minWidth: 220 }}
      />
      <button type="button" onClick={() => void spawn()} disabled={busy || !name.trim()}>
        {busy ? 'Spawning…' : 'Add agent'}
      </button>
      {err ? <span role="alert">{err}</span> : null}
    </div>
  );
}

export function MisAgentes() {
  const [ui, setUi] = useState<UiState>('loading');
  const [error, setError] = useState('');
  const [cwd, setCwd] = useState('.');
  const [registry, setRegistry] = useState<RegistryAgent[]>([]);
  const [board, setBoard] = useState('');
  const [tasks, setTasks] = useState<unknown[]>([]);
  const [inbox, setInbox] = useState<unknown[]>([]);
  const [memory, setMemory] = useState('');
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [gitStatus, setGitStatus] = useState('');
  const [branches, setBranches] = useState<unknown[]>([]);
  const [gitLog, setGitLog] = useState<unknown[]>([]);
  const [fleet, setFleet] = useState<FleetCard[]>([]);
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [isElectron] = useState(() => cth.isElectron);

  const load = useCallback(async () => {
    setUi('loading');
    setError('');
    try {
      const reg = await cth.request<unknown>('hive.registry');
      const raw = (reg as { agents?: unknown } | null)?.agents ?? reg;
      const agents: RegistryAgent[] = Array.isArray(raw)
        ? raw.map((a, i) => ({ ...((a as object) ?? {}), id: str((a as RegistryAgent).id, `agent-${i}`) }))
        : Object.entries((raw as Record<string, RegistryAgent>) ?? {}).map(([id, a]) => ({ ...a, id }));
      const firstCwd = agents.find((a) => a.cwd)?.cwd ?? '.';
      setRegistry(agents);
      setCwd(firstCwd);
      const [boardRes, tasksRes, fleetRes, wtRes, stRes, brRes, logRes] = await Promise.all([
        cth.request<string>('hive.board').catch(() => ''),
        cth.request<unknown>('hive.tasks').catch(() => []),
        cth.request<FleetSnapshot>('telemetry.snapshot').catch(() => null),
        cth.request<unknown>('git.worktrees', { cwd: firstCwd }).catch(() => []),
        cth.request<unknown>('git.status', { cwd: firstCwd }).catch(() => ''),
        cth.request<unknown>('git.branches', { cwd: firstCwd }).catch(() => []),
        cth.request<unknown>('git.log', { cwd: firstCwd, limit: 20 }).catch(() => []),
      ]);
      setBoard(str(boardRes));
      const taskList = (tasksRes as { tasks?: unknown }).tasks ?? tasksRes;
      setTasks(asArray(taskList));
      setFleet(fleetRes?.agents ?? []);
      setWorktrees(asArray(wtRes) as Worktree[]);
      setGitStatus(typeof stRes === 'string' ? stRes : JSON.stringify(stRes));
      setBranches(asArray(brRes));
      setGitLog(asArray(logRes));
      const hasAnything =
        agents.length > 0 || asArray(taskList).length > 0 || (fleetRes?.agents ?? []).length > 0;
      setUi(hasAnything ? 'success' : 'empty');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
      setUi('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Push: refresca fleet/inbox ante eventos del gateway.
  useEffect(() => {
    const unsubs = [
      cth.on('hive:agentSpawned', () => void load()),
      cth.on('hive:agentArchived', () => void load()),
      cth.on('missions:updated', () => void load()),
      cth.on('control:snapshot', () => void load()),
    ];
    return () => unsubs.forEach((u) => u());
  }, [load]);

  const spawnShell = useCallback(async () => {
    try {
      const res = await cth.request<{ id?: string }>('pty.spawn', {
        opts: { cwd, command: 'bash', args: [], cols: 100, rows: 30 },
      });
      const id = str((res as { id?: unknown }).id);
      if (id) setPtyId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'pty.spawn failed');
      setUi('error');
    }
  }, [cwd]);

  const onSpawned = useCallback((id: string) => {
    setPtyId(id);
    void load();
  }, [load]);

  const openInbox = useCallback(async (agentId: string) => {    try {
      const box = await cth.request<unknown>('hive.inbox', { id: agentId });
      setInbox(asArray(box));
      const mem = await cth.request<unknown>('hive.memory', { id: agentId }).catch(() => '');
      setMemory(str(mem));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'inbox failed');
    }
  }, []);

  if (ui === 'loading') {
    return (
      <div style={{ padding: 24 }}>
        <p>Loading agents…</p>
      </div>
    );
  }

  if (ui === 'error') {
    const resetToken = (): void => {
      try {
        window.sessionStorage.removeItem('cth.token');
      } catch { /* sin storage: recarga igual */ }
      window.location.reload();
    };
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p role="alert">Couldn&apos;t reach the hive: {error}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => void load()}>Retry</button>
          <button type="button" onClick={resetToken}>Usar otro token</button>
        </div>
      </div>
    );
  }

  if (ui === 'empty') {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p>No agents on the floor yet.</p>
        <AddAgentForm cwdDefault={cwd} onSpawned={onSpawned} />
        <button type="button" onClick={() => void load()}>Refresh</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, height: '100vh', overflow: 'auto' }}>
      <h1 style={{ margin: 0 }}>Mis agentes {isElectron ? '(electron)' : '(web)'}</h1>
      <AddAgentForm cwdDefault={cwd} onSpawned={onSpawned} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, alignItems: 'start' }}>
        <section style={panelStyle} aria-label="Floor">
          <h2 style={hStyle}>FLOOR</h2>
          {isElectron ? (
            <Suspense fallback={<p style={{ margin: 0 }}>Loading floor…</p>}>
              <OfficeFloor />
            </Suspense>
          ) : (
            <p style={{ margin: 0 }}>
              Floor scene runs in Electron.{' '}
              <a href="#/">Open the floor</a> or manage agents below.
            </p>
          )}
          <ul>
            {registry.map((a) => (
              <li key={a.id}>
                {a.name ?? a.id} — {a.role ?? a.status ?? 'agent'}{' '}
                <button type="button" onClick={() => void openInbox(a.id)}>inbox</button>
              </li>
            ))}
          </ul>
        </section>

        <section style={panelStyle} aria-label="Worktrees">
          <h2 style={hStyle}>WORKTREES ({str(cwd)})</h2>
          <ul>
            {worktrees.map((w, i) => (
              <li key={w.path ?? i}>{w.path} — {w.branch}</li>
            ))}
          </ul>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{gitStatus}</pre>
          <h3 style={hStyle}>BRANCHES</h3>
          <ul>
            {branches.map((b, i) => (
              <li key={i}>{typeof b === 'string' ? b : JSON.stringify(b)}</li>
            ))}
          </ul>
          <h3 style={hStyle}>LOG</h3>
          <ul>
            {gitLog.map((c, i) => (
              <li key={i}>{typeof c === 'string' ? c : JSON.stringify(c)}</li>
            ))}
          </ul>
        </section>

        <section style={panelStyle} aria-label="Hive">
          <h2 style={hStyle}>HIVE</h2>
          <h3 style={hStyle}>FLEET</h3>
          <ul>
            {fleet.map((f) => (
              <li key={f.id}>
                {f.name} — {f.status} — ${f.costUsd} — {f.tokens}tok — inbox {f.inboxBacklog}
              </li>
            ))}
          </ul>
          <h3 style={hStyle}>BOARD</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{board.slice(0, 2000)}</pre>
          <h3 style={hStyle}>TASKS ({tasks.length})</h3>
          <ul>
            {tasks.slice(0, 20).map((t, i) => (
              <li key={i}>{typeof t === 'string' ? t : JSON.stringify(t)}</li>
            ))}
          </ul>
          <h3 style={hStyle}>INBOX ({inbox.length})</h3>
          <ul>
            {inbox.slice(0, 20).map((m, i) => (
              <li key={i}>{typeof m === 'string' ? m : JSON.stringify(m)}</li>
            ))}
          </ul>
          {memory ? (
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{memory.slice(0, 2000)}</pre>
          ) : null}
        </section>
      </div>

      <section style={panelStyle} aria-label="Terminal">
        <h2 style={hStyle}>TERMINAL</h2>
        {!ptyId ? (
          <button type="button" onClick={() => void spawnShell()}>Spawn shell</button>
        ) : isElectron ? (
          <PtyTerminalView ptyId={ptyId} />
        ) : (
          <WebLiveTerminal ptyId={ptyId} />
        )}
      </section>
    </div>
  );
}
