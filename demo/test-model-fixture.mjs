import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// All fixtures live under an isolated HOME; never read the user's credentials.
export function writeModelFixture(home) {
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ['claude', 'codex', 'kimi', 'opencode', 'cursor-agent']) {
    const bin = path.join(binDir, name);
    fs.copyFileSync(fileURLToPath(new URL('./mock-cli-create.cjs', import.meta.url)), bin);
    fs.chmodSync(bin, 0o755);
  }
  const qoderBin = path.join(home, '.qoder-cn', 'bin', 'qoderclicn', 'qoderclicn-9.9.9');
  fs.mkdirSync(path.dirname(qoderBin), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('./mock-cli-create.cjs', import.meta.url)), qoderBin);
  fs.chmodSync(qoderBin, 0o755);
  const file = (name, data) => {
    const location = path.join(home, name);
    fs.writeFileSync(location, JSON.stringify(data));
    return location;
  };
  const codex = file('codex-models.json', {
    models: [
      { slug: 'test-model', display_name: 'Test Model', supported_in_api: true,
        default_reasoning_level: 'high',
        supported_reasoning_levels: ['low', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })) },
      { slug: 'hidden-model', visibility: 'hide', supported_reasoning_levels: [{ effort: 'high' }] },
    ],
  });
  const kimi = file('kimi-models.json', {
    providers: { 'managed:kimi-code': { apiKey: 'TEST_SECRET_NOT_FOR_OUTPUT', oauth: { token: 'TEST_OAUTH_NOT_FOR_OUTPUT' } } },
    models: {
      'kimi-code/k3': { provider: 'managed:kimi-code', model: 'k3', displayName: 'K3',
        supportEfforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      'other/k3': { provider: 'other', model: 'k3', supportEfforts: ['max'] },
      'kimi-code/unknown-efforts': { provider: 'managed:kimi-code', model: 'legacy', capabilities: ['thinking'] },
    },
  });
  const claude = file('claude-catalog.json', {
    documentBytes: Buffer.from(JSON.stringify({
      surfaces: { cc: { model_selector_config: [{ models: [
        { id: 'sonnet', name: 'Sonnet', runtime: { effort_levels: ['low', 'high', 'xhigh'] },
          thinking: { effort_options: ['low', 'high', 'xhigh', 'max'].map(value => ({ value })) } },
        { id: 'haiku', name: 'Haiku', thinking: {} },
      ] }] } },
    })).toString('base64'),
  });
  const personal = file('zcode-personal.json', { config: {
    providerConfigRules: { providerRules: [
      { providerId: 'personal', config: { modelOrder: ['mock-model', 'vendor/model'], access: { apiKey: 'TEST_ZCODE_SECRET' } } },
    ] },
    modelConfigRules: { modelRules: [
      { modelMatch: '^vendor/model$', config: { optionSpecs: { reasoningLevel: { values: ['high'] } } } },
    ] },
  } });
  const builtin = file('zcode-builtin.json', { config: {
    providerConfigRules: { providerRules: [
      { providerId: 'account:plan', config: { builtinModelIds: ['glm'] } },
    ] },
    modelConfigRules: { modelRules: [
      { modelMatch: '.*', config: { optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } } },
      { modelMatch: '^mock-model$', config: { optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] } } } },
    ] },
  } });
  // 会话目录证据：新建会话的工作目录约束要求「该 Agent 有已观察到的项目文件夹」——
  // 三个 CLI 源各造一条 cwd=home 的主会话（HOME 已被测试隔离；zcode 由调用方的临时 DB 提供）
  const jsonl = (rel, lines) => {
    const location = path.join(home, rel);
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(location, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  };
  jsonl(path.join('.claude', 'projects', 'fixture-project', 'sess_fixture_cc.jsonl'),
    [{ type: 'user', cwd: home, message: { content: 'fixture' } }]);
  jsonl(path.join('.codex', 'sessions', '2026', '10', '09', 'rollout-2026-10-09T00-00-00-00000000-0000-4000-8000-000000000001.jsonl'),
    [{ type: 'session_meta', timestamp: new Date().toISOString(), payload: { session_id: 'sess_fixture_cx', cwd: home, cli_version: '9.9.9' } }]);
  const kimiState = path.join(home, '.kimi-code', 'sessions', 'wd_fixture', 'session_sess_fixture_km', 'state.json');
  fs.mkdirSync(path.dirname(kimiState), { recursive: true });
  fs.writeFileSync(kimiState, JSON.stringify({ id: 'sess_fixture_km', cwd: home, createdAt: Date.now(), updatedAt: Date.now(), archived: false }));
  return {
    PATH: binDir + path.delimiter + process.env.PATH,
    MOCK_CODEX_MODELS_FILE: codex,
    MOCK_KIMI_MODELS_FILE: kimi,
    MOCK_CLI_CALLS: path.join(home, 'cli-calls.jsonl'),
    CLAUDE_MODEL_CATALOG: claude,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
  };
}
