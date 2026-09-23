// Contrato único main <-> web para el modo headless tailnet (spec v1.2).
// Fuente de verdad para webBridge (server) y cthClient (renderer).
// Convenciones copiadas de src/preload/index.ts: invoke(channel, ...args),
// subscripciones por canal `pty:data:<id>` / `pty:exit:<id>` / push `hive:*`.

export const WEB_DEFAULT_HOST = '0.0.0.0';
export const WEB_DEFAULT_PORT = 8888;
export const WEB_TAILNET_IP = '100.78.144.4';

export interface CthRequest {
  id: string; // uuid v4, eco en la respuesta
  method: string; // uno de WEB_V1_INVOKE[].method
  params: Record<string, unknown>; // args posicionales del invoke, nombrados
}

export interface CthError {
  code: WebErrorCode;
  message: string;
  http: number;
}

export interface CthResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: CthError;
}

export interface CthEvent {
  channel: string;
  payload: unknown;
}

export type WebErrorCode =
  | 'ERR-W01' // 401 token ausente/inválido
  | 'ERR-W02' // 403 Host/Origin no tailnet
  | 'ERR-W03' // 400 method/params inválidos
  | 'ERR-W04' // 403 Slack HMAC/replay falla (slack.ts existente)
  | 'ERR-W05' // 500 handler interno lanza
  | 'ERR-W06' // 501 método solo-Electron no portado
  | 'ERR-W07' // 503 node-pty no disponible
  | 'ERR-W08' // 408/504 WS caído (cliente: auto-reconnect)
  | 'ERR-W09'; // 429 rate-limit excedido

/** Tabla v1: método WS -> canal ipcMain existente + orden de args. */
export interface WebMethodDef {
  method: string;
  channel: string;
  args: string[]; // nombres de params, en orden posicional del invoke
}

