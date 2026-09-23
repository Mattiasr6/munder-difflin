import { cth as bus } from './cthClient';
import type { CthApi } from '../../../preload/index';

type Unsub = () => void;
const noopUnsub: Unsub = () => undefined;

function req<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return bus.request<T>(method, params);
}

function sub(channel: string, cb: (payload: never) => void): Unsub {
  return bus.on(channel, cb as (payload: unknown) => void);
}

async function copyText(text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch {
    return { ok: false, error: 'clipboard unavailable' };
  }
}

async function readText(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

export const webCth: CthApi = {
  version: 'web',
  trackMessageSent: () => Promise.resolve(),
  spawnPty: (opts) => req('pty.spawn', { opts: opts as unknown as Record<string, unknown> }),
  writePty: (id, data) => req('pty.write', { id, data }),
  resizePty: (id, cols, rows) => req('pty.resize', { id, cols, rows }),
  redrawPty: (id) => req('pty.redraw', { id }),
  killPty: (id) => req('pty.kill', { id }),
  listPtys: () => req('pty.list'),
  resolveSessionCwd: (sessionId) => req('session.resolveCwd', { sessionId }),
  onPtyData: (id, cb) => sub(`pty:data:${id}`, cb),
  onPtyExit: (id, cb) => sub(`pty:exit:${id}`, cb),
  onPtyRelaunch: (id, cb) => sub(`pty:relaunch:${id}`, cb),
  chooseFolder: () => Promise.resolve({ ok: false as const, error: 'web: no folder picker' }),
  openTerminalAt: () => Promise.resolve({ ok: false, error: 'web: no local terminal' }),
  copyToClipboard: (text) => copyText(text),
  readClipboard: () => readText(),
  readClipboardSync: () => '',
  getConfig: () => req('config.get'),
  updateConfig: (patch) => req('config.update', { patch: patch as unknown as Record<string, unknown> }),
  setAgentTokenCap: (id, cap) => req('config.setAgentTokenCap', { id, cap }),
  ensureHarnessHome: (path) => req('config.ensureHome', { path }),
  changeHome: () => Promise.resolve({ ok: true, home: null }),
  listDir: (root, rel) => req('fs.listDir', { root, rel }),
  readFile: (root, rel) => req('fs.readFile', { root, rel }),
  readBinary: (root, rel) => req('fs.readBinary', { root, rel }),
  writeFile: (root, rel, content) => req('fs.writeFile', { root, rel, text: content }),
  statAbs: (path) => req('fs.statAbs', { path }),
  revealPath: () => Promise.resolve({ ok: false as const, error: 'web: no file reveal' }),
  gitIsRepo: (cwd) => req('git.isRepo', { cwd }),
  gitMainRepo: (cwd) => req('git.mainRepo', { cwd }),
  gitBranch: (cwd) => req('git.branch', { cwd }),
  gitStatus: (cwd) => req('git.status', { cwd }),
  gitLog: (cwd, n) => req('git.log', { cwd, limit: n ?? 50 }),
  gitBranches: (cwd) => req('git.branches', { cwd }),
  gitAheadBehind: (cwd) => req('git.aheadBehind', { cwd }),
  gitDiff: (cwd, relPath) => req('git.diff', { cwd, relPath }),
  gitLogGraph: (cwd, n, skip) => req('git.logGraph', { cwd, n, skip: skip ?? 0 }),
  gitCommitFiles: (cwd, sha) => req('git.commitFiles', { cwd, sha }),
  gitShowFile: (cwd, rev, relPath) => req('git.showFile', { cwd, rev, relPath }),
  gitCompareRefs: (cwd, base, head, mode) => req('git.compareRefs', { cwd, base, head, mode: mode ?? 'three' }),
  gitWorktrees: (cwd) => req('git.worktrees', { cwd }),
  gitCheckout: (cwd, ref, detach) => req('git.checkout', { cwd, ref, detach: detach === true }),
  hiveRegistry: () => req('hive.registry'),
  hivePatchAgentRole: (id, role) => req('hive.patchAgentRole', { id, role }),
  hiveRenameAgent: (id, name) => req('hive.renameAgent', { id, name }),
  hiveSetAgentHold: (id, hold) => req('hive.setAgentHold', { id, hold }),
  hiveBoard: () => req('hive.board'),
  hiveTasks: () => req('hive.tasks'),
  hiveLog: (n) => req('hive.log', { n: n ?? 200 }),
  hiveMemory: (id) => req('hive.memory', { id }),
  hiveInbox: (id) => req('hive.inbox', { id }),
  hiveMessages: (opts) => req('hive.messages', { opts: (opts ?? {}) as unknown as Record<string, unknown> }),
  hiveAgentDirectory: () => req('hive.agentDirectory'),
  listWorkers: () => Promise.resolve({ live: [], preserved: [], maxWorkers: 0 }),
  stopWorker: () => Promise.resolve({ ok: false as const, error: 'web: no workers' }),
  memoryStatus: () => req('hive.memoryStatus'),
  toolsStatus: () => req('tools.status'),
  heroPayload: () => req('hero.payload'),
  modelCatalog: () => req('models.catalog'),
  skillsLocal: (cwd) => req('skills.local', { cwd: cwd ?? '' }),
  skillsCatalog: (force) => req('skills.catalog', { force: force === true }),
  skillsInstall: () => Promise.resolve({ ok: false as const, error: 'web: installs disabled' }),
  skillsUninstall: () => Promise.resolve({ ok: false as const, error: 'web: uninstalls disabled' }),
  skillsReveal: () => Promise.resolve({ ok: false as const, error: 'web: no file reveal' }),
  searchMemory: (query) => req('hive.searchMemory', { query }),
  memoryWakeUp: (wing) => req('hive.memoryWakeUp', { wing }),
  mineNow: () => req('hive.mineNow'),
  reflectNow: (id) => req('hive.reflectNow', { id }),
  kgStatus: () => req('kg.status'),
  kgList: () => req('kg.list'),
  kgSearch: (query, limit) => req('kg.search', { query, limit }),
  kgGet: (id) => req('kg.get', { id }),
  kgRemove: (id) => req('kg.remove', { id }),
  kgAddFiles: () => Promise.resolve({ ok: false as const, error: 'web: no file picker', results: [] }),
  kgIngestFiles: () => Promise.resolve({ ok: false as const, error: 'web: no file picker', results: [] }),
  attachFiles: () => Promise.resolve({ ok: false as const, error: 'web: no file picker' }),
  pathForFile: (file) => file.name,
  saveClipboardImage: () => Promise.resolve({ ok: false as const, error: 'web: no clipboard image' }),
  historyAdd: (payload) => req('history.add', payload as unknown as Record<string, unknown>),
  historyList: (agentId, limit) => req('history.list', { agentId, limit }),
  historySearch: (query, limit) => req('history.search', { query, limit }),
  hiveSend: (msg, from) => req('hive.send', { msg: msg as unknown as Record<string, unknown>, from }),
  onHiveHookEvent: () => noopUnsub,
  onHiveContextUpdate: (cb) => sub('hive:contextUpdate', cb),
  onHiveMessage: (cb) => sub('hive:message', cb),
  onHiveEnqueue: (cb) => sub('hive:enqueueToAgent', cb),
  onHiveAgentSpawned: (cb) => sub('hive:agentSpawned', cb),
  onHiveAgentArchived: (cb) => sub('hive:agentArchived', cb),
  onHiveTerminalHandoff: (cb) => sub('hive:terminalHandoff', cb),
  onHireImport: () => noopUnsub,
  onHireError: () => noopUnsub,
  drainPendingHires: () => Promise.resolve([]),
  importHireFiles: () => Promise.resolve({ ok: false as const, manifests: [], errors: [], error: 'web: no file picker' }),
  onConfigChanged: () => noopUnsub,
  onCloseRequested: () => noopUnsub,
  confirmClose: () => Promise.resolve(),
  cancelClose: () => Promise.resolve(),
  onPowerResume: () => noopUnsub,
  newFloor: () => Promise.resolve({ ok: false as const }),
  startClosingTime: () => Promise.resolve({ ok: false as const, error: 'web: no closing time' }),
  cancelClosingTime: () => Promise.resolve(),
  onClosingTime: () => noopUnsub,
  resetAll: () => Promise.resolve(),
  agentUsage: (cwd) => req('hive.agentUsage', { cwd }),
  agentContext: (agentId) => req('hive.agentContext', { id: agentId }),
  telemetryUsage: (agentId) => req('telemetry.usage', { agentId }),
  telemetrySpans: (agentId) => req('telemetry.spans', { agentId }),
  telemetrySnapshot: () => req('telemetry.snapshot'),
  onTelemetryEvent: (cb) => sub('telemetry:event', cb),
  onBreakerState: (cb) => sub('control:breakerState', cb),
  setBreakerState: (state) => req('control.setBreakerState', { state: state as unknown as Record<string, unknown> }),
  controlPause: (agentId, on) => req('control.pause', { id: agentId, on }),
  controlAutoDelivery: (agentId, paused) => req('control.autoDelivery', { id: agentId, paused }),
  controlResume: (agentId) => req('control.resume', { id: agentId }),
  controlGateTool: (agentId, tool, on) => req('control.gateTool', { id: agentId, tool, on }),
  controlSteer: (agentId, text) => req('control.steer', { id: agentId, text }),
  controlHalt: (agentId) => req('control.halt', { id: agentId }),
  controlSnapshot: (agentId) => req('control.snapshot', { id: agentId }),
  onApprovalRequest: () => noopUnsub,
  hiveAddTask: (task) => req('hive.addTask', { task: task as unknown as Record<string, unknown> }),
  hivePatchTask: (id, patch) => req('hive.patchTask', { id, patch: patch as unknown as Record<string, unknown> }),
  hiveDeleteTask: (id) => req('hive.deleteTask', { id }),
  listMissions: () => req('missions.list'),
  saveMissions: (missions) => req('missions.save', { missions: missions as unknown as Record<string, unknown> }),
  onMissionsUpdated: (cb) => sub('missions:updated', cb),
  onAutoCompact: (cb) => sub('mission:autoCompact', cb),
  textSearch: (q) => req('hive.textSearch', { query: q }),
  githubIssues: () => Promise.resolve({ ok: false as const, error: 'web: gh CLI not wired' }),
  githubCIRuns: () => Promise.resolve({ ok: false as const, error: 'web: gh CLI not wired' }),
  setNotifications: (v) => req('config.update', { patch: { notifications: v } }),
  openExternal: (url) => {
    try {
      window.open(url, '_blank', 'noopener');
      return Promise.resolve({ ok: true as const });
    } catch {
      return Promise.resolve({ ok: false as const, error: 'popup blocked' });
    }
  },
  setLoginItem: () => Promise.resolve(false),
  hiveSetArchived: (id, archived) => req('hive.setArchived', { id, archived }),
  onSlackMessage: (cb) => sub('slack:incomingMessage', cb),
  slackStart: () => Promise.resolve({ ok: false as const, error: 'web: managed on host' }),
  slackStop: () => Promise.resolve({ ok: false as const, error: 'web: managed on host' }),
  slackStatus: () => req('slack.status'),
  slackReply: () => Promise.resolve({ ok: false as const, error: 'web: managed on host' }),
  slackReplyScriptPath: () => Promise.resolve(''),
  slackSetConfig: () => Promise.resolve({ ok: false as const, error: 'web: managed on host' }),
  webhookStart: () => Promise.resolve({ ok: false as const, error: 'web: managed on host' }),
  webhookStop: () => Promise.resolve({ ok: false as const, error: 'web: managed on host' }),
  webhookStatus: () => req('webhooks.status'),
  webhookGenerateSecret: () => req('webhooks.generateSecret'),
  webhookSetConfig: () => Promise.resolve({ ok: false as const, error: 'web: managed on host' }),
  getContextTrigger: () => req('triggers.getContext'),
  setContextTrigger: (trigger) => req('triggers.setContext', { trigger: trigger as unknown as Record<string, unknown> }),
  onContextTrigger: (cb) => sub('trigger:context', cb),
  listWebhooks: () => req('webhooks.list'),
  saveWebhooks: (triggers) => req('webhooks.save', { triggers: triggers as unknown as Record<string, unknown> }),
  deleteWebhook: (id) => req('webhooks.delete', { id }),
  generateWebhookSecret: () => req('webhooks.generateSecret'),
  webhooksStatus: () => req('webhooks.status'),
  getOrgTrigger: () => req('org.getTrigger'),
  setOrgTrigger: (trigger) => req('org.setTrigger', { trigger: trigger as unknown as Record<string, unknown> }),
  listTriggerHistory: () => req('triggerHistory.list'),
  decideTriggerHistory: () => Promise.resolve(null),
  clearTriggerHistory: () => Promise.resolve(),
  onTriggerHistoryUpdated: (cb) => sub('triggerHistory:updated', cb),
  freeflowSetConfig: () => Promise.resolve({ ok: false as const, error: 'web: no voice' }),
  freeflowTranscribe: () => Promise.resolve({ ok: false as const, error: 'web: no voice' }),
  integrationsList: () => req('integrations.list'),
  integrationsTemplates: () => req('integrations.templates'),
  integrationsUpsert: () => Promise.resolve({ ok: false as const, error: 'web: read-only' }),
  integrationsSetSecret: () => Promise.resolve({ ok: false as const, error: 'web: read-only' }),
  integrationsRemove: () => Promise.resolve({ ok: false as const, error: 'web: read-only' }),
  integrationsTest: () => Promise.resolve({ ok: false as const, error: 'web: read-only' }),
  providerKeySet: () => Promise.resolve({ ok: false as const, error: 'web: read-only' }),
  providerKeyHas: () => Promise.resolve(false),
  providerKeyClear: () => Promise.resolve({ ok: false as const, error: 'web: read-only' }),
  realtimeHasOpenAiKey: () => Promise.resolve(false),
  realtimeMintToken: () => Promise.resolve({ ok: false as const, error: 'web: no voice' }),
  realtimeAction: () => Promise.resolve({ ok: false as const, spoken: '', error: 'web: no voice' }),
  realtimeActionConfirm: () => Promise.resolve({ ok: false as const, spoken: '', error: 'web: no voice' }),
  realtimeActionCancel: () => Promise.resolve({ ok: false as const, spoken: '', error: 'web: no voice' }),
  onRealtimeCompletion: () => noopUnsub,
  realtimeSetSessionLive: () => Promise.resolve({ ok: true as const }),
  realtimeDrainCompletions: () => Promise.resolve([]),
  realtimeWaitFor: () => Promise.resolve({ timedOut: true as const, taskId: '' }),
  onRealtimeFloorDelta: () => noopUnsub,
  onRealtimeEnqueue: () => noopUnsub,
  appInfo: () => req('app.info'),
  rosterReadSync: () => null,
  harnessHomeSync: () => null,
  rosterWrite: (snap) => req('roster.write', { snap: snap as unknown as Record<string, unknown> }),
  onUpdateStatus: () => noopUnsub,
  updateCurrent: () => Promise.resolve({ state: 'idle' as const }),
  updateRestartAndInstall: () => Promise.resolve({ ok: false as const, error: 'web: no updater' }),
  updateCheckNow: () => Promise.resolve({ ok: false as const, error: 'web: no updater' }),
  updateDownload: () => Promise.resolve({ ok: false as const, error: 'web: no updater' }),
  updateOpenRelease: () => Promise.resolve({ ok: false as const }),
  platform: 'linux',
  arch: 'x64',
  updateSimulate: () => Promise.resolve({ ok: false as const, error: 'web: no updater' }),
};

/** Instala el shim solo en browser sin preload (modo web). En Electron no toca nada. */
export function installWebCth(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { cth?: unknown; __cthWeb?: boolean };
  if (w.cth) return;
  w.__cthWeb = true;
  try {
    window.localStorage.setItem('cth.skipHivePickerOnce', '1');
  } catch { /* sin storage: el picker se muestra una vez */ }
  (w as unknown as { cth: CthApi }).cth = webCth;
}
