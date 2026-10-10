#!/usr/bin/env node
/**
 * adapters/model-map.mjs
 *
 * 把「注册名/别名」解析成「实际请求的模型名」（用户定向 2026-10-09）。
 *
 * 背景：Codex CLI / Claude Code CLI 的模型常被 cc-switch 一类切换器做映射——
 * Claude Code 侧由 ~/.claude/settings.json 的 env 决定（ANTHROPIC_DEFAULT_OPUS_MODEL
 * 是 CLI 用的注册名，ANTHROPIC_DEFAULT_OPUS_MODEL_NAME 是真正发到上游的模型名）；
 * Codex 侧由 ~/.codex/config.toml 的 model/model_provider + 切换器（cc-switch /
 * Codex++）写在供应商配置里的路由表决定。两边共同点是：**实际请求名 + 在请求配置里**，
 * 不在目录展示名里。因此这里只读「实际请求配置」，按下面的优先级取映射：
 *
 *   ① ~/.agent-pet/model-map.json（用户显式覆盖，最高优先，任何来源都能钉死）
 *   ② Claude Code：$CLAUDE_CONFIG_DIR|~/.claude/settings.json 的 env 成对变量
 *   ③ Codex：~/.codex/config.toml（model/model_provider/[model_providers.*]）+
 *      cc-switch 当前激活供应商（~/.cc-switch/cc-switch.db 只读）的路由表/env
 *
 * 只读、无凭据输出、失败一律降级为「无映射」（返回原名），不抛错、不阻断调用方。
 * 覆盖：AGENT_PET_MODEL_MAP（映射文件路径）、CLAUDE_CONFIG_DIR、CODEX_HOME、CC_SWITCH_DB。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CACHE_MS = 30_000;
const TIERS = ['OPUS', 'SONNET', 'HAIKU', 'FABLE'];
/** cc-switch 路由表里可能承载「实际上游模型名」的字段（ClaudeDesktopModelRoute 同款：model）。 */
const ROUTE_VALUE_KEYS = ['model', 'upstream', 'upstreamModel', 'target', 'actual', 'requestModel', 'request_model', 'to'];

let cache = { key: '', at: 0, data: null };

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readJson(file) {
  const text = readText(file);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** 诊断用 URL：去掉可能内嵌的凭据与查询串，只留 scheme+host+path。 */
function sanitizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : 'http://' + raw);
    url.username = '';
    url.password = '';
    const query = url.search ? '?…' : '';
    return url.origin + url.pathname + query;
  } catch {
    return raw.replace(/\/\/[^/@\s]+@/, '//');
  }
}

function stripQuotes(value) {
  const v = String(value ?? '').trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

/** 极简 TOML：顶级 key = value + [section] 分段（只取标量，够读 Codex config.toml）。 */
function parseToml(text) {
  const root = {};
  const sections = {};
  let current = root;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const name = section[1].trim();
      current = sections[name] = sections[name] || {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    current[kv[1]] = stripQuotes(kv[2].replace(/,(\s*)$/, ''));
  }
  return { root, sections };
}

function addEntry(entries, entry) {
  const alias = String(entry.alias ?? '').trim();
  const tier = String(entry.tier ?? '').trim();
  const actual = String(entry.actual ?? '').trim();
  if (!actual) return;
  if (!alias && !tier) return;
  if (alias && alias.toLowerCase() === actual.toLowerCase()) return;
  const key = (alias || 'tier:' + tier).toLowerCase();
  if (entries.some((e) => (e.alias || 'tier:' + e.tier).toLowerCase() === key)) return;
  // mode：routed=CLI 侧仍用注册名（映射发生在切换器/代理），direct=上游模型名本身就是可用的请求名
  entries.push({ ...(alias ? { alias } : {}), ...(tier ? { tier } : {}), actual, mode: entry.mode === 'direct' ? 'direct' : 'routed', via: String(entry.via || '') });
}

/**
 * env 成对变量：FOO_MODEL 是 CLI 侧注册名，FOO_MODEL_NAME 是实际请求名；
 * 只有 FOO_MODEL 时（直连模式）它就是实际请求名——按 tier 记一条，供目录按档位回填。
 */
function envEntries(env, entries, { tiers = TIERS, file, extra = [] } = {}) {
  const pick = (key) => (typeof env?.[key] === 'string' ? env[key].trim() : '');
  for (const prefix of extra) {
    const alias = pick(prefix + '_MODEL');
    const actual = pick(prefix + '_MODEL_NAME');
    if (alias && actual) addEntry(entries, { alias, actual, via: file + ':' + prefix + '_MODEL_NAME' });
  }
  for (const tier of tiers) {
    const alias = pick('ANTHROPIC_DEFAULT_' + tier + '_MODEL');
    const actual = pick('ANTHROPIC_DEFAULT_' + tier + '_MODEL_NAME');
    if (alias && actual) addEntry(entries, { alias, actual, via: file + ':ANTHROPIC_DEFAULT_' + tier + '_MODEL_NAME' });
    else if (alias) addEntry(entries, { tier, actual: alias, mode: 'direct', via: file + ':ANTHROPIC_DEFAULT_' + tier + '_MODEL（直连）' });
  }
  return entries;
}

/** ① 显式覆盖文件：{"codex":{"gpt-6-sol":"glm-5.3"},"claude-code":{...}} */
function overrideEntries(home, env, source) {
  const file = env.AGENT_PET_MODEL_MAP || path.join(home, '.agent-pet', 'model-map.json');
  const doc = readJson(file);
  if (!doc || typeof doc !== 'object') return { entries: [], file };
  const entries = [];
  const bucket = doc[source];
  const pairs = Array.isArray(bucket)
    ? bucket
    : (bucket && typeof bucket === 'object' ? Object.entries(bucket).map(([alias, actual]) => ({ alias, actual })) : []);
  for (const item of pairs) {
    if (!item || typeof item !== 'object') continue;
    addEntry(entries, { alias: item.alias ?? item.from, actual: item.actual ?? item.to ?? item.model, mode: item.mode, via: 'model-map.json' });
  }
  return { entries, file };
}

/** Claude Code：settings.json 的 env 就是它的实际请求配置（BASE_URL 指向谁、用哪个模型名都在这）。 */
function claudeEntries(home, env) {
  const dir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
  const entries = [];
  const files = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(dir, name);
    const doc = readJson(file);
    if (!doc) continue;
    files.push(file);
    envEntries(doc.env, entries, { file: name, extra: ['ANTHROPIC', 'ANTHROPIC_SMALL_FAST'] });
  }
  return { entries, files };
}

