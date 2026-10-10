#!/usr/bin/env node
/**
 * adapters/model-registry.mjs
 *
 * Read-only model registry for the local Agent installations. The registry
 * intentionally exposes model ids and capability metadata only; credentials,
 * OAuth state and API key values never enter the returned objects.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describeModelMap, loadModelMap, mapModelName } from './model-map.mjs';

const HOME = os.homedir();
const CACHE_MS = 30_000;

let cache = { key: '', at: 0, data: null };

function emptySource(error = 'model-registry-unavailable') {
  return { available: false, error, models: [], refreshedAt: Date.now() };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set((values || []).filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))];
}

function scalarId(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return String(value.id ?? value.value ?? value.name ?? value.effort ?? '').trim();
}

function effortValues(value) {
  if (Array.isArray(value)) return unique(value.map(scalarId));
  if (value && typeof value === 'object') return unique(Object.keys(value));
  return [];
}

function modelRecord({
  value,
  label,
  providerId = null,
  modelId = value,
  cliModel = value,
  tier = null,
  reasoningEfforts = [],
  defaultReasoningEffort = null,
  canCreate = true,
  unavailableReason = null,
}) {
  const efforts = unique(reasoningEfforts);
  return {
    value: String(value || '').trim(),
    label: String(label || value || '').trim(),
    providerId: providerId == null ? null : String(providerId),
    modelId: String(modelId || value || '').trim(),
    cliModel: String(cliModel || modelId || value || '').trim(),
    reasoningEfforts: efforts,
    defaultReasoningEffort: efforts.includes(defaultReasoningEffort) ? defaultReasoningEffort : (efforts[0] || null),
    canCreate: !!canCreate && !!String(value || '').trim() && efforts.length > 0,
    ...(tier ? { tier: String(tier) } : {}),
    ...(unavailableReason ? { unavailableReason: String(unavailableReason) } : {}),
  };
}

/**
 * 映射后的模型名（用户定向 2026-10-09）：下拉、请求参数与会话展示都用「实际请求名」。
 * value 保持注册标识（选择与校验的键），label/requestModel/cliModel 换成实际请求名；
 * 切换器把整张上游模型表换掉时（map.restrict，例如只配了 GLM 供应商），
 * 目录里没被映射的条目在切换器那边没有上游模型——标为不可新建并说明原因，同时把可用的排到最前。
 */
function applyModelMap(models, map) {
  if (!map?.available) return models;
  const usable = [];
  const blocked = [];
  for (const model of models) {
    const hit = mapModelName(map, model.value, { tier: model.tier });
    if (!hit.mapped) {
      blocked.push(map.restrict
        ? {
          ...model,
          canCreate: false,
          // hidden：切换器换了整张上游模型表后，这些目录模型在新会话下拉里没有任何可选价值——
          // 直接隐藏（用户定向：简洁优先）；仍留在 /api/state 里供诊断与队列重试给出准确原因。
          hidden: true,
          unavailableReason: '该模型没有映射到当前供应商的上游模型（切换器只配置了实际使用的模型）',
        }
        : model);
      continue;
    }
    usable.push({
      ...model,
      label: hit.actual,
      requestModel: hit.actual,
      aliasLabel: model.label,
      ...(hit.cliModel ? { cliModel: hit.cliModel } : {}),
      mapping: { from: model.value, to: hit.actual, mode: hit.mode, via: hit.via },
    });
  }
  // 可用（已映射）的排前面：下拉里第一眼就是真正能请求的模型名
  return [...usable, ...blocked];
}

/** 映射签名进注册表缓存键：映射文件/配置变了，下一次快照就要重算。 */
function mapSignature(map) {
  if (!map?.available) return '-';
  return map.entries.map((e) => (e.alias || 'tier:' + e.tier) + '=' + e.actual + ':' + e.mode).join(',');
}

function source(models, extra = {}) {
  const usable = models.filter((m) => m.value);
  return {
    available: usable.length > 0,
    models: usable,
    refreshedAt: Date.now(),
    ...extra,
  };
}

