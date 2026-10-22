export function windowFixture() {
const now = Date.now();
return {
  v: 1, ts: now, agg: 'waiting',
  sessions: [
    { id: 'session-1', lastActiveMs: now - 30000, source: 'dsh', label: 'agent桌宠', state: 'running', activity: '运行命令', elapsedMs: 74000, pending: 0, agentName: 'DSH', model: 'deepseek-flash', reasoningEffort: 'max', kind: 'main', projectKey: 'ws-1', variant: 'desktop' },
    { id: 'session-2', lastActiveMs: now - 30000, source: 'claude-code', label: 'api-fix', state: 'thinking', activity: '思考中', elapsedMs: 12000, pending: 0, agentName: 'Claude Code', model: 'glm-5.3', reasoningEffort: 'high', kind: 'main', projectKey: 'ws-1', variant: 'desktop', usage: { input: 1234567, output: 23456, cacheRead: 987654, cacheWrite: 0, requests: 42 } },
    { id: 'session-3', lastActiveMs: now - 30000, source: 'codex', label: 'docs', state: 'waiting', activity: '等待你批准', elapsedMs: 4000, pending: 2, agentName: 'Codex', model: 'gpt-6-sol', kind: 'main', projectKey: 'ws-1', variant: 'cli' },
    { id: 'session-4', lastActiveMs: now - 30000, source: 'dsh', label: 'web-ui', state: 'error', activity: '连接错误', elapsedMs: 2000, pending: 0, agentName: 'DSH', kind: 'main', projectKey: 'ws-2', variant: 'desktop' },
    { id: 'session-5', source: 'dsh', label: '旧任务', state: 'done', activity: '已完成', elapsedMs: 7200000, pending: 0, agentName: 'DSH', kind: 'main', projectKey: 'ws-1', since: now - 7200000, lastActiveMs: now - 7200000, variant: 'desktop' },
    { id: 'session-6', source: 'dsh', label: '刚完成', state: 'done', activity: '已完成', elapsedMs: 300000, pending: 0, agentName: 'DSH', kind: 'main', projectKey: 'ws-1', since: now - 300000, lastActiveMs: now - 300000, variant: 'desktop' },
    { id: 'session-7', source: 'dsh', label: '闲置会话', state: 'idle', activity: '空闲', elapsedMs: 7200000, pending: 0, agentName: 'DSH', kind: 'main', projectKey: 'ws-2', since: now - 7200000, lastActiveMs: now - 7200000, variant: 'desktop' },
    { id: 'session-8', lastActiveMs: now - 30000, source: 'zcode', label: '现在确认项目进度', state: 'thinking', activity: '思考中', elapsedMs: 9000, pending: 0, agentName: 'ZCode', model: 'GLM-5.3', reasoningEffort: 'max', kind: 'main', projectKey: 'ws-1', variant: 'desktop' },
    { id: 'session-sub', source: 'dsh', label: '子代理内部', state: 'running', kind: 'subagent', projectKey: 'ws-1' },
  ],
  counters: { thinking: 1, running: 1, errors: 1, done: 1 },
  stateCounts: { thinking: 1, running: 1, waiting: 1, errors: 1, done: 1 },
  agents: [
    { id: 'dsh', name: 'DeepSeek Harness', source: 'dsh', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'plugin', processes: 3, lastActivityMs: now - 2000, version: '0.2.0-rc.2', variants: { desktop: 8 }, evidence: ['/Applications/DeepSeek Harness.app'] },
    { id: 'claude-code-cli', name: 'Claude Code CLI', source: 'claude-code', base: 'claude-code', variantTag: 'cli', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'observe', processes: 2, lastActivityMs: now - 9000, version: '2.1.278', variants: { cli: 13 }, evidence: ['~/.local/bin/claude'] },
    { id: 'claude-code-desktop', name: 'Claude Code 桌面端', source: 'claude-code', base: 'claude-code', variantTag: 'desktop', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'observe', processes: 5, lastActivityMs: now - 9000, version: '2.19675.0', variants: { desktop: 33, ide: 4 }, evidence: ['/Applications/Claude.app'] },
    { id: 'codex-cli', name: 'Codex CLI', source: 'codex', base: 'codex', variantTag: 'cli', status: 'open-unconnected', installed: true, running: true, connected: false, connectionKind: null, processes: 1, lastActivityMs: now - 400000, version: '0.160.1', variants: { cli: 2 }, evidence: ['~/.local/bin/codex'] },
    { id: 'codex-desktop', name: 'Codex 桌面端', source: 'codex', base: 'codex', variantTag: 'desktop', status: 'open-unconnected', installed: true, running: true, connected: false, connectionKind: null, processes: 3, lastActivityMs: now - 400000, version: '1.5.0', variants: { desktop: 32 }, evidence: ['/Applications/Codex++.app'] },
    { id: 'kimi-cli', name: 'Kimi CLI', source: 'kimi-code', base: 'kimi-code', variantTag: 'cli', status: 'closed', installed: true, running: false, connected: false, processes: 0, evidence: ['~/.kimi-code/bin/kimi'] },
    { id: 'kimi-desktop', name: 'Kimi Code 桌面端', source: 'kimi-code', base: 'kimi-code', variantTag: 'desktop', status: 'closed', installed: true, running: false, connected: false, processes: 0, lastActivityMs: now - 7200000, version: '1.0.4', sessionCount: 9, evidence: ['/Applications/Kimi Code.app'] },
    { id: 'zcode', name: 'ZCode', source: 'zcode', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'observe', processes: 8, lastActivityMs: now - 1000, version: '3.14.4', sessionCount: 39, variants: { desktop: 2 }, evidence: ['/Applications/ZCode.app'] },
    { id: 'opencode-cli', name: 'OpenCode CLI', source: 'opencode', base: 'opencode', variantTag: 'cli', status: 'closed', installed: true, running: false, connected: false, processes: 0, lastActivityMs: now - 600000, sessionCount: 69, evidence: ['~/.opencode/bin/opencode'] },
    { id: 'opencode-desktop', name: 'OpenCode 桌面端', source: 'opencode', base: 'opencode', variantTag: 'desktop', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'observe', processes: 5, lastActivityMs: now - 600000, version: '2.1.2', evidence: ['/Applications/OpenCode.app'] },
    { id: 'qoder-cli', name: 'Qoder CLI', source: 'qoder', base: 'qoder', variantTag: 'cli', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'observe', processes: 2, lastActivityMs: now - 30000, evidence: ['~/.local/bin/qoderclicn'] },
    { id: 'qoder-desktop', name: 'Qoder 桌面端', source: 'qoder', base: 'qoder', variantTag: 'desktop', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'observe', processes: 5, lastActivityMs: now - 300000, version: '0.4.8', sessionCount: 11, evidence: ['/Applications/Qoder CN.app'] },
    { id: 'cursor-cli', name: 'Cursor CLI', source: 'cursor', base: 'cursor', variantTag: 'cli', status: 'closed', installed: true, running: false, connected: false, processes: 0, evidence: ['~/.local/bin/cursor-agent'] },
    { id: 'cursor-desktop', name: 'Cursor 桌面端', source: 'cursor', base: 'cursor', variantTag: 'desktop', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'observe', processes: 5, lastActivityMs: now - 800000, version: '3.26.16', variants: { desktop: 2 }, evidence: ['/Applications/Cursor.app'] },
  ],
  // 队列：一条已送达（不得显示）、一条待投递、一条失败（都要显示）
  inputs: [
    { id: 'in-ok', text: '这条已送达，不应出现', status: 'delivered', at: now - 60000 },
    { id: 'in-q', text: '把进度总结成三行', status: 'queued', at: now },
    { id: 'in-f', text: '失败的投递', status: 'failed', at: now - 30000, sessionId: 'session-2', source: 'claude-code', targetKey: 'sess:session-2' },
  ],
  inputChannel: { mode: 'cli', detail: 'x' },
  lastEvent: { type: 'tool.call', ts: now, sessionId: 'session-1' },
  usage: {
    generatedAt: now - 5000,
    totals: { input: 123456789, output: 2345678, cacheRead: 987654321, cacheWrite: 12345, requests: 4321, freshInput: 136802468, promptTokens: 1111111110, totalTokens: 1113689133, hitRate: 0.9 },
    byModel: [
      { model: 'GLM-5.3', sources: ['zcode', 'claude-code'], input: 800000000, output: 1500000, cacheRead: 700000000, cacheWrite: 0, requests: 2000, promptTokens: 810000000, totalTokens: 811500000, hitRate: 0.47 },
      { model: 'gpt-6-sol', sources: ['codex'], input: 40000000, output: 500000, cacheRead: 12000000, cacheWrite: 0, requests: 300, promptTokens: 40000000, totalTokens: 40500000, hitRate: 0.23 },
    ],
    bySource: {
      dsh: { totals: { input: 1700000, output: 2000000, cacheRead: 270000000, cacheWrite: 0, requests: 1341, promptTokens: 271700000, totalTokens: 273700000, hitRate: 0.994 }, inputIncludesCache: false, partial: false, elapsedMs: 300, variants: [], models: [{ model: 'deepseek-flash', input: 1700000, output: 2000000, cacheRead: 270000000, cacheWrite: 0, requests: 1341, hitRate: 0.994 }] },
      'claude-code': { totals: { input: 30000000, output: 1000000, cacheRead: 8000000, cacheWrite: 0, requests: 500, promptTokens: 38000000, totalTokens: 39000000, hitRate: 0.21 }, inputIncludesCache: false, partial: false, elapsedMs: 2100, variants: [{ variant: 'desktop', totals: { input: 29000000, output: 950000, cacheRead: 7500000, cacheWrite: 0, requests: 420, hitRate: 0.21 } }, { variant: 'cli', totals: { input: 1000000, output: 50000, cacheRead: 500000, cacheWrite: 0, requests: 80, hitRate: 0.33 } }], models: [{ model: 'glm-5.3', input: 30000000, output: 1000000, cacheRead: 8000000, cacheWrite: 0, requests: 500, hitRate: 0.21 }] },
      codex: { totals: { input: 40000000, output: 500000, cacheRead: 12000000, cacheWrite: 0, requests: 300, promptTokens: 40000000, totalTokens: 40500000, hitRate: 0.23 }, inputIncludesCache: true, partial: false, elapsedMs: 430, variants: [{ variant: 'desktop', totals: { input: 39000000, output: 490000, cacheRead: 11900000, cacheWrite: 0, requests: 296, hitRate: 0.23 } }], models: [{ model: 'gpt-6-sol', input: 40000000, output: 500000, cacheRead: 12000000, cacheWrite: 0, requests: 300, hitRate: 0.23 }] },
      'kimi-code': { totals: { input: 2600000, output: 609000, cacheRead: 0, cacheWrite: 0, requests: 181, promptTokens: 2600000, totalTokens: 3209000, hitRate: 0 }, inputIncludesCache: false, partial: false, elapsedMs: 300, variants: [{ variant: 'desktop', totals: { input: 2400000, output: 577000, cacheRead: 0, cacheWrite: 0, requests: 170, hitRate: 0 } }], models: [{ model: 'k3', input: 1600000, output: 161000, cacheRead: 0, cacheWrite: 0, requests: 181, hitRate: 0 }] },
      zcode: { totals: { input: 1670000000, output: 5000000, cacheRead: 990000000, cacheWrite: 0, requests: 6300, promptTokens: 1670000000, totalTokens: 1675000000, hitRate: 0.6 }, inputIncludesCache: true, partial: false, elapsedMs: 24, variants: [], models: [{ model: 'GLM-5.3', input: 807000000, output: 1900000, cacheRead: 700000000, cacheWrite: 0, requests: 2810, hitRate: 0.65 }] },
      opencode: { totals: { input: 7276805, output: 865627, cacheRead: 157436199, cacheWrite: 0, requests: 2220, promptTokens: 164713004, totalTokens: 165578631, hitRate: 0.9559 }, inputIncludesCache: false, partial: false, elapsedMs: 297, variants: [], models: [{ model: 'moonshotai-cn/kimi-k3', input: 3657697, output: 437033, cacheRead: 90216720, cacheWrite: 0, requests: 1118, hitRate: 0.9611 }] },
    },
    ranges: {
      today: {
        totals: { input: 5000000, output: 300000, cacheRead: 4000000, cacheWrite: 0, requests: 210, promptTokens: 9000000, totalTokens: 9300000, hitRate: 0.44 },
        bySource: {
          dsh: { totals: { input: 100000, output: 20000, cacheRead: 900000, cacheWrite: 0, requests: 30, hitRate: 0.9 }, variants: [], models: [] },
          'claude-code': { totals: { input: 2000000, output: 100000, cacheRead: 1500000, cacheWrite: 0, requests: 90, hitRate: 0.43 }, variants: [{ variant: 'cli', totals: { input: 2000000, output: 100000, cacheRead: 1500000, cacheWrite: 0, requests: 90, hitRate: 0.43 } }], models: [{ model: 'glm-5.3', input: 2000000, output: 100000, cacheRead: 1500000, cacheWrite: 0, requests: 90, hitRate: 0.43 }] },
        },
        byModel: [{ model: 'glm-5.3', sources: ['claude-code'], input: 2000000, output: 100000, cacheRead: 1500000, cacheWrite: 0, requests: 90, hitRate: 0.43 }],
      },
      d7: { totals: { input: 10000000, output: 600000, cacheRead: 8000000, cacheWrite: 0, requests: 420, promptTokens: 18000000, totalTokens: 18600000, hitRate: 0.44 }, bySource: {}, byModel: [] },
      d30: { totals: { input: 50000000, output: 2000000, cacheRead: 40000000, cacheWrite: 0, requests: 1200, promptTokens: 90000000, totalTokens: 92000000, hitRate: 0.44 }, bySource: {}, byModel: [] },
    },
  },
  build: { window: 1730000000000, mini: 1730000000000 },
  modelRegistry: {
    dsh: { available: true, models: [{ value: 'deepseek/deepseek-flash', label: 'deepseek · deepseek-flash', providerId: 'deepseek', modelId: 'deepseek-flash', cliModel: 'deepseek/deepseek-flash', reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max', canCreate: true }] },
    // hidden 项模拟「切换器换了整张上游模型表」：不可调用，不进新建下拉
    'claude-code': { available: true, models: [
      { value: 'gpt-6-astra', label: 'GPT-6-Astra', modelId: 'gpt-6-astra', cliModel: 'gpt-6-astra', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium', canCreate: true },
      { value: 'claude-opus-4-8', label: 'Opus 4.8', modelId: 'claude-opus-4-8', cliModel: 'claude-opus-4-8', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', canCreate: false, hidden: true, unavailableReason: '该模型没有映射到当前供应商的上游模型（切换器只配置了实际使用的模型）' },
    ] },
    codex: { available: true, models: [
      { value: 'gpt-6-astra', label: 'GPT-6-Astra', modelId: 'gpt-6-astra', cliModel: 'gpt-6-astra', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'medium', canCreate: true },
      { value: 'codex-narrow', label: 'Codex Narrow', modelId: 'codex-narrow', cliModel: 'codex-narrow', reasoningEfforts: ['high'], canCreate: true },
    ] },
    'kimi-code': { available: true, models: [{ value: 'kimi-code/k3', label: 'K3', providerId: 'kimi-code', modelId: 'k3', cliModel: 'kimi-code/k3', reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', canCreate: true }] },
    zcode: { available: true, models: [
      { value: 'deepseek/deepseek-flash', label: 'deepseek · deepseek-flash', providerId: 'deepseek', modelId: 'deepseek-flash', cliModel: 'deepseek/deepseek-flash', reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max', canCreate: true },
      { value: 'account:plan/glm', label: 'Account GLM', providerId: 'account:plan', modelId: 'glm', reasoningEfforts: ['high'], canCreate: false },
    ] },
  },
  capabilities: { canCatalog: true, canOpen: true, canCreate: true, canInput: true, cliChannels: [{ source: 'claude-code' }, { source: 'codex' }, { source: 'kimi-code' }, { source: 'zcode' }, { source: 'opencode' }, { source: 'cursor' }, { source: 'qoder' }], plugin: { available: false } },
  catalog: {
    elapsedMs: 55,
    projects: [
      { key: 'ws-1', projectId: 'ws-1', name: 'agent桌宠', cwd: '/Users/demo/Desktop/agent桌宠', sessionCount: 10, liveCount: 4, sources: ['dsh', 'claude-code', 'codex', 'zcode'] },
      { key: 'ws-2', projectId: 'ws-2', name: '原生AI操作系统', cwd: '/Users/demo/Desktop/原生AI操作系统', sessionCount: 4, liveCount: 0, sources: ['dsh'] },
      { key: '__none__', projectId: '__none__', name: '未归入项目', cwd: null, sessionCount: 2, liveCount: 0, unregistered: true, sources: ['dsh'] },
      { key: 'path:/tmp/x', projectId: 'path:/tmp/x', name: 'x（临时）', cwd: '/tmp/x', sessionCount: 1, liveCount: 0, sources: ['dsh'], dead: true, scratch: true },
    ],
    history: [
      { sessionId: 'hist-1', title: '创建一个HTML', state: 'done', source: 'dsh', agentName: 'DSH', model: 'deepseek-v4-pro', updatedAt: now - 86400000, kind: 'main', projectKey: 'ws-1', variant: 'desktop' },
      { sessionId: 'hist-cc', title: '修复 replay fixture', state: 'done', source: 'claude-code', agentName: 'Claude Code', model: 'glm-5.3', updatedAt: now - 5400000, kind: 'main', projectKey: 'ws-1', variant: 'cli' },
      { sessionId: 'hist-cx', title: 'SVG鹈鹕动画', state: 'done', source: 'codex', agentName: 'Codex', model: 'gpt-6-sol', updatedAt: now - 6600000, kind: 'main', projectKey: 'ws-2', variant: 'desktop' },
      { sessionId: 'hist-km', title: '前端简洁科技感重设计', state: 'idle', source: 'kimi-code', agentName: 'Kimi Code', model: 'k3', updatedAt: now - 9000000, kind: 'main', projectKey: '__none__' },
      { sessionId: 'hist-zc', title: '清理混入教材图片并重新整理', state: 'done', source: 'zcode', agentName: 'ZCode', model: 'GLM-5.3', updatedAt: now - 7200000, kind: 'main', projectKey: 'ws-1', variant: 'desktop' },
      { sessionId: 'hist-oc', title: 'OpenCode token用量测算与套餐选择', state: 'done', source: 'opencode', agentName: 'OpenCode', model: 'glm-5.3', updatedAt: now - 4500000, kind: 'main', projectKey: 'ws-2' },
      { sessionId: 'hist-qd', title: '分析软件高开销原因', state: 'done', source: 'qoder', agentName: 'Qoder', model: 'dfmodel', updatedAt: now - 1800000, kind: 'main', projectKey: 'ws-1' },
      { sessionId: 'hist-cs', title: 'Deepseek API configuration', state: 'done', source: 'cursor', agentName: 'Cursor', updatedAt: now - 2400000, kind: 'main', projectKey: 'ws-2', variant: 'desktop' },
      { sessionId: 'hist-cs-cli', title: null, state: 'unknown', source: 'cursor', agentName: 'Cursor', updatedAt: now - 3600000, kind: 'main', projectKey: 'ws-1', variant: 'cli' },
      { sessionId: 'hist-act', title: '半小时前完成的会话', state: 'done', source: 'dsh', agentName: 'DSH', model: 'deepseek-flash', updatedAt: now - 1800000, kind: 'main', projectKey: 'ws-1', variant: 'desktop' },
      { sessionId: 'hist-ended', title: '昨天正常结束的会话', state: 'ended', source: 'dsh', agentName: 'DSH', model: 'deepseek-flash', updatedAt: now - 86400000, kind: 'main', projectKey: 'ws-2', variant: 'desktop' },
      { sessionId: 'hist-sub', title: '子代理历史', state: 'idle', agentName: 'DSH', kind: 'subagent', projectKey: 'ws-1', updatedAt: now - 1000 },
    ],
  },
};
}
