#!/usr/bin/env node
/**
 * demo/test-model-map.mjs — 模型名映射隔离回归（用户定向 2026-10-09）
 *
 * 断言「注册名 → 实际请求名」只从各 CLI 的**实际请求配置**里取：
 *   Claude Code：~/.claude/settings.json 的 env 成对变量（_MODEL ↔ _MODEL_NAME；直连模式只有 _MODEL）
 *   Codex CLI：~/.codex/config.toml + 切换器（cc-switch）当前供应商的路由表/env
 *   两者都可被 ~/.agent-pet/model-map.json 覆盖；没有映射时一律保持原样。
 * 全部走临时 HOME + mock CLI + 合成转录/rollout，不读真实凭据、不启动真实 Agent。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-model-map-'));
const SECRET = 'TEST_SECRET_NOT_FOR_OUTPUT';
const REGISTRY = new URL('../adapters/model-registry.mjs', import.meta.url).href;
const CODEX_ADAPTER = new URL('../adapters/codex-adapter.mjs', import.meta.url).href;
const CLAUDE_ADAPTER = new URL('../adapters/claude-code-adapter.mjs', import.meta.url).href;
const MOCK_CLI = fileURLToPath(new URL('./mock-cli-create.cjs', import.meta.url));

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
};
const writeLines = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
};
const claudeCatalog = (models) => writeJson(path.join(root, 'catalog-' + Math.random().toString(36).slice(2) + '.json'), {
  documentBytes: Buffer.from(JSON.stringify({ surfaces: { cc: { model_selector_config: [{ models }] } } })).toString('base64'),
});
const codexModels = (models) => writeJson(path.join(root, 'codex-' + Math.random().toString(36).slice(2) + '.json'), { models });

/** 子进程跑断言脚本：HOME/env 完全隔离（注册表与适配器都在子进程里重新读盘）。 */
function runScenario(script, env) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.ok(!run.stdout.includes(SECRET) && !run.stderr.includes(SECRET), '映射链路不得透出凭证');
  return JSON.parse(run.stdout.trim().split('\n').pop());
}

