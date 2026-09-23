import { useEffect, useRef } from 'react';
import { useStore, type Agent } from '@/store/store';
import type { HarnessConfig } from '@/store/config';

/**
 * Adopción web-only (spec v1.2, tailnet single-user): el roster vive en el
 * localStorage de CADA browser, así que un browser nuevo vería el piso vacío
 * aunque haya PTYs vivos en el server. Este efecto adopta los agentes vivos
 * del hive (registry + PTYs en vivo) al roster local una vez por carga.
 * En Electron no hace nada (el roster local ya manda).
 */
interface RegistryAgent {
  id: string;
  name?: string;
  role?: string;
  provider?: string;
  status?: string;
  cwd?: string;
  archived?: boolean;
  isGod?: boolean;
  isAssistant?: boolean;
}

interface LivePty {
  id: string;
  cwd: string;
  command: string;
}

const GOD_ID = 'god';
const GOD_PTY = `pty-${GOD_ID}`;

function isWeb(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as { __cthWeb?: boolean }).__cthWeb === true
  );
}

export function useWebAdopt(config: HarnessConfig | null): void {
  const done = useRef(false);
  useEffect(() => {
    if (!isWeb() || done.current) return;
    if (!config?.onboardingComplete) return;
    done.current = true;
    void (async () => {
      try {
        const cth = window.cth;
        const [live, reg] = await Promise.all([
          cth.listPtys().catch(() => [] as LivePty[]),
          cth.hiveRegistry().catch(() => null) as Promise<{ godId?: string | null; agents?: Record<string, RegistryAgent> } | null>,
        ]);
        if (!live.length || !reg?.agents) return;
        const store = useStore.getState();
        const liveIds = new Set(live.map((p) => p.id));
        const ownedPty = new Map<string, string>();
        const resolved = new Map<string, { entry: RegistryAgent; ptyId: string }>();
        for (const p of live) {
          let agentId: string | null = null;
          let entry: RegistryAgent | null = null;
          if (p.id === GOD_PTY && reg.agents[GOD_ID] && !reg.agents[GOD_ID].archived) {
            agentId = GOD_ID;
            entry = reg.agents[GOD_ID];
          } else {
            for (const [id, e] of Object.entries(reg.agents)) {
              if (e.archived) continue;
              if (id === p.id || `pty-${id}` === p.id) {
                agentId = id;
                entry = e;
                break;
              }
            }
          }
          if (!agentId || !entry) continue;
          resolved.set(agentId, { entry, ptyId: p.id });
          ownedPty.set(p.id, agentId);
        }
        // 1) Sanea tarjetas stale: una tarjeta cuyo ptyId vive pero pertenece a
        // otro agente (p. ej. 'pty-god' de antes del split) se elimina; el dueño
        // real se adopta/corrige abajo.
        for (const a of store.agents) {
          if (!a.ptyId || !liveIds.has(a.ptyId)) continue;
          const owner = ownedPty.get(a.ptyId);
          if (owner && owner !== a.id) store.removeAgent(a.id);
        }
        const after = useStore.getState();
        // 2) Adopta faltantes y corrige existentes (isGod/nombre/ptyId pueden
        // venir stale del roster local de una versión anterior del gateway).
        for (const [agentId, { entry, ptyId }] of resolved) {
          const isGod = agentId === GOD_ID || entry.isGod === true;
          const patch = {
            name: entry.name || agentId,
            cwd: entry.cwd || undefined,
            provider: (entry.provider || 'claude') as Agent['provider'],
            isGod,
            isAssistant: entry.isAssistant === true,
            ptyId,
          };
          const current = after.agents.find((a) => a.id === agentId);
          if (current) {
            const needs =
              current.isGod !== patch.isGod ||
              current.ptyId !== patch.ptyId ||
              (patch.name && current.name !== patch.name);
            if (needs) after.updateAgent(agentId, patch);
            if (isGod) {
              after.setGodStatus('ready');
              if (!after.selectedId) after.select(agentId);
            }
            continue;
          }
          const agent: Agent = {
            id: agentId,
            name: patch.name || agentId,
            character: isGod ? 'michael' : 'dwight',
            accent: isGod ? 'lemon' : 'sky',
            description: entry.role || (isGod ? 'god — runs the floor' : 'agent'),
            project: 'hive',
            tmuxTarget: '',
            cwd: entry.cwd || '',
            status: 'idle',
            action: isGod ? 'running the floor' : 'working',
            progress: 0,
            currentStation: 'desk',
            ptyId,
            command: '',
            provider: patch.provider,
            isGod,
            isAssistant: patch.isAssistant,
            recentTextTs: Date.now(),
          };
          after.addAgent(agent);
          if (isGod) {
            after.setGodStatus('ready');
            if (!after.selectedId) after.select(agentId);
          }
        }
      } catch {
        done.current = false;
      }
    })();
  }, [config?.onboardingComplete]);
}
