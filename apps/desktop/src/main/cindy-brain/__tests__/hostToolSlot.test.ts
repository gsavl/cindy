import { describe, expect, it, vi } from 'vitest';
import { handlePluginHostToolRequest, type PluginHostToolPorts } from '../hostToolSlot.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { authorizePluginHostToolCall, createHostToolRuntime, disposePluginHostTools, getPluginHostToolCaller, setHostToolProviders } from '../../mcp-integrations/hostToolCaller.js';
import { createTaskToolCallAuthorizer } from '../../maker-ipc/taskToolCallAuthorizer.js';
import { captureTaskActionSyncGuard, captureTaskActionDeliveryGuard, hasTaskActionAuthorization } from '../../maker-ipc/taskActionAuthorization.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { createGhostPageBridge } from '../../../shared/ghostPageBridge.js';
import { getDesktopMcpToolApprovalPolicy } from '../../maker-host/mcp-tool-approval-policy.js';
import { GhostRuntime, type SandboxHandle } from '../runtime/GhostRuntime.js';
import { isValidPluginInstallRelId, pluginInstallStoragePart } from '../../../shared/pluginIdentity.js';

const uiPipe = createGhostProductionCallbacks<{
  send(event: { sender: { id: number; isDestroyed(): boolean } }, payload: unknown): Promise<unknown>;
}>({ variables: ['executionPipe'], callbacks: { send: ['ipcMain.handle', 'ghost-pipe:send'] } });

const lifecycle = createGhostProductionCallbacks<{ getGhostRuntime(): GhostRuntime }>({
  functions: ['getGhostRuntime', 'disposePluginRuntimeHostServices'], initialize: 'let runtimeSingleton = null;',
});

// Test value: the production gateway must preserve raw tool results and enforce §1.2/§3
// approval and owner/install fences for a caller without a Session. Existing taskSlot tests
// cover plugin-owned tasks, not arbitrary Host tools. Unit; minimal single approved plugin.
function fixture() {
  let ghost: InstalledGhost | null = {
    enabled: true, dir: '/fixture/dashboard', approval: { state: 'approved', revision: 'r1' },
    manifest: { schemaVersion: 3, id: 'dashboard', name: 'Dashboard', version: '1.0.0', kind: 'chip', entry: 'main.js',
      agent: { hostTools: ['history', 'control', 'scheduler'] } },
    approvedHostToolGroups: ['history', 'control', 'scheduler'],
  };
  let generation = 1;
  const owner = () => ({ dataOwnerId: 'owner', ownerGeneration: generation });
  const result = { content: [{ type: 'text' as const, text: '{"ok":true,"items":["task"]}' }], _meta: { unchanged: true } };
  const invoke = vi.fn(async (_name: string, _args: Record<string, unknown>) => result);
  const commonAuthorize = createTaskToolCallAuthorizer({
    getDb: () => ({} as never), isScopeCurrent: () => true, authorizePluginCall: authorizePluginHostToolCall,
  });
  const ports: PluginHostToolPorts = {
    owner, getGhost: () => ghost,
    createRuntime: (_server, caller) => ({
      describe: name => ({ name, category: name === 'list_sessions' ? 'history' : name === 'schedule_list' ? 'scheduler' : name === 'archive_sessions' ? 'control' : 'auth' }),
      call: async (tool, args) => {
        const authorization = await commonAuthorize({ caller, sessionId: undefined, server: _server as 'cindy_helper', tool, args });
        if (!authorization.ok) throw new Error(authorization.errorCode);
        return authorization.run!(() => invoke(tool, args ?? {}));
      },
      close: vi.fn(async () => {}),
    }),
    approveGroup: vi.fn(async (_id, group, current) => current() && ghost?.approvedHostToolGroups?.includes(group) === true),
    policy: (_server, tool) => tool === 'archive_sessions' ? 'prompt-each-time' : 'auto-approve',
    confirm: vi.fn(async () => true), recordCall: vi.fn(),
  };
  const call = (tool = 'list_sessions', args: Record<string, unknown> = {}) => handlePluginHostToolRequest('dashboard', {
    type: 'host-tool-request', server: tool === 'schedule_list' ? 'cindy_scheduler' : 'cindy_helper', tool, args,
  }, () => true, ports);
  return { ports, invoke, result, call, get ghost() { return ghost!; }, remove: () => { ghost = null; }, changeOwner: () => { generation++; } };
}
const code = (value: Awaited<ReturnType<typeof handlePluginHostToolRequest>>) => JSON.parse(value.content[0].type === 'text' ? value.content[0].text : '{}').errorCode;

