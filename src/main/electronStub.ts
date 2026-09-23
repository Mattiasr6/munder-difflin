/**
 * electronStub — minimal `electron` shim for headless Node (spec v1.2 web mode).
 *
 * src/main/{config,db,hooks,integrations}.ts importan valores de 'electron'
 * arriba del todo; bajo Electron real ese módulo lo provee el runtime. Bajo
 * `node out/web/main/server.js` no existe, así que este módulo intercepta
 * `require('electron')` (Module._load) y devuelve un stub suficiente:
 * app.getPath('userData') / getVersion / isPackaged / getAppPath + Notification
 * no-op (headless nunca notifica) + safeStorage degradado.
 *
 * Debe importarse ANTES que cualquier otro módulo de src/main (server.ts lo
 * pone en la primera línea): los `require` CommonJS se evalúan en orden, así
 * que el parche queda activo antes de que config.ts/db.ts carguen 'electron'.
 * Solo afecta al proceso headless; el bundle Electron (electron-vite) no lo
 * incluye y sigue usando el 'electron' real.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

function userDataDir(): string {
  const override = process.env.MD_USERDATA?.trim();
  if (override) return override;
  return join(homedir(), '.config', 'munder-difflin');
}

function appVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  // server compilado vive en out/web/main/ → package.json dos niveles arriba.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, 'package.json');
    try {
      if (existsSync(cand)) {
        const pkg = JSON.parse(readFileSync(cand, 'utf8')) as { version?: unknown };
        if (typeof pkg.version === 'string') return pkg.version;
      }
    } catch { /* sigue subiendo */ }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return '0.0.0-web';
}

class StubNotification {
  static isSupported(): boolean { return false; }
  constructor(_opts?: unknown) { /* headless: nunca se muestra */ }
  show(): void { /* noop */ }
}

const stubApp = {
  getPath: (name: string): string => {
    if (name === 'userData') return userDataDir();
    if (name === 'home') return homedir();
    return join(userDataDir(), name);
  },
  getVersion: (): string => appVersion(),
  getAppPath: (): string => process.cwd(),
  isPackaged: false,
  whenReady: (): Promise<void> => Promise.resolve(),
  on: (): void => { /* noop */ },
  once: (): void => { /* noop */ },
  quit: (): void => { process.exit(0); },
  exit: (code = 0): void => { process.exit(code); }
};

const stubSafeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (): Buffer => { throw new Error('safeStorage unavailable headless'); },
  decryptString: (): Buffer => { throw new Error('safeStorage unavailable headless'); }
};

const electronStub: Record<string, unknown> = {
  app: stubApp,
  Notification: StubNotification,
  safeStorage: stubSafeStorage
};

let installed = false;

/** Activa el stub. Idempotente; solo intercepta el id exacto 'electron'. */
export function installElectronStub(): Record<string, unknown> {
  if (installed) return electronStub;
  installed = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require('node:module') as {
      _load: (request: string, ...rest: unknown[]) => unknown;
    };
    const origLoad = Module._load.bind(Module);
    Module._load = function (request: string, ...rest: unknown[]): unknown {
      if (request === 'electron') return electronStub;
      return origLoad(request, ...rest);
    };
  } catch { /* ESM puro u otro loader: el caller verá el error real */ }
  return electronStub;
}

// Efecto lateral a propósito: basta con `import './electronStub'` en la
// primera línea del entry headless para que el parche preceda a todo require.
installElectronStub();

export { electronStub };