/** 从 cc-switch 供应商 meta 里抽路由表：{"claude-opus-5":{"model":"glm-5.3-flash"},...}（codex 同构）。 */
function routeEntries(meta, entries, file) {
  if (!meta || typeof meta !== 'object') return entries;
  for (const [key, value] of Object.entries(meta)) {
    if (!/route|mapping|override/i.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [alias, rule] of Object.entries(value)) {
      if (typeof rule === 'string') { addEntry(entries, { alias, actual: rule, via: 'cc-switch:' + key }); continue; }
      if (!rule || typeof rule !== 'object') continue;
      const actual = ROUTE_VALUE_KEYS.map((k) => rule[k]).find((v) => typeof v === 'string' && v.trim());
      if (actual) addEntry(entries, { alias, actual, via: 'cc-switch:' + key });
    }
  }
  return entries;
}

/** cc-switch 当前激活供应商（该 app_type 的「实际请求配置」）：meta 路由表 + settings_config 的 env/config。 */
function ccSwitchProvider(home, env, appType) {
  const file = env.CC_SWITCH_DB || path.join(home, '.cc-switch', 'cc-switch.db');
  if (!fs.existsSync(file)) return { entries: [], file: null };
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare('SELECT id, name, settings_config, meta FROM providers WHERE app_type = ? AND is_current = 1 LIMIT 1').get(appType);
    if (!row) return { entries: [], file };
    const entries = [];
    let meta = null;
    try { meta = JSON.parse(row.meta || '{}'); } catch { meta = null; }
    routeEntries(meta, entries, file);
    const settings = (() => { try { return JSON.parse(row.settings_config || '{}'); } catch { return null; } })();
    const label = 'cc-switch:' + appType + ':' + String(row.name || row.id || '');
    envEntries(settings?.env, entries, { file: label, extra: ['ANTHROPIC', 'ANTHROPIC_SMALL_FAST', 'OPENAI'] });
    const configText = typeof settings?.config === 'string' ? settings.config : '';
    const toml = configText ? parseToml(configText) : null;
    // settings_config.config 是该供应商会写进 config.toml 的正文：model 即实际请求名（仅作诊断与回退）
    const configured = toml?.root?.model ? String(toml.root.model).trim() : null;
    return { entries, file, provider: { id: row.id, name: row.name }, configuredModel: configured };
  } catch {
    return { entries: [], file };
  } finally {
    try { db?.close(); } catch { /* 只读连接，关不掉也不影响 */ }
  }
}

/**
 * Codex CLI：实际请求配置 = CODEX_HOME/config.toml（model/model_provider/base_url）。
 * 供应商指向本地路由代理（cc-switch 等）时，别名→实际名的规则在切换器那一侧，读它的当前供应商。
 */