describe('plugin Host tool entry', () => {
  // Item 28, unit: the real sandbox lifecycle and production exit callback must
  // close the native service scope. Node stop coverage missed the logic-page
  // stop/crash/update path added for computer connections in item 26.
  it.each(['stop', 'crash', 'update'] as const)('releases an old computer connection after logic-page %s', async action => {
    const owner = { dataOwnerId: 'owner', ownerGeneration: 31 };
    const caller = { ...owner, kind: 'plugin' as const, pluginId: 'dashboard' };
    setHostToolProviders([{ name: 'cindy_computer', toClaudeSdkConfig: () => null, toHostTools: () => {
      let count = 0, open = true;
      return { list: () => [{ name: 'status', category: 'computer' }],
        describe: name => ({ name, category: 'computer' }),
        call: async () => { if (!open) throw new Error('CONNECTION_CLOSED'); return { content: [{ type: 'text', text: String(++count) }] }; },
        close: async () => { open = false; } };
    } }], owner);
    const handles: Array<SandboxHandle & { gone(): void }> = [];
    const noop = () => {};
    const api = lifecycle({ GhostRuntime,
      electronSandboxAdapter: { create() {
        let onGone: ((details: { reason: string }) => void) | null = null;
        const handle = { load: async () => {}, destroy: noop, onGone: (fn: (details: { reason: string }) => void) => { onGone = fn; },
          crashForTest: () => onGone?.({ reason: 'crashed' }), gone: () => onGone?.({ reason: 'oom' }) };
        handles.push(handle); return handle;
      } },
      isValidPluginInstallRelId, pluginInstallStoragePart,
      log: { info: noop, warn: noop }, disconnectRoutineSource: noop,
      pluginDeviceSync: { invalidate: noop }, getGhostPipeDispatcher: () => ({ onRuntimeState: noop }),
      networkSlotSingleton: null, fsSlotSingleton: null, getDesktopHostTerminalService: () => ({ disposePlugin: noop }),
      disposePluginHostTools, modelPickerSingleton: null, pluginInvocations: { invalidate: noop },
      invocationRuntimeGenerations: new Map(), broadcastGhostRuntimeStates: noop,
    });
    const runtime = api.getGhostRuntime(), ghost = fixture().ghost;
    try {
      await runtime.spawn(ghost);
      const old = createHostToolRuntime('cindy_computer', caller)!;
      expect((await old.call('status')).content[0]).toMatchObject({ text: '1' });
      if (action === 'stop') runtime.stop('dashboard');
      if (action === 'crash') handles.at(-1)!.gone();
      if (action === 'update') await runtime.spawn({ ...ghost, manifest: { ...ghost.manifest, version: '2.0.0' }, approval: { state: 'approved', revision: 'r2' } });
      await expect(old.call('status')).rejects.toThrow('CONNECTION_CLOSED');
      if (action !== 'update') await runtime.spawn(ghost);
      expect((await createHostToolRuntime('cindy_computer', caller)!.call('status')).content[0]).toMatchObject({ text: '1' });
    } finally { runtime.destroyAll(); setHostToolProviders([], { ...owner, ownerGeneration: 32 }); }
  });

  it('rejects malformed server identities before service lookup', async () => {
    const f = fixture();
    expect(code(await handlePluginHostToolRequest('dashboard', {
      type: 'host-tool-request', server: { toString: null }, tool: 'browser', args: {},
    }, () => true, f.ports))).toBe('INVALID_PARAMS');
    expect(f.ports.approveGroup).not.toHaveBeenCalled();
  });

  it('keeps computer observations per plugin until stop and honors live provider disable', async () => {
    const owner = { dataOwnerId: 'owner', ownerGeneration: 4 };
    const caller = { ...owner, kind: 'plugin' as const, pluginId: 'one' };
    let enabled = true;
    const close = vi.fn(async () => {});
    const create = vi.fn(() => { let count = 0; return {
      describe: (name: string) => ({ name, category: 'computer' }),
      call: async () => ({ content: [{ type: 'text' as const, text: String(++count) }] }), close,
    }; });
    setHostToolProviders([{ name: 'cindy_computer', isEnabled: () => enabled, toClaudeSdkConfig: () => null, toHostTools: create }], owner);
    // Catalog inspection closes its own detached descriptor before active calls.
    create.mockClear(); close.mockClear();
    try {
      const first = createHostToolRuntime('cindy_computer', caller)!;
      expect((await first.call('status')).content[0]).toMatchObject({ text: '1' });
      await first.close();
      const next = createHostToolRuntime('cindy_computer', caller)!;
      expect((await next.call('status')).content[0]).toMatchObject({ text: '2' });
      expect(create).toHaveBeenCalledTimes(1);
      expect((await createHostToolRuntime('cindy_computer', { ...caller, pluginId: 'two' })!.call('status')).content[0]).toMatchObject({ text: '1' });
      enabled = false;
      expect(createHostToolRuntime('cindy_computer', caller)).toBeNull();
      enabled = true;
      disposePluginHostTools('one');
      expect((await createHostToolRuntime('cindy_computer', caller)!.call('status')).content[0]).toMatchObject({ text: '1' });
      setHostToolProviders([], { ...owner, ownerGeneration: 5 });
      expect(createHostToolRuntime('cindy_computer', caller)).toBeNull();
      expect(close).toHaveBeenCalledTimes(3);
    } finally { setHostToolProviders([], { ...owner, ownerGeneration: 6 }); }
  });

  // Item 26: these existing services were inaccessible from the public plugin entry.
  // One approved plugin is enough to expose group/category confusion and risky calls.
  it.each([
    ['cindy_browser', 'browser', 'browser', { action: 'status' }, false],
    ['cindy_browser', 'browser', 'browser', { action: 'setBackend', backend: 'user-browser' }, true],
    ['cindy_computer', 'computer', 'status', {}, false],
    ['cindy_ssh', 'ssh', 'ssh_exec', { host: 'example', command: 'pwd' }, true],
    ['cindy_docs', 'docs', 'read_sheet', { path: 'own.csv' }, false],
    ['cindy_docs', 'docs', 'make_docx', { outPath: 'own.docx', markdown: 'Report' }, true],
  ] as const)('opens %s/%s through its existing risk policy', async (server, group, tool, args, confirmed) => {
    const f = fixture();
    f.ghost.manifest.agent!.hostTools = [group];
    f.ghost.approvedHostToolGroups = [group];
    f.ports.createRuntime = () => ({ describe: name => ({ name, category: group === 'docs' ? 'read' : group }),
      call: async () => f.result, close: async () => {} });
    f.ports.policy = (serverName, name, input) => getDesktopMcpToolApprovalPolicy(serverName === 'cindy_docs'
      ? { serverName, toolName: name, toolParams: input }
      : { serverName, toolName: 'call_tool', toolParams: { name, args: input } });
    const call = () => handlePluginHostToolRequest('dashboard', { type: 'host-tool-request', server, tool, args }, () => true, f.ports);
    expect(await call()).toEqual(f.result);
    expect(f.ports.confirm).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    f.ghost.approvedHostToolGroups = [];
    expect(code(await call())).toBe('PERMISSION_DENIED');
    f.ghost.approvedHostToolGroups = [group];
    f.ghost.manifest.agent!.hostTools = ['history'];
    expect(code(await call())).toBe('PERMISSION_DENIED');
  });

  it('routes the public UI API through the real IPC dispatcher using the sender identity', async () => {
    const f = fixture();
    const sender = { id: 7, isDestroyed: () => false };
    const ipc = uiPipe({
      ghostIdForLogicWebContents: (id: number) => id === sender.id ? 'dashboard' : null,
      requireGhostAvailableForActiveSession() {},
      requestPluginHostToolCall: (id: string, payload: unknown, current: () => boolean) => handlePluginHostToolRequest(id, payload, current, f.ports),
    });
    const page = createGhostPageBridge({ ping: async () => ({ ok: true, id: 'dashboard' }), send: payload => ipc.send({ sender }, payload) });
    expect(await page.api.host.call('cindy_helper', 'list_sessions')).toEqual(f.result);
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('list_sessions', {});
  });

  it('rejects a self-reported plugin identity outside the gateway scope', async () => {
    expect(await authorizePluginHostToolCall({ sessionId: undefined, caller: { kind: 'plugin', pluginId: 'dashboard', dataOwnerId: 'owner', ownerGeneration: 1 },
      server: 'cindy_helper', tool: 'archive_sessions', args: {} })).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
  });

  it('binds existing write and queued-delivery guards to the plugin approval without a task identity', async () => {
    const f = fixture();
    let beforeWrite: (() => void) | undefined;
    let beforeDelivery: (() => Promise<void>) | undefined;
    f.invoke.mockImplementationOnce(async () => {
      expect(hasTaskActionAuthorization()).toBe(true);
      expect(hasTaskActionAuthorization('unrelated-task')).toBe(false);
      beforeWrite = captureTaskActionSyncGuard();
      beforeDelivery = captureTaskActionDeliveryGuard();
      beforeWrite!();
      await beforeDelivery!();
      return f.result;
    });
    expect(await f.call('archive_sessions')).toBe(f.result);
    f.changeOwner();
    expect(beforeWrite).toThrow('TASK_ACTION_AUTHORIZATION_EXPIRED');
    await expect(beforeDelivery!()).rejects.toThrow('TASK_ACTION_AUTHORIZATION_EXPIRED');
  });

  it.each(['list_sessions', 'schedule_list', 'archive_sessions'])('dispatches %s through the shared authorizer and preserves the complete tool result', async tool => {
    const f = fixture();
    f.invoke.mockImplementationOnce(async () => {
      expect(getPluginHostToolCaller()?.caller).toEqual({ kind: 'plugin', pluginId: 'dashboard', dataOwnerId: 'owner', ownerGeneration: 1 });
      return f.result;
    });
    expect(await f.call(tool)).toBe(f.result);
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.ports.confirm).toHaveBeenCalledTimes(tool === 'archive_sessions' ? 1 : 0);
  });

  it.each(['missing-approval', 'group-removed', 'owner', 'update', 'uninstall', 'window', 'deny'] as const)('rejects %s before the handler executes', async scenario => {
    const f = fixture();
    if (scenario === 'missing-approval') f.ghost.approvedHostToolGroups = [];
    if (scenario === 'group-removed') f.ghost.manifest.agent!.hostTools = ['history'];
    f.ports.confirm = vi.fn(async () => {
      if (scenario === 'owner') f.changeOwner();
      if (scenario === 'update') f.ghost.approval = { state: 'approved', revision: 'r2' };
      if (scenario === 'uninstall') f.remove();
      return scenario !== 'deny' && scenario !== 'window';
    });
    expect(code(await f.call('archive_sessions', { session_ids: ['target'] }))).toBe('PERMISSION_DENIED');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('denies group-external tools and plugin-management servers without prompting', async () => {
    const f = fixture();
    expect(code(await f.call('request_input_handoff'))).toBe('PERMISSION_DENIED');
    expect(code(await handlePluginHostToolRequest('dashboard', { type: 'host-tool-request', server: 'cindy', tool: 'ghost_call', args: {} }, () => true, f.ports))).toBe('PERMISSION_DENIED');
    expect(f.ports.confirm).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('confirms every risky invocation and executes the exact parameter snapshot shown', async () => {
    const f = fixture(), args = { session_ids: ['original'] };
    f.ports.confirm = vi.fn(async input => { expect(input.args).toEqual({ session_ids: ['original'] }); args.session_ids = ['changed']; return true; });
    await f.call('archive_sessions', args);
    await f.call('archive_sessions', { session_ids: ['original'] });
    expect(f.ports.confirm).toHaveBeenCalledTimes(2);
    expect(f.invoke.mock.calls.every(([, input]) => JSON.stringify(input) === '{"session_ids":["original"]}')).toBe(true);
    expect(f.ports.recordCall).toHaveBeenCalledWith('dashboard', 'cindy_helper', 'archive_sessions');
  });

  it('suppresses a late result after the account changes during execution', async () => {
    const f = fixture();
    f.invoke.mockImplementationOnce(async () => { f.changeOwner(); return f.result; });
    expect(code(await f.call())).toBe('PERMISSION_DENIED');
  });
});