function findExecutable(name, extra = []) {
  const candidates = [];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, name));
  }
  candidates.push(path.join(HOME, '.local', 'bin', name), ...extra);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch { /* continue */ }
  }
  return null;
}

function parseCodex(map = null) {
  const bin = findExecutable('codex');
  if (!bin) return emptySource('codex-cli-not-found');
  let payload;
  try {
    const raw = execFileSync(bin, ['debug', 'models'], {
      encoding: 'utf8', timeout: 8_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    payload = JSON.parse(raw);
  } catch (error) {
    return emptySource('codex-models-unreadable:' + String(error?.code || 'parse'));
  }
  const models = [];
  for (const item of payload?.models || []) {
    const id = String(item?.slug || '').trim();
    if (!id || ['hidden', 'hide'].includes(item.visibility)) continue;
    const efforts = unique((item.supported_reasoning_levels || []).map((x) => scalarId(x)));
    if (!efforts.length) continue;
    models.push(modelRecord({
      value: id,
      label: item.display_name || id,
      modelId: id,
      cliModel: id,
      reasoningEfforts: efforts,
      defaultReasoningEffort: item.default_reasoning_level,
      canCreate: item.supported_in_api !== false,
    }));
  }
  return source(applyModelMap(models, map), { executable: bin });
}

function parseClaude(map = null) {
  const file = process.env.CLAUDE_MODEL_CATALOG
    || path.join(HOME, 'Library', 'Application Support', 'Claude-3p', 'model-catalog', 'published.json');
  const wrapper = readJson(file);
  if (!wrapper) return emptySource('claude-model-catalog-unreadable');
  let document;
  try {
    document = JSON.parse(Buffer.from(String(wrapper.documentBytes || ''), 'base64').toString('utf8'));
  } catch {
    return emptySource('claude-model-catalog-invalid');
  }
  const models = [];
  for (const selector of document?.surfaces?.cc?.model_selector_config || []) {
    for (const item of selector?.models || []) {
      const id = String(item?.id || '').trim();
      if (!id) continue;
      const runtime = effortValues(item?.runtime?.effort_levels);
      const offered = effortValues(item?.thinking?.effort_options);
      const efforts = runtime.length
        ? runtime.filter((effort) => !offered.length || offered.includes(effort))
        : offered;
      models.push(modelRecord({
        value: id,
        label: item.name || item.short_name || id,
        modelId: id,
        cliModel: id,
        // 档位（Opus/Sonnet/Haiku/Fable）：直连模式下切换器用 ANTHROPIC_DEFAULT_<TIER>_MODEL 钉死实际模型
        tier: item.short_name || String(item.name || '').trim().split(/\s+/)[0] || null,
        reasoningEfforts: efforts,
        defaultReasoningEffort: item.runtime?.default_effort || item.thinking?.default_effort || null,
        canCreate: efforts.length > 0,
        unavailableReason: efforts.length ? null : 'model-does-not-expose-reasoning-effort',
      }));
    }
  }
  return source(applyModelMap(models, map), { catalog: file });
}

// Let Kimi parse TOML and apply its own registry rules. Its JSON response also
// contains provider credentials; project only model metadata, never log it.
function parseKimi() {
  const kimiHome = process.env.KIMI_CODE_HOME || process.env.KIMI_HOME || path.join(HOME, '.kimi-code');
  const bin = findExecutable('kimi', [path.join(kimiHome, 'bin', 'kimi')]);
  if (!bin) return emptySource('kimi-cli-not-found');
  let payload;
  try {
    payload = JSON.parse(execFileSync(bin, ['provider', 'list', '--json'], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch {
    return emptySource('kimi-model-registry-unreadable');
  }
  const models = [];
  for (const [alias, item] of Object.entries(payload?.models || {})) {
    if (!alias || !item?.model || !item?.provider) continue;
    const efforts = effortValues(item.supportEfforts ?? item.support_efforts);
    models.push(modelRecord({
      value: alias,
      label: item.displayName || item.display_name || alias,
      providerId: item.provider,
      modelId: item.model,
      cliModel: alias,
      reasoningEfforts: efforts,
      defaultReasoningEffort: item.defaultEffort || item.default_effort,
      canCreate: efforts.length > 0,
      unavailableReason: efforts.length ? null : 'model-does-not-expose-reasoning-effort',
    }));
  }
  return source(models, { via: 'kimi provider list --json', executable: bin });
}

function zcodeReasoningRules(config) {
  const rules = config?.config?.modelConfigRules?.modelRules || [];
  return rules.filter((r) => typeof r?.modelMatch === 'string');
}

function zcodeCapabilities(modelId, providerId, rules) {
  let efforts = [], enabled = true;
  const candidates = [modelId, providerId + '/' + modelId];
  for (const rule of rules) {
    let re;
    try { re = new RegExp(rule.modelMatch, 'i'); } catch { continue; }
    if (!candidates.some((candidate) => re.test(candidate))) continue;
    if (typeof rule.config?.enabled === 'boolean') enabled = rule.config.enabled;
    const spec = rule.config?.optionSpecs?.reasoningLevel;
    if (spec && Object.hasOwn(spec, 'values')) efforts = effortValues(spec.values);
  }
  return { efforts, enabled };
}

function zcodeProviderModels(config, rules, canCreateDefault) {
  const out = [];
  for (const rule of config?.config?.providerConfigRules?.providerRules || []) {
    const providerId = String(rule?.providerId || '').trim();
    if (!providerId) continue;
    const ids = unique([
      ...(Array.isArray(rule?.config?.modelOrder) ? rule.config.modelOrder : []),
      ...(Array.isArray(rule?.config?.personalModelIds) ? rule.config.personalModelIds : []),
      ...(Array.isArray(rule?.config?.builtinModelIds) ? rule.config.builtinModelIds : []),
    ]);
    const account = providerId.startsWith('account:');
    for (const modelId of ids) {
      const { efforts, enabled } = zcodeCapabilities(modelId, providerId, rules);
      out.push(modelRecord({
        value: providerId + '/' + modelId,
        label: providerId + ' · ' + modelId + (account ? ' · 登录态' : ''),
        providerId,
        modelId,
        cliModel: providerId + '/' + modelId,
        reasoningEfforts: efforts,
        defaultReasoningEffort: efforts.includes('max') ? 'max' : efforts[0],
        canCreate: canCreateDefault && !account && enabled && rule.config?.enabled !== false,
        unavailableReason: account ? 'account-provider-cannot-create-outside-ZCode-desktop'
          : !efforts.length ? 'model-does-not-expose-reasoning-effort' : null,
      }));
    }
  }
  return out;
}

function parseZcode() {
  const userFile = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
    || path.join(HOME, '.zcode', 'v2', 'provider_config.json');
  const builtinFile = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
    || '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';
  const user = readJson(userFile);
  const builtin = readJson(builtinFile);
  if (!user && !builtin) return emptySource('zcode-provider-registry-unreadable');
  const bin = findExecutable('zcode', ['/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs']);
  const rules = [...zcodeReasoningRules(builtin), ...zcodeReasoningRules(user)];
  const models = [
    ...zcodeProviderModels(user, rules, !!bin),
    ...zcodeProviderModels(builtin, rules, !!bin),
  ];
  const deduped = [];
  const seen = new Set();
  for (const item of models) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    deduped.push(item);
  }
  return source(deduped, { executable: bin, userConfig: userFile, builtinConfig: builtinFile });
}

function dshSource(selection, canCreate = false, catalog = null) {
  // 优先用插件透出的 DSH 模型目录（llm 注册表投影：provider×model×思考档位）——
  // 新建会话的模型下拉要能选任一注册模型（用户定向 2026-10-09）；目录不可用时退回单条当前选择。
  if (Array.isArray(catalog) && catalog.length) {
    const models = [];
    const seen = new Set();
    for (const item of catalog) {
      const providerId = String(item?.provider || '').trim();
      const modelId = String(item?.model || '').trim();
      if (!providerId || !modelId) continue;
      const value = providerId + '/' + modelId;
      if (seen.has(value)) continue;
      seen.add(value);
      const efforts = unique((item?.reasoning?.efforts || []).map(scalarId));
      const name = String(item?.name || '').trim();
      models.push(modelRecord({
        value,
        label: providerId + ' · ' + modelId + (name && name !== modelId ? ' · ' + name : ''),
        providerId,
        modelId,
        cliModel: value,
        reasoningEfforts: efforts,
        defaultReasoningEffort: item?.reasoning?.defaultEffort ?? null,
        canCreate: canCreate && efforts.length > 0,
        unavailableReason: efforts.length ? null : 'model-does-not-expose-reasoning-effort',
      }));
    }
    if (models.length) return source(models, { via: 'plugin:llm-catalog' });
  }
  const providerId = String(selection?.provider ?? selection?.providerId ?? '').trim();
  const modelId = String(selection?.model ?? selection?.modelId ?? '').trim();
  const effort = String(selection?.reasoningEffort ?? selection?.thoughtLevel ?? selection?.options?.reasoningLevel ?? '').trim();
  if (!providerId || !modelId || !effort) {
    return emptySource('dsh-model-selection-unavailable');
  }
  const value = providerId + '/' + modelId;
  return source([modelRecord({
    value,
    label: providerId + ' · ' + modelId,
    providerId,
    modelId,
    cliModel: value,
    reasoningEfforts: [effort],
    defaultReasoningEffort: effort,
    canCreate,
  })], { via: 'agentDefaultModel.currentSelection' });
}

export function loadModelRegistry({ dshSelection = null, dshCanCreate = false, dshCatalog = null, force = false } = {}) {
  const safeMap = (source) => {
    try { return loadModelMap({ source }); } catch { return null; }
  };
  const claudeMap = safeMap('claude-code');
  const codexMap = safeMap('codex');
  const dshKey = JSON.stringify([dshSelection || null, dshCatalog || null]);
  const key = dshKey + '|' + String(dshCanCreate) + '|' + mapSignature(claudeMap) + '|' + mapSignature(codexMap);
  if (!force && cache.data && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;
  const safeLoad = (load) => {
    try { return load(); } catch { return emptySource('model-registry-invalid'); }
  };
  const data = {
    dsh: dshSource(dshSelection, dshCanCreate, dshCatalog),
    'claude-code': safeLoad(() => parseClaude(claudeMap)),
    codex: safeLoad(() => parseCodex(codexMap)),
    'kimi-code': safeLoad(parseKimi),
    zcode: safeLoad(parseZcode),
    // 诊断用：当前生效的「注册名 → 实际请求名」映射（来自各 CLI 的实际请求配置）
    mapping: {
      'claude-code': describeModelMap(claudeMap),
      codex: describeModelMap(codexMap),
    },
    refreshedAt: Date.now(),
  };
  cache = { key, at: Date.now(), data };
  return data;
}

export function findRegisteredModel(registry, sourceName, value) {
  const value0 = String(value || '').trim();
  const models = registry?.[sourceName]?.models || [];
  return models.find((m) => m.value === value0) || null;
}

export function validateModelSelection(registry, sourceName, model, reasoningEffort) {
  const entry = registry?.[sourceName];
  if (!entry?.available) return { ok: false, error: 'model-registry-unavailable', detail: entry?.error || '该 Agent 的模型注册表不可用' };
  if (!String(model || '').trim()) return { ok: false, error: 'model-required', detail: '请选择已注册模型' };
  const selected = findRegisteredModel(registry, sourceName, model);
  if (!selected) return { ok: false, error: 'model-not-registered', detail: '所选模型不在该 Agent 当前注册表中' };
  if (!selected.canCreate) return { ok: false, error: 'model-not-creatable', detail: selected.unavailableReason || '该模型不能用于新建会话' };
  const effort = String(reasoningEffort || '').trim();
  if (!effort) return { ok: false, error: 'reasoning-required', detail: '新建会话必须选择思考强度' };
  if (!selected.reasoningEfforts.includes(effort)) {
    return { ok: false, error: 'reasoning-not-supported', detail: '该模型不支持所选思考强度' };
  }
  return { ok: true, model: selected, reasoningEffort: effort };
}