function codexEntries(home, env) {
  const dir = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const files = [];
  const entries = [];
  let info = null;
  const configFile = path.join(dir, 'config.toml');
  const text = readText(configFile);
  if (text != null) {
    files.push(configFile);
    const toml = parseToml(text);
    const model = String(toml.root.model || '').trim();
    const providerId = String(toml.root.model_provider || '').trim();
    const provider = providerId ? (toml.sections['model_providers.' + providerId] || {}) : {};
    const baseUrl = String(provider.base_url || '').trim();
    const viaProxy = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(baseUrl);
    info = { model, providerId, baseUrl: sanitizeUrl(baseUrl), viaProxy, catalogFile: String(toml.root.model_catalog_json || '').trim() };
  }
  const cc = ccSwitchProvider(home, env, 'codex');
  if (cc.entries.length) {
    entries.push(...cc.entries);
    files.push(...(cc.file ? [cc.file] : []));
  }
  // 注意：切换器 DB 里存的是「切过去时该写的正文」，用户后来在 Codex 里改过模型就会过期，
  // 因此绝不用它覆盖 config.toml 的 model——只信真正的路由表/env 成对变量（见 routeEntries）。
  if (info && cc.configuredModel && cc.configuredModel !== info.model) info.staleProviderModel = cc.configuredModel;
  return { entries, files, info };
}

/** 该来源的目录模型名家族：映射到别的家族说明切换器换掉了整个上游模型表。 */
function sameFamily(source, name) {
  const value = String(name || '').trim();
  if (!value) return true;
  if (source === 'claude-code') return /^claude[-.]/i.test(value);
  if (source === 'codex') return /^(gpt|o[0-9]|codex|chatgpt)[-.]?/i.test(value);
  return true;
}

function buildMap(source, home, env) {
  const override = overrideEntries(home, env, source);
  const entries = [...override.entries];
  const files = override.entries.length ? [override.file] : [];
  let detail = null;
  if (source === 'claude-code') {
    const claude = claudeEntries(home, env);
    entries.push(...claude.entries);
    files.push(...claude.files);
  } else if (source === 'codex') {
    const codex = codexEntries(home, env);
    entries.push(...codex.entries);
    files.push(...codex.files);
    detail = codex.info;
  }
  // restrict：实际请求配置把模型钉到了「另一个模型家族」（如 Claude 目录 → GLM）。
  // 这种情况下目录里没被映射的条目在切换器那边没有上游模型，不能拿它新建会话。
  const restrict = entries.length > 0 && entries.some((e) => !sameFamily(source, e.actual));
  return {
    source,
    available: entries.length > 0,
    restrict,
    entries,
    files: [...new Set(files)].filter(Boolean),
    via: entries.length ? [...new Set(entries.map((e) => String(e.via || '').split(':')[0]).filter(Boolean))] : [],
    ...(detail ? { requestConfig: detail } : {}),
  };
}

/** 只读一次实际请求配置（30s 缓存；HOME/DB 路径不同即不同键）。 */
export function loadModelMap({ source, home = os.homedir(), env = process.env, force = false } = {}) {
  const name = String(source || '').trim();
  if (!name) return { source: name, available: false, entries: [], files: [], via: [] };
  const key = [name, home, env.CLAUDE_CONFIG_DIR || '', env.CODEX_HOME || '', env.CC_SWITCH_DB || '', env.AGENT_PET_MODEL_MAP || ''].join('|');
  if (!force && cache.data && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;
  let data;
  try { data = buildMap(name, home, env); }
  catch { data = { source: name, available: false, entries: [], files: [], via: [], error: 'model-map-unreadable' }; }
  cache = { key, at: Date.now(), data };
  return data;
}

/**
 * 把注册名解析成实际请求模型名。
 * 先按注册名精确匹配，再按档位（Claude 的 Opus/Sonnet/Haiku/Fable）回填直连模式的映射。
 */
export function mapModelName(map, name, opts = {}) {
  const raw = String(name || '').trim();
  if (!raw || !map?.available) return { actual: raw, mapped: false, via: null, from: raw, mode: null };
  const lower = raw.toLowerCase();
  const tier = String(opts.tier || '').trim().toLowerCase();
  const hit = map.entries.find((e) => e.alias && e.alias.toLowerCase() === lower)
    || (tier ? map.entries.find((e) => e.tier && e.tier.toLowerCase() === tier) : null);
  if (!hit || String(hit.actual).toLowerCase() === lower) return { actual: raw, mapped: false, via: null, from: raw, mode: null };
  const mode = hit.mode === 'direct' ? 'direct' : 'routed';
  // 请求名一律用映射后的实际模型名（用户定向 2026-10-09）：上游认识的是它，直传也已被实测证实
  // （cc-switch 代理日志：app_type=claude 直传 glm-5.3-flash 76 次全 200）。别名只在两端同族时才等价。
  return { actual: hit.actual, mapped: true, mode, via: hit.via || null, from: raw, cliModel: hit.actual };
}

/** 供 /api/state 诊断：不泄露路径之外的任何内容。 */
export function describeModelMap(map) {
  if (!map) return { available: false, count: 0, sources: [] };
  return {
    available: !!map.available,
    restrict: !!map.restrict,
    count: (map.entries || []).length,
    sources: (map.entries || []).map((e) => ({ alias: e.alias || ('tier:' + e.tier), actual: e.actual, via: e.via })),
    ...(map.requestConfig ? { requestConfig: map.requestConfig } : {}),
  };
}
