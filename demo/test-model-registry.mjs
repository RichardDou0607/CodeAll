#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeModelFixture } from './test-model-fixture.mjs';
import { validateModelSelection, findRegisteredModel } from '../adapters/model-registry.mjs';
import { PetBridge, createSession } from '../plugins/dsh-pet/index.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-registry-'));
const env = writeModelFixture(home);
const moduleUrl = new URL('../adapters/model-registry.mjs', import.meta.url).href;
try {
  const script = `
    import fs from 'node:fs';
    import {loadModelRegistry} from ${JSON.stringify(moduleUrl)};
    const args = {dshSelection:{provider:'dsh-provider',model:'dsh-model',reasoningEffort:'max'},dshCanCreate:true};
    const registry=loadModelRegistry(args);
    fs.writeFileSync(process.env.MOCK_CODEX_MODELS_FILE, '{"models":[]}');
    const cached=loadModelRegistry(args).codex.models.length;
    const fresh=loadModelRegistry({...args,force:true}).codex.models.length;
    fs.writeFileSync(process.env.CLAUDE_MODEL_CATALOG, '{"documentBytes":"invalid"}');
    const invalid=loadModelRegistry({...args,force:true})['claude-code'];
    fs.writeFileSync(process.env.CLAUDE_MODEL_CATALOG, JSON.stringify({
      documentBytes:Buffer.from('{"surfaces":{"cc":{"model_selector_config":{}}}}').toString('base64')
    }));
    const badShape=loadModelRegistry({...args,force:true})['claude-code'];
    const catalogReg=loadModelRegistry({...args,force:true,dshCatalog:[
      {provider:'dsh-provider',model:'dsh-model',name:'Dsh Model',reasoning:{efforts:['low','high'],defaultEffort:'high'}},
      {provider:'dsh-provider',model:'dsh-pro',name:'dsh-pro',reasoning:{efforts:['max'],defaultEffort:'max'}},
      {provider:'dsh-provider',model:'dsh-no-effort',name:null,reasoning:null},
    ]});
    console.log(JSON.stringify({registry,cached,fresh,invalid,badShape,catalogReg}));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env, HOME: home }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(run.status, 0, run.stderr);
  for (const secret of ['TEST_SECRET_NOT_FOR_OUTPUT', 'TEST_OAUTH_NOT_FOR_OUTPUT', 'TEST_ZCODE_SECRET'])
    assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret));
  const { registry, cached, fresh, invalid, badShape, catalogReg } = JSON.parse(run.stdout);
  assert.equal(registry.codex.models.length, 1);
  assert.ok(registry.codex.models[0].reasoningEfforts.includes('xhigh'));
  assert.ok(registry.codex.models[0].reasoningEfforts.includes('ultra'));
  assert.equal(validateModelSelection(registry, 'codex', 'test-model', 'ultra').ok, true);
  assert.equal(cached, 1);
  assert.equal(fresh, 0);
  assert.equal(invalid.available, false);
  assert.equal(badShape.available, false);
  assert.deepEqual(registry['claude-code'].models[0].reasoningEfforts, ['low', 'high', 'xhigh']);
  assert.equal(registry['claude-code'].models[1].canCreate, false);
  assert.equal(findRegisteredModel(registry, 'kimi-code', 'kimi-code/k3').cliModel, 'kimi-code/k3');
  assert.equal(findRegisteredModel(registry, 'kimi-code', 'k3'), null, 'bare id must not pick an arbitrary provider');
  assert.equal(registry['kimi-code'].models[2].canCreate, false, 'unknown reasoning support must not invent levels');
  assert.deepEqual(findRegisteredModel(registry, 'zcode', 'personal/vendor/model').reasoningEfforts, ['high']);
  assert.equal(validateModelSelection(registry, 'zcode', 'account:plan/glm', 'enabled').error, 'model-not-creatable');
  assert.equal(validateModelSelection(registry, 'zcode', 'personal/mock-model', 'medium').error, 'reasoning-not-supported');
  assert.equal(registry.dsh.models[0].canCreate, true);
  assert.equal(validateModelSelection(registry, 'dsh', 'dsh-provider/dsh-model', '').error, 'reasoning-required');
  // DSH 模型目录：多模型（含 pro）、模型自带档位；无档位模型展示但不可新建；目录优先于单条当前选择
  assert.equal(catalogReg.dsh.models.length, 3);
  assert.equal(catalogReg.dsh.via, 'plugin:llm-catalog');
  assert.equal(findRegisteredModel(catalogReg, 'dsh', 'dsh-provider/dsh-pro').canCreate, true);
  assert.deepEqual(findRegisteredModel(catalogReg, 'dsh', 'dsh-provider/dsh-pro').reasoningEfforts, ['max']);
  assert.equal(findRegisteredModel(catalogReg, 'dsh', 'dsh-provider/dsh-pro').label, 'dsh-provider · dsh-pro');
  assert.equal(findRegisteredModel(catalogReg, 'dsh', 'dsh-provider/dsh-no-effort').canCreate, false);
  assert.equal(validateModelSelection(catalogReg, 'dsh', 'dsh-provider/dsh-pro', 'max').ok, true);
  let createOptions = null;
  const selection = { provider: 'dsh-provider', model: 'dsh-model', reasoningEffort: 'max', apiKey: 'TEST_SECRET_NOT_FOR_OUTPUT' };
  const services = {
    agentDefaultModel: { currentSelection: () => selection },
    agents: { create: async options => {
      createOptions = options;
      return { session: { id: options.sessionId } };
    } },
    llm: {
      listProviders: () => [{ id: 'dsh-provider' }],
      listModels: async provider => (provider === 'dsh-provider'
        ? [{ id: 'dsh-model', name: 'Dsh Model', secret: 'TEST_SECRET_NOT_FOR_OUTPUT' }, { id: 'dsh-pro', name: null }] : []),
      resolveModelInfo: async (provider, model) => (model === 'dsh-pro'
        ? { reasoning: { efforts: [{ id: 'max' }], defaultEffort: 'max' } }
        : { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }),
    },
  };
  const ctx = { get: key => services[key] };
  const bridge = new PetBridge(ctx, { socket: path.join(home, 'no-server.sock') });
  let health = null;
  const capture = () => ({ writeHead() {}, end(raw) { health = JSON.parse(raw); } });
  await bridge.handle({ method: 'GET', url: '/health' }, capture());          // 目录后台构建：首探触发
  await new Promise(resolve => setTimeout(resolve, 20));
  await bridge.handle({ method: 'GET', url: '/health' }, capture());          // 第二次探测应带出目录
  assert.deepEqual(health.modelSelection, { provider: selection.provider, model: selection.model, reasoningEffort: 'max' });
  assert.ok(!JSON.stringify(health).includes(selection.apiKey));
  assert.equal(Array.isArray(health.modelCatalog), true, 'health 应透出 DSH 模型目录');
  assert.deepEqual(health.modelCatalog.map(item => item.model), ['dsh-model', 'dsh-pro']);
  assert.deepEqual(health.modelCatalog[1].reasoning.efforts, ['max']);
  assert.ok(!JSON.stringify(health).includes('TEST_SECRET_NOT_FOR_OUTPUT'), '目录与健康信息不得透出凭证');
  // 回退路径（无 sessionController）：请求模型直接进 agents.create 的 agentOptions，不再要求等于当前选择
  const changed = await createSession(ctx, { provider: selection.provider, model: 'changed-model', reasoningEffort: 'high' });
  assert.equal(changed.ok, true, '指定与默认不同的模型不再被拒');
  assert.equal(createOptions.agentOptions.model, 'changed-model');
  assert.equal(createOptions.agentOptions.reasoningEffort, 'high');
  const created = await createSession(ctx, { provider: selection.provider, model: selection.model, reasoningEffort: 'max' });
  assert.equal(created.ok, true);
  assert.equal(createOptions.agentOptions.reasoningEffort, 'max');
  // controller 路径：create（仍用默认模型）→ selectModel 安装所选模型；不传模型时不触发
  let selectModelReq = null;
  const controllerCtx = { get: key => ({
    agentDefaultModel: services.agentDefaultModel,
    sessionController: {
      create: async () => ({ sessionId: 'session-new' }),
      selectModel: async request => { selectModelReq = request; return { selected: {} }; },
    },
  })[key] };
  const viaController = await createSession(controllerCtx, { provider: 'dsh-provider', model: 'dsh-pro', reasoningEffort: 'max' });
  assert.equal(viaController.ok, true);
  assert.equal(viaController.sessionId, 'session-new');
  assert.deepEqual(selectModelReq, { sessionId: 'session-new', provider: 'dsh-provider', model: 'dsh-pro', reasoningEffort: 'max' });
  selectModelReq = null;
  assert.equal((await createSession(controllerCtx, {})).ok, true);
  assert.equal(selectModelReq, null, '未指定模型时不触发 selectModel');
  // selectModel 失败：会话已建则保留 sessionId、如实失败（不得当成功继续投递首条消息）
  const failingCtx = { get: key => key === 'sessionController' ? {
    create: async () => ({ sessionId: 'session-x' }),
    selectModel: async () => { throw new Error('model route unavailable'); },
  } : undefined };
  const failed = await createSession(failingCtx, { provider: 'dsh-provider', model: 'nope', reasoningEffort: 'max' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'model-unavailable');
  assert.equal(failed.sessionId, 'session-x');
  console.log('模型注册表：真实解析路径、CLI 查询、缓存刷新、别名、规则合并、未知档位及凭证隔离通过');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