try {
  // ---------------------------------------------------------------- A. Claude Code：路由模式（settings.json 成对变量）
  const homeA = path.join(root, 'claude-routed');
  const catalogA = claudeCatalog([
    { id: 'claude-opus-5', name: 'Opus 5', short_name: 'Opus', runtime: { effort_levels: ['low', 'high'] } },
    { id: 'claude-sonnet-5', name: 'Sonnet 5', short_name: 'Sonnet', runtime: { effort_levels: ['low', 'high'] } },
    { id: 'claude-opus-4-8', name: 'Opus 4.8', short_name: 'Opus', runtime: { effort_levels: ['low'] } },
  ]);
  writeJson(path.join(homeA, '.claude', 'settings.json'), {
    effortLevel: 'high',
    env: {
      ANTHROPIC_AUTH_TOKEN: SECRET,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'glm-5.3-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'glm-5.2',
    },
  });
  const transcriptA = writeLines(path.join(homeA, '.claude', 'projects', 'proj', 'sess_a.jsonl'), [
    { type: 'user', cwd: homeA, message: { content: 'hi' } },
    { type: 'assistant', cwd: homeA, message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }] } },
  ]);
  const outA = runScenario(`
    import fs from 'node:fs';
    import { loadModelRegistry, findRegisteredModel, validateModelSelection } from ${JSON.stringify(REGISTRY)};
    import { parseClaudeSession } from ${JSON.stringify(CLAUDE_ADAPTER)};
    const registry = loadModelRegistry({});
    const session = parseClaudeSession(${JSON.stringify(transcriptA)});
    const validated = validateModelSelection(registry, 'claude-code', 'claude-opus-5', 'high');
    console.log(JSON.stringify({
      validated: { ok: validated.ok, error: validated.error, cliModel: validated.model?.cliModel, label: validated.model?.label },
      opus: findRegisteredModel(registry, 'claude-code', 'claude-opus-5'),
      sonnet: findRegisteredModel(registry, 'claude-code', 'claude-sonnet-5'),
      plain: findRegisteredModel(registry, 'claude-code', 'claude-opus-4-8'),
      mapping: registry.mapping['claude-code'],
      session: { model: session.model, modelRaw: session.modelRaw, source: session.metaSources.model },
    }));
  `, { HOME: homeA, CLAUDE_MODEL_CATALOG: catalogA });
  assert.equal(outA.opus.label, 'glm-5.3-flash', '路由模式：下拉显示实际请求名');
  assert.equal(outA.opus.requestModel, 'glm-5.3-flash');
  assert.equal(outA.opus.value, 'claude-opus-5', 'value 仍是注册标识（选择/校验的键）');
  assert.equal(outA.opus.cliModel, 'glm-5.3-flash', '请求参数用实际请求名（上游认识的是它；cc-switch 代理实测直传 glm-* 全 200）');
  assert.equal(outA.validated.cliModel, 'glm-5.3-flash', '新建校验返回的条目带着实际请求名，CLI 拿到的就是它');
  assert.equal(outA.validated.ok, true);
  assert.equal(outA.opus.mapping.mode, 'routed');
  assert.match(outA.opus.mapping.via, /ANTHROPIC_DEFAULT_OPUS_MODEL_NAME/);
  assert.equal(outA.sonnet.label, 'glm-5.2');
  assert.equal(outA.plain.label, 'Opus 4.8', '没有映射的模型保持原名');
  assert.equal(outA.plain.canCreate, false, '切换器换了整个上游模型表时，未映射的目录模型不能新建');
  assert.equal(outA.plain.hidden, true, '这些不可调用的模型标 hidden，由界面直接隐藏（简洁优先）');
  assert.match(outA.plain.unavailableReason, /上游模型/);
  assert.equal(outA.mapping.available, true);
  assert.equal(outA.mapping.restrict, true, '上游是别的模型家族 → 目录里未映射的条目标为不可用');
  assert.equal(outA.session.model, 'glm-5.3-flash', '会话展示用实际请求名');
  assert.equal(outA.session.modelRaw, 'claude-opus-5', '原注册名保留在 modelRaw');
  assert.match(outA.session.source, /model-map/);

  // ---------------------------------------------------------------- B. Claude Code：直连模式（只有 _MODEL，按档位钉死）
  const homeB = path.join(root, 'claude-direct');
  const catalogB = claudeCatalog([
    { id: 'claude-sonnet-5', name: 'Sonnet 5', short_name: 'Sonnet', runtime: { effort_levels: ['low', 'high'] } },
  ]);
  writeJson(path.join(homeB, '.claude', 'settings.json'), {
    env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2', ANTHROPIC_AUTH_TOKEN: SECRET },
  });
  const outB = runScenario(`
    import { loadModelRegistry, findRegisteredModel } from ${JSON.stringify(REGISTRY)};
    const registry = loadModelRegistry({});
    console.log(JSON.stringify({
      sonnet: findRegisteredModel(registry, 'claude-code', 'claude-sonnet-5'),
      mapping: registry.mapping['claude-code'],
    }));
  `, { HOME: homeB, CLAUDE_MODEL_CATALOG: catalogB });
  assert.equal(outB.sonnet.label, 'glm-5.2', '直连模式：档位映射到上游真实模型名');
  assert.equal(outB.sonnet.cliModel, 'glm-5.2', '直连模式：上游模型名本身可用，CLI 参数换成它');
  assert.equal(outB.sonnet.mapping.mode, 'direct');
  assert.equal(outB.sonnet.value, 'claude-sonnet-5');

  // ---------------------------------------------------------------- C. Codex：显式覆盖文件
  const homeC = path.join(root, 'codex-override');
  const binDir = path.join(homeC, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(MOCK_CLI, path.join(binDir, 'codex'));
  fs.chmodSync(path.join(binDir, 'codex'), 0o755);
  const modelsC = codexModels([
    { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', supported_in_api: true, supported_reasoning_levels: [{ effort: 'high' }] },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', supported_in_api: true, supported_reasoning_levels: [{ effort: 'low' }] },
  ]);
  writeJson(path.join(homeC, '.agent-pet', 'model-map.json'), { codex: { 'gpt-6-sol': 'glm-5.3' } });
  const rolloutC = writeLines(path.join(homeC, '.codex', 'sessions', '2026', '10', '09', 'rollout-x.jsonl'), [
    { type: 'session_meta', timestamp: new Date().toISOString(), payload: { session_id: 'sess_c', cwd: homeC, cli_version: '9.9.9' } },
    { type: 'turn_context', timestamp: new Date().toISOString(), payload: { model: 'gpt-6-sol', effort: 'high' } },
  ]);
  const outC = runScenario(`
    import { loadModelRegistry, findRegisteredModel } from ${JSON.stringify(REGISTRY)};
    import { parseCodexSession } from ${JSON.stringify(CODEX_ADAPTER)};
    const registry = loadModelRegistry({});
    const session = parseCodexSession(${JSON.stringify(rolloutC)});
    console.log(JSON.stringify({
      sol: findRegisteredModel(registry, 'codex', 'gpt-6-sol'),
      luna: findRegisteredModel(registry, 'codex', 'gpt-6-luna'),
      mapping: registry.mapping.codex,
      session: { model: session.model, modelRaw: session.modelRaw },
    }));
  `, { HOME: homeC, PATH: binDir + path.delimiter + process.env.PATH, MOCK_CODEX_MODELS_FILE: modelsC });
  assert.equal(outC.sol.label, 'glm-5.3', 'Codex：覆盖文件把注册名映射到实际请求名');
  assert.equal(outC.sol.value, 'gpt-6-sol');
  assert.equal(outC.sol.cliModel, 'glm-5.3', 'Codex：请求参数同样用实际请求名');
  assert.equal(outC.luna.label, 'GPT-6-Luna', '未覆盖的模型保持原名');
  assert.equal(outC.luna.canCreate, false, '上游换成 GLM 后，没映射的注册模型不能新建');
  assert.equal(outC.mapping.restrict, true);
  assert.equal(outC.session.model, 'glm-5.3', 'rollout 里记的注册名在展示时映射为实际请求名');
  assert.equal(outC.session.modelRaw, 'gpt-6-sol');

  // ---------------------------------------------------------------- D. Codex：切换器当前供应商的路由表（cc-switch）
  const homeD = path.join(root, 'codex-ccswitch');
  fs.mkdirSync(path.join(homeD, '.cc-switch'), { recursive: true });
  const db = new DatabaseSync(path.join(homeD, '.cc-switch', 'cc-switch.db'));
  db.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT, is_current INTEGER)');
  db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?)').run('p1', 'codex', 'Zhipu GLM', JSON.stringify({
    config: 'model = "gpt-6-sol"\nmodel_provider = "glm"\n[model_providers.glm]\nbase_url = "https://open.bigmodel.cn/api/coding/paas/v4"\n',
  }), JSON.stringify({ codexModelRoutes: { 'gpt-6-sol': { model: 'glm-5.3', labelOverride: 'glm-5.3' } } }), 1);
  db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?)').run('p2', 'codex', 'old', '{}', '{}', 0);
  db.close();
  writeJson(path.join(homeD, '.codex', 'config.toml.placeholder'), {});
  fs.writeFileSync(path.join(homeD, '.codex', 'config.toml'),
    'model = "gpt-6-sol"\nmodel_provider = "glm"\n\n[model_providers.glm]\nname = "glm"\nbase_url = "http://127.0.0.1:15721/v1"\n');
  fs.mkdirSync(path.join(homeD, 'bin'), { recursive: true });
  fs.copyFileSync(MOCK_CLI, path.join(homeD, 'bin', 'codex'));
  fs.chmodSync(path.join(homeD, 'bin', 'codex'), 0o755);
  const outD = runScenario(`
    import { loadModelRegistry, findRegisteredModel } from ${JSON.stringify(REGISTRY)};
    const registry = loadModelRegistry({});
    const sol = findRegisteredModel(registry, 'codex', 'gpt-6-sol');
    console.log(JSON.stringify({ sol, mapping: registry.mapping.codex }));
  `, { HOME: homeD, PATH: path.join(homeD, 'bin') + path.delimiter + process.env.PATH, MOCK_CODEX_MODELS_FILE: modelsC });
  assert.equal(outD.sol.label, 'glm-5.3', '切换器路由表（本地代理接管）也能取到实际请求名');
  assert.equal(outD.sol.cliModel, 'glm-5.3', '请求参数用实际请求名');
  assert.match(outD.sol.mapping.via, /cc-switch:codexModelRoutes/);
  assert.equal(outD.mapping.requestConfig.viaProxy, true, '识别出供应商指向本地路由代理');

  // ---------------------------------------------------------------- E. 无映射：一切保持原样
  const homeE = path.join(root, 'plain');
  fs.mkdirSync(path.join(homeE, 'bin'), { recursive: true });
  fs.copyFileSync(MOCK_CLI, path.join(homeE, 'bin', 'codex'));
  fs.chmodSync(path.join(homeE, 'bin', 'codex'), 0o755);
  const outE = runScenario(`
    import { loadModelRegistry, findRegisteredModel } from ${JSON.stringify(REGISTRY)};
    const registry = loadModelRegistry({});
    console.log(JSON.stringify({
      sol: findRegisteredModel(registry, 'codex', 'gpt-6-sol'),
      mapping: registry.mapping.codex,
    }));
  `, { HOME: homeE, PATH: path.join(homeE, 'bin') + path.delimiter + process.env.PATH, MOCK_CODEX_MODELS_FILE: modelsC });
  assert.equal(outE.sol.label, 'GPT-6-Sol');
  assert.equal(outE.sol.requestModel, undefined);
  assert.equal(outE.mapping.available, false);

  // ---------------------------------------------------------------- F. 切换器 DB 里的过期 model 不得污染映射
  const homeF = path.join(root, 'stale');
  fs.mkdirSync(path.join(homeF, '.cc-switch'), { recursive: true });
  const db2 = new DatabaseSync(path.join(homeF, '.cc-switch', 'cc-switch.db'));
  db2.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT, is_current INTEGER)');
  db2.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?)').run('p1', 'codex', 'default', JSON.stringify({ config: 'model = "stale-model"\n' }), '{}', 1);
  db2.close();
  fs.mkdirSync(path.join(homeF, '.codex'), { recursive: true });
  // base_url 故意带内嵌凭据与查询串：诊断透出必须脱敏（runScenario 会断言 SECRET 不出现在输出里）
  fs.writeFileSync(path.join(homeF, '.codex', 'config.toml'), 'model = "gpt-6-sol"\nmodel_provider = "custom"\n\n[model_providers.custom]\nbase_url = "https://user:' + SECRET + '@relay.example/v1?key=' + SECRET + '"\n');
  fs.mkdirSync(path.join(homeF, 'bin'), { recursive: true });
  fs.copyFileSync(MOCK_CLI, path.join(homeF, 'bin', 'codex'));
  fs.chmodSync(path.join(homeF, 'bin', 'codex'), 0o755);
  const outF = runScenario(`
    import { loadModelRegistry, findRegisteredModel } from ${JSON.stringify(REGISTRY)};
    const registry = loadModelRegistry({});
    console.log(JSON.stringify({ sol: findRegisteredModel(registry, 'codex', 'gpt-6-sol'), mapping: registry.mapping.codex }));
  `, { HOME: homeF, PATH: path.join(homeF, 'bin') + path.delimiter + process.env.PATH, MOCK_CODEX_MODELS_FILE: modelsC });
  assert.equal(outF.sol.label, 'GPT-6-Sol', '切换器里存的旧 model 不能覆盖 config.toml 的当前模型');
  assert.equal(outF.mapping.available, false);
  assert.equal(outF.mapping.requestConfig.staleProviderModel, 'stale-model', '只作诊断暴露，不参与映射');
  assert.equal(outF.mapping.requestConfig.baseUrl, 'https://relay.example/v1?…', '诊断里的 base_url 必须脱敏（去凭据与查询串）');

  console.log('模型名映射：实际请求配置解析、直连/路由两种口径、切换器路由表、覆盖文件、无映射降级与凭证隔离通过');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