export const WEB_V1_INVOKE: WebMethodDef[] = [
  // ── PTY (paridad total v1) ──
  { method: 'pty.spawn', channel: 'pty:spawn', args: ['opts'] },
  { method: 'pty.write', channel: 'pty:write', args: ['id', 'data'] },
  { method: 'pty.resize', channel: 'pty:resize', args: ['id', 'cols', 'rows'] },
  { method: 'pty.redraw', channel: 'pty:redraw', args: ['id'] },
  { method: 'pty.kill', channel: 'pty:kill', args: ['id'] },
  { method: 'pty.list', channel: 'pty:list', args: [] },
  { method: 'session.resolveCwd', channel: 'session:resolveCwd', args: ['sessionId'] },
  // ── Hive (lectura + send v1) ──
  { method: 'hive.registry', channel: 'hive:registry', args: [] },
  { method: 'hive.board', channel: 'hive:board', args: [] },
  { method: 'hive.tasks', channel: 'hive:tasks', args: [] },
  { method: 'hive.memory', channel: 'hive:memory', args: ['id'] },
  { method: 'hive.inbox', channel: 'hive:inbox', args: ['id'] },
  { method: 'hive.send', channel: 'hive:send', args: ['msg', 'from'] },
  { method: 'hive.memoryStatus', channel: 'hive:memoryStatus', args: [] },
  { method: 'hive.searchMemory', channel: 'hive:searchMemory', args: ['query'] },
  { method: 'hive.spawn', channel: 'hive:spawn', args: ['agent'] },  // ── Scheduler / triggers ──
  { method: 'missions.list', channel: 'missions:list', args: [] },
  { method: 'missions.save', channel: 'missions:save', args: ['missions'] },
  // ── Config / FS / Git completo ──
  { method: 'config.get', channel: 'config:get', args: [] },
  { method: 'config.update', channel: 'config:update', args: ['patch'] },
  { method: 'config.setAgentTokenCap', channel: 'config:setAgentTokenCap', args: ['id', 'cap'] },
  { method: 'config.ensureHome', channel: 'config:ensureHome', args: [] },
  { method: 'config.changeHome', channel: 'config:changeHome', args: [] },
  { method: 'fs.listDir', channel: 'fs:listDir', args: ['root', 'rel'] },
  { method: 'fs.readFile', channel: 'fs:readFile', args: ['root', 'rel'] },
  { method: 'fs.readBinary', channel: 'fs:readBinary', args: ['root', 'rel'] },
  { method: 'fs.writeFile', channel: 'fs:writeFile', args: ['root', 'rel', 'text'] },
  { method: 'fs.statAbs', channel: 'fs:statAbs', args: ['path'] },
  { method: 'git.isRepo', channel: 'git:isRepo', args: ['cwd'] },
  { method: 'git.mainRepo', channel: 'git:mainRepo', args: ['cwd'] },
  { method: 'git.branch', channel: 'git:branch', args: ['cwd'] },
  { method: 'git.aheadBehind', channel: 'git:aheadBehind', args: ['cwd'] },
  { method: 'git.diff', channel: 'git:diff', args: ['cwd', 'relPath'] },
  { method: 'git.logGraph', channel: 'git:logGraph', args: ['cwd', 'n', 'skip'] },
  { method: 'git.commitFiles', channel: 'git:commitFiles', args: ['cwd', 'sha'] },
  { method: 'git.showFile', channel: 'git:showFile', args: ['cwd', 'rev', 'relPath'] },
  { method: 'git.compareRefs', channel: 'git:compareRefs', args: ['cwd', 'base', 'head', 'mode'] },
  { method: 'git.checkout', channel: 'git:checkout', args: ['cwd', 'ref', 'detach'] },
  // ── Hive completo ──
  { method: 'hive.patchAgentRole', channel: 'hive:patchAgentRole', args: ['id', 'role'] },
  { method: 'hive.renameAgent', channel: 'hive:renameAgent', args: ['id', 'name'] },
  { method: 'hive.setAgentHold', channel: 'hive:setAgentHold', args: ['id', 'hold'] },
  { method: 'hive.setArchived', channel: 'hive:setArchived', args: ['id', 'archived'] },
  { method: 'hive.log', channel: 'hive:log', args: ['n'] },
  { method: 'hive.messages', channel: 'hive:messages', args: ['opts'] },
  { method: 'hive.agentDirectory', channel: 'hive:agentDirectory', args: [] },
  { method: 'hive.agentUsage', channel: 'hive:agentUsage', args: ['cwd'] },
  { method: 'hive.agentContext', channel: 'hive:agentContext', args: ['id'] },
  { method: 'hive.addTask', channel: 'hive:addTask', args: ['task'] },
  { method: 'hive.patchTask', channel: 'hive:patchTask', args: ['id', 'patch'] },
  { method: 'hive.deleteTask', channel: 'hive:deleteTask', args: ['id'] },
  { method: 'hive.memoryWakeUp', channel: 'hive:memoryWakeUp', args: ['wing'] },
  { method: 'hive.mineNow', channel: 'hive:mineNow', args: [] },
  { method: 'hive.reflectNow', channel: 'hive:reflectNow', args: ['id'] },
  { method: 'hive.textSearch', channel: 'hive:textSearch', args: ['query'] },
  // ── Control / historial / catálogos ──
  { method: 'control.snapshot', channel: 'control:snapshot', args: ['id'] },
  { method: 'control.pause', channel: 'control:pause', args: ['id', 'on'] },
  { method: 'control.autoDelivery', channel: 'control:autoDelivery', args: ['id', 'paused'] },
  { method: 'control.resume', channel: 'control:resume', args: ['id'] },
  { method: 'control.gateTool', channel: 'control:gateTool', args: ['id', 'tool', 'on'] },
  { method: 'control.steer', channel: 'control:steer', args: ['id', 'text'] },
  { method: 'control.halt', channel: 'control:halt', args: ['id'] },
  { method: 'control.setBreakerState', channel: 'control:setBreakerState', args: ['state'] },
  { method: 'history.add', channel: 'history:add', args: ['agentId', 'cwd', 'text'] },
  { method: 'history.list', channel: 'history:list', args: ['agentId', 'limit'] },
  { method: 'history.search', channel: 'history:search', args: ['query', 'limit'] },
  { method: 'tools.status', channel: 'tools:status', args: [] },
  { method: 'hero.payload', channel: 'hero:payload', args: [] },
  { method: 'models.catalog', channel: 'models:catalog', args: [] },
  { method: 'skills.local', channel: 'skills:local', args: ['cwd'] },
  { method: 'skills.catalog', channel: 'skills:catalog', args: ['force'] },
  { method: 'kg.status', channel: 'kg:status', args: [] },
  { method: 'kg.list', channel: 'kg:list', args: [] },
  { method: 'kg.search', channel: 'kg:search', args: ['query', 'limit'] },
  { method: 'kg.get', channel: 'kg:get', args: ['id'] },
  { method: 'kg.remove', channel: 'kg:remove', args: ['id'] },
  { method: 'triggers.getContext', channel: 'triggers:getContext', args: [] },
  { method: 'triggers.setContext', channel: 'triggers:setContext', args: ['trigger'] },
  { method: 'org.getTrigger', channel: 'org:getTrigger', args: [] },
  { method: 'org.setTrigger', channel: 'org:setTrigger', args: ['trigger'] },
  { method: 'webhooks.list', channel: 'webhooks:list', args: [] },
  { method: 'webhooks.save', channel: 'webhooks:save', args: ['triggers'] },
  { method: 'webhooks.delete', channel: 'webhooks:delete', args: ['id'] },
  { method: 'webhooks.generateSecret', channel: 'webhooks:generateSecret', args: [] },
  { method: 'webhooks.status', channel: 'webhooks:status', args: [] },
  { method: 'triggerHistory.list', channel: 'triggerHistory:list', args: [] },
  { method: 'integrations.list', channel: 'integrations:list', args: [] },
  { method: 'integrations.templates', channel: 'integrations:templates', args: [] },
  { method: 'slack.status', channel: 'slack:status', args: [] },
  { method: 'app.info', channel: 'app:info', args: [] },
  { method: 'roster.write', channel: 'roster:write', args: ['snap'] },
  // ── Observabilidad (tarjetas Mis agentes) ──
  { method: 'telemetry.usage', channel: 'telemetry:usage', args: ['agentId'] },
  { method: 'telemetry.snapshot', channel: 'telemetry:snapshot', args: [] },
  // ── Git (panel Worktrees) ──
  { method: 'git.status', channel: 'git:status', args: ['cwd'] },
  { method: 'git.worktrees', channel: 'git:worktrees', args: ['cwd'] },
  { method: 'git.branches', channel: 'git:branches', args: ['cwd'] },
  { method: 'git.log', channel: 'git:log', args: ['cwd', 'limit'] },
];

/** Canales push que el server reemite por WS (antes liveWebContents().send). */
export const WEB_V1_PUSH: string[] = [
  'pty:data:', // + <id>: string (bytes terminal)
  'pty:exit:', // + <id>: PtyExit
  'pty:relaunch:', // + <id>: void
  'hive:agentSpawned',
  'hive:agentArchived',
  'missions:updated',
  'trigger:context',
  'mission:autoCompact',
  'control:snapshot',
];

/** Métodos explícitamente NO portados: el gateway responde ERR-W06. */
export const WEB_ELECTRON_ONLY: string[] = [
  'dialog:chooseFolder',
  'terminal:openAtFolder',
  'app:copyToClipboard',
  'app:readClipboard',
  'app:openExternal',
  'app:setLoginItem',
  'window:newFloor',
  'update:checkNow',
  'update:download',
  'update:restartAndInstall',
];

export interface FleetCard {
  id: string;
  name: string;
  provider: string;
  status: string;
  cwd: string;
  branch?: string;
  costUsd: number;
  tokens: number;
  inboxBacklog: number;
}

export interface FleetSnapshot {
  agents: FleetCard[];
  updatedAt: number;
}
