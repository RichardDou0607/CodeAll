#!/usr/bin/env node
/**
 * adapters/dsh-meta.mjs — DSH 会话日志 → 契约 v1.3 的 session.meta / session.activity
 *
 * 定位：**纯函数层**（无 I/O 副作用，除 decodeZstdFrames 需要调用方传入 Buffer）。
 *   - 输入：DSH 原生事件（session.v4.jsonl.zstd 解帧后的 JSON 行）
 *   - 输出：契约 v1.3 §3.4 的 session.meta / session.activity 事件
 *
 * 字段来源（**实测**，见 docs/52-session-catalog.md 的「字段来源表」）：
 *   agentName        ← 常量 'DSH'（本适配器代表的后端）
 *   agentVersion     ← 应用版本（Info.plist CFBundleShortVersionString / @deepseek-ai/dsh package.json）
 *   provider/model/reasoningEffort ← request/header.data.header.config（本会话真实生效配置）
 *                                     回退：model/selection.data → subagent/descriptor.data
 *   agentPreset      ← agent-preset/selected.data.agentPreset，回退 header.agentPreset
 *   title            ← session/title.data.title（回退 subagent/descriptor.data.label）
 *   logFormatVersion ← 首行 header.version（=4，是**日志格式版本**，不是应用版本，切勿混用）
 *
 * 隐私约束（契约 §3.4 + 任务要求）：session.activity.text 只能取**固定字典**里的粗粒度摘要，
 *   绝不携带步骤序号、工具参数、命令原文、文件路径或文件内容。本文件不含任何自由文本透传。
 *
 * 用法：
 *   node adapters/dsh-meta.mjs --selftest     # 运行内置单测（纯函数，无真实日志依赖）
 *   node adapters/dsh-meta.mjs --read <log>   # 从真实日志抽 meta/activity（诊断用）
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const CONTRACT_VERSION = 1;
export const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const AGENT_NAME = 'DSH';
/** 应用版本（实测：Info.plist CFBundleShortVersionString 与 @deepseek-ai/dsh/package.json 均为 0.2.0-rc.2） */
export const AGENT_VERSION = process.env.DSH_AGENT_VERSION || '0.2.0-rc.2';
export const AGENT_VERSION_SOURCE = 'app-bundle:Info.plist/CFBundleShortVersionString';

/** 契约 §3.4 session.activity 允许的 kind 取值（白名单，防止 UI 侧收到未知 kind）。 */
export const ACTIVITY_KINDS = Object.freeze(['thinking', 'tool', 'reply', 'waiting', 'error', 'done']);
/** 契约 §3.4：session.activity.text ≤ 80 字符。 */
export const ACTIVITY_TEXT_MAX = 80;
/** 契约 §3.4：session.meta 的字段集合。 */
export const META_FIELDS = Object.freeze(['agentName', 'agentVersion', 'provider', 'model', 'reasoningEffort', 'agentPreset', 'title']);

// ---------------------------------------------------------------------------
// 1. zstd 多帧解码（Node 内置 zstdDecompressSync 只解**第一帧**，必须按魔数分帧）
// ---------------------------------------------------------------------------

/** 在 buf 中找出所有 zstd 帧起始偏移（含 0x28B52FFD 魔数；magicless 帧不属于 DSH 产物）。 */
export function findFrameOffsets(buf, from = 0) {
  const offsets = [];
  let i = buf.indexOf(MAGIC, from);
  while (i >= 0) { offsets.push(i); i = buf.indexOf(MAGIC, i + 1); }
  return offsets;
}

/**
 * 解码 buf 中的 zstd 帧。
 * 返回 records / frames / tornFrames / badFrames / bytesConsumed：
 *  - tornFrames：末尾不完整帧（正在写入）——跳过属正常
 *  - badFrames ：中间完整帧解压失败——计损坏
 */
export function decodeZstdFrames(buf, { maxFrames = Infinity, maxRecords = Infinity } = {}) {
  const offsets = findFrameOffsets(buf);
  const records = [];
  let frames = 0, tornFrames = 0, badFrames = 0, emptyTail = false, bytesConsumed = 0;
  for (let k = 0; k < offsets.length; k++) {
    if (frames >= maxFrames) break;
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    const isLast = k + 1 === offsets.length;
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); }
    catch {
      if (isLast) tornFrames++; else badFrames++;
      continue; // 末帧可能仍在写入：留待下次读取
    }
    frames++;
    bytesConsumed = end;
    // 实测（Node v24.18）：内置 zstdDecompressSync 对**截断帧不抛错**，而是返回空串。
    // DSH 的每一帧至少含 1 条记录，因此「末帧解出 0 字节」= 该帧正在写入（torn tail），跳过即可。
    if (text.length === 0) { if (isLast) emptyTail = true; else badFrames++; continue; }
    if (records.length < maxRecords) {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t)); } catch { /* 半行：丢弃 */ }
      }
    }
  }
  return { records, frames, tornFrames, badFrames, emptyTail, bytesConsumed };
}

/** 截断到 n 个 Unicode 码点（不劈开代理对），必要时以 … 结尾。 */
export function truncateText(s, n = ACTIVITY_TEXT_MAX) {
  const chars = Array.from(String(s ?? ''));
  return chars.length <= n ? chars.join('') : chars.slice(0, n - 1).join('') + '…';
}

// ---------------------------------------------------------------------------
// 2. 元信息抽取（纯函数）
// ---------------------------------------------------------------------------

const titleIsEcho = (t) => /^\s*<system-reminder>/.test(String(t ?? ''));

/**
 * 从原生事件序列抽取会话元信息。
 * @param events 原生事件（按 seq 升序；可只含扫描窗口 head+tail）
 * @param header 首行 header 事件（type === 'session'），可为 null
 * @returns meta：字段 + sources（每字段来源可追溯）+ selection（显式模型选择）+ conflicts
 */
export function extractMeta(events = [], { header = null } = {}) {
  const pick = {};           // 字段 -> { value, source, index }
  const all = { selection: null, descriptor: null, titleRaw: null, headerPreset: null };
  const headerPreset = header && typeof header.agentPreset === 'string' ? header.agentPreset : null;

  events.forEach((ev, index) => {
    const d = ev?.data ?? {};
    switch (ev?.type) {
      case 'request/header': {
        const cfg = d.header?.config;
        if (cfg) for (const f of ['provider', 'model', 'reasoningEffort']) {
          if (typeof cfg[f] === 'string' && cfg[f]) pick['req:' + f] = { value: cfg[f], source: 'request/header.data.header.config.' + f, index };
        }
        break;
      }
      case 'model/selection': {
        const sel = {};
        for (const f of ['provider', 'model', 'reasoningEffort']) if (typeof d[f] === 'string' && d[f]) sel[f] = d[f];
        if (Object.keys(sel).length) { all.selection = sel; all.selectionIndex = index; all.selectionSource = 'model/selection.data'; }
        break;
      }
      case 'subagent/descriptor': {
        const desc = {
          label: typeof d.label === 'string' ? d.label : null,
          provider: typeof d.agentProvider === 'string' ? d.agentProvider : null,
          model: typeof d.agentModel === 'string' ? d.agentModel : null,
          reasoningEffort: typeof d.agentReasoningEffort === 'string' ? d.agentReasoningEffort : null,
          mode: typeof d.mode === 'string' ? d.mode : null,
        };
        all.descriptor = desc;
        for (const f of ['provider', 'model', 'reasoningEffort']) {
          if (desc[f]) pick['sub:' + f] = { value: desc[f], source: 'subagent/descriptor.data.agent' + f[0].toUpperCase() + f.slice(1), index };
        }
        break;
      }
      case 'agent-preset/selected': {
        if (typeof d.agentPreset === 'string' && d.agentPreset) pick.preset = { value: d.agentPreset, source: 'agent-preset/selected.data.agentPreset', index };
        break;
      }
      case 'session/title': {
        if (typeof d.title === 'string' && d.title.trim()) {
          all.titleRaw = d.title;
          pick.title = { value: d.title, source: 'session/title.data.title', index };
        }
        break;
      }
      default: break;
    }
  });
  if (!pick.preset && headerPreset) pick.preset = { value: headerPreset, source: 'header.agentPreset', index: -1 };

  // provider/model/reasoningEffort：生效配置优先（request/header），其次子代理描述符，最后显式选择
  const fields = {};
  const sources = {};
  for (const f of ['provider', 'model', 'reasoningEffort']) {
    const chosen = pick['req:' + f] ?? pick['sub:' + f];
    if (chosen) { fields[f] = chosen.value; sources[f] = chosen.source; }
  }
  if (!fields.model && all.selection) {
    for (const f of ['provider', 'model', 'reasoningEffort']) if (all.selection[f]) { fields[f] = all.selection[f]; sources[f] = 'model/selection.data.' + f; }
  }

  // title：session/title 优先；若它是 system-reminder 回显（子代理会话常见）而 descriptor 有 label，则用 label
  let title = pick.title?.value ?? null;
  let titleSource = pick.title?.source ?? null;
  if (title && titleIsEcho(title) && all.descriptor?.label) {
    title = all.descriptor.label;
    titleSource = 'subagent/descriptor.data.label';
  } else if (!title && all.descriptor?.label) {
    title = all.descriptor.label;
    titleSource = 'subagent/descriptor.data.label';
  }

  fields.agentPreset = pick.preset?.value ?? null;
  if (pick.preset) sources.agentPreset = pick.preset.source;
  fields.title = title;
  if (titleSource) sources.title = titleSource;

  // 冲突检测（只报告，不隐藏）：显式选择与生效配置不一致
  const conflicts = [];
  if (all.selection) {
    for (const f of ['provider', 'model', 'reasoningEffort']) {
      if (all.selection[f] && fields[f] && all.selection[f] !== fields[f] && String(sources[f]).startsWith('request/header')) {
        conflicts.push({ field: f, effective: fields[f], selected: all.selection[f], selectedSource: all.selectionSource });
      }
    }
  }

  return {
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    agentVersionSource: AGENT_VERSION_SOURCE,
    provider: fields.provider ?? null,
    model: fields.model ?? null,
    reasoningEffort: fields.reasoningEffort ?? null,
    agentPreset: fields.agentPreset ?? null,
    title,
    titleRaw: all.titleRaw,
    logFormatVersion: Number.isFinite(header?.version) ? header.version : null,
    selection: all.selection ? { ...all.selection, source: all.selectionSource ?? 'model/selection.data' } : null,
    conflicts,
    sources,
  };
}

/** 由原生事件序列推断会话的**粗粒度**状态（不含步骤明细）。 */
export function coarseState(events = []) {
  let lastTurnStart = -1, lastTurnEnd = -1, lastEndSeen = -1, lastError = -1, lastReply = -1;
  let endReason = null;
  events.forEach((ev, i) => {
    const d = ev?.data ?? {};
    switch (ev?.type) {
      case 'turn/start': lastTurnStart = i; break;
      case 'turn/end': lastTurnEnd = i; endReason = d.reason?.kind ?? d.reason ?? null; break;
      case 'session/end-seed': lastEndSeen = i; break;
      case 'session/end': lastEndSeen = i; endReason = d.reason ?? endReason; break;
      case 'llm/retry': lastError = i; break;
      case 'assistant/message': lastReply = i; break;
      default: break;
    }
  });
  if (lastTurnStart > lastTurnEnd) {
    // 时效修正：turn/start 无配对 turn/end 且尾部最后事件已超 5 分钟 = 会话被中断/进程被杀，
    // 死会话不该永远显示运行中（与 claude/codex/kimi 适配器同一规则）
    let lastTs = null;
    for (let i = events.length - 1; i >= 0; i--) { if (Number.isFinite(events[i]?.time)) { lastTs = events[i].time; break } }
    if (lastTs !== null && Date.now() - lastTs > 300_000) return { state: 'idle', stateSource: 'tail:turn/start 无配对 turn/end（stale>5min→idle）' };
    return { state: 'running', stateSource: 'tail:turn/start 无配对 turn/end' };
  }
  if (lastError > lastTurnEnd && lastError > lastReply) return { state: 'error', stateSource: 'tail:llm/retry 晚于最后一次 turn/end' };
  if (String(endReason ?? '').match(/error|fail/i)) return { state: 'error', stateSource: 'tail:turn/end(reason=' + endReason + ')' };
  if (lastEndSeen >= 0) return { state: 'ended', stateSource: 'tail:session/end-seed' };
  if (lastTurnEnd >= 0) return { state: 'idle', stateSource: 'tail:turn/end(reason=' + endReason + ')' };
  return { state: 'idle', stateSource: 'tail:无轮次事件' };
}

// ---------------------------------------------------------------------------
// 3. 原生事件 → 契约事件（session.meta / session.activity）
// ---------------------------------------------------------------------------

/** 组装事件信封（契约 §2.1）。 */
function envelope(base, type, data) {
  return {
    v: CONTRACT_VERSION,
    seq: base.seq,
    ts: base.ts,
    source: base.source ?? 'dsh',
    sessionId: base.sessionId,
    workspace: base.workspace ?? null,
    agent: { name: AGENT_NAME, version: AGENT_VERSION },
    type,
    data,
  };
}

/**
 * session.meta（契约 §3.4）：只填有值的字段；nativeSessionId 必填。
 * 语义 = no-op（不改变状态机），仅更新工作框头部与目录条目。
 */
export function toMetaEvent(meta, base) {
  const data = { nativeSessionId: base.sessionId };
  for (const f of META_FIELDS) if (meta?.[f] != null && meta[f] !== '') data[f] = meta[f];
  return envelope(base, 'session.meta', data);
}

/** session.activity（契约 §3.4）：text ≤80 字符，kind ∈ ACTIVITY_KINDS。 */
export function toActivityEvent(kind, text, base) {
  const k = ACTIVITY_KINDS.includes(kind) ? kind : 'thinking';
  return envelope(base, 'session.activity', { nativeSessionId: base.sessionId, text: truncateText(text, ACTIVITY_TEXT_MAX), kind: k });
}

/**
 * 活动摘要字典（**唯一**的 activity 文案来源）。
 * 设计约束：文案必须是固定字符串，不拼接任何来自事件的值 → 结构上不可能泄漏命令/参数/路径。
 */
export const ACTIVITY_TEXT = Object.freeze({
  thinking: '思考中',
  'tool:read': '读取文件',
  'tool:write': '修改文件',
  'tool:exec': '运行命令',
  'tool:net': '联网检索',
  'tool:other': '调用工具',
  reply: '撰写回复',
  waiting: '等待你',
  'error:tool': '工具执行出错',
  'error:llm': '模型重试中',
  'done:turn': '本轮已完成',
  'done:aborted': '本轮已中断',
  'done:session': '会话已结束',
});

/** 工具名 → 契约 §3.2 的 category（只用于选固定文案，不输出工具名本身）。 */
export function categoryOfTool(toolName = '') {
  const n = String(toolName);
  if (/^(read|glob|grep|list|search_files|view|codegraph|read_file)/i.test(n)) return 'read';
  if (/^(edit|write|str_replace|create|apply_patch|notebook|todo)/i.test(n)) return 'write';
  if (/^(bash|shell|run_code|exec|terminal|pwsh|process|command)/i.test(n)) return 'exec';
  if (/^(web_|fetch|http|search_web|websearch)/i.test(n)) return 'net';
  return 'other';
}

/**
 * 原生事件 → 粗粒度活动（无步骤序号/参数/命令原文）。
 * @returns { kind, text } | null（null = 该事件不产生活动摘要）
 */
export function activityOf(native) {
  const d = native?.data ?? {};
  switch (native?.type) {
    case 'turn/start': return { kind: 'thinking', text: ACTIVITY_TEXT.thinking };
    case 'request/header': return { kind: 'thinking', text: ACTIVITY_TEXT.thinking };
    case 'step/start': return { kind: 'thinking', text: ACTIVITY_TEXT.thinking };
    case 'tool/call': {
      const cat = categoryOfTool(d.toolName ?? d.name);
      return { kind: 'tool', text: ACTIVITY_TEXT['tool:' + cat] };
    }
    case 'tool/result':
      return d.status === 'error' ? { kind: 'error', text: ACTIVITY_TEXT['error:tool'] } : null;
    case 'assistant/message': return { kind: 'reply', text: ACTIVITY_TEXT.reply };
    case 'approval/asked': return { kind: 'waiting', text: ACTIVITY_TEXT.waiting };
    case 'llm/retry': return { kind: 'error', text: ACTIVITY_TEXT['error:llm'] };
    case 'turn/end': {
      const kind = String(d.reason?.kind ?? d.reason ?? '');
      return kind.match(/abort|interrupt|cancel/i)
        ? { kind: 'done', text: ACTIVITY_TEXT['done:aborted'] }
        : { kind: 'done', text: ACTIVITY_TEXT['done:turn'] };
    }
    case 'session/end-seed': return { kind: 'done', text: ACTIVITY_TEXT['done:session'] };
    default: return null;
  }
}

/** 把原生事件折成（最多）一条契约活动事件。 */
export function activityForNative(native, base) {
  const a = activityOf(native);
  return a ? toActivityEvent(a.kind, a.text, base) : null;
}

// ---------------------------------------------------------------------------
// 4. 自检（纯函数单测；scripts/catalog-check.mjs 也会调用）
// ---------------------------------------------------------------------------

export function selfTest() {
  const checks = [];
  const ok = (name, cond, extra) => checks.push({ name, pass: !!cond, extra: cond ? undefined : extra });
  const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

  // --- 解码：单帧 vs 多帧 ---
  const z = (o) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(o) + '\n', 'utf8'));
  const f1 = z({ type: 'session', version: 4, id: 's1', cwd: '/x', agentPreset: 'ptc' });
  const f2 = z({ type: 'session/title', data: { title: '标题', messageSeqs: [1], source: { kind: 'fallback' } } });
  eq('decodeZstdFrames: 两帧 2 条记录', decodeZstdFrames(Buffer.concat([f1, f2])).records.length, 2);
  eq('decodeZstdFrames: 内置只解第一帧会漏（回归）', zlib.zstdDecompressSync(Buffer.concat([f1, f2])).toString('utf8').includes('session/title'), false);
  // 真·截断帧（DSH 正在写入时）：Node 内置 zstd 不抛错、返回空串 —— 实测结论，故以 emptyTail 判定
  const big = z({ type: 'tool/call', data: { toolName: 'bash', input: { command: 'x'.repeat(400) } } });
  const torn = big.subarray(0, Math.floor(big.length * 0.6));
  const dec = decodeZstdFrames(Buffer.concat([f1, torn]));
  eq('decodeZstdFrames: 截断末帧 → emptyTail=true', dec.emptyTail, true);
  eq('decodeZstdFrames: 截断末帧不抛错（实测）', dec.tornFrames, 0);
  eq('decodeZstdFrames: 截断末帧不污染前面的记录', dec.records.length, 1);
  ok('decodeZstdFrames: 截断帧调用本身不抛异常', (() => { try { decodeZstdFrames(torn); return true; } catch { return false; } })());

  // --- 元信息抽取：字段来源可追溯 ---
  const events = [
    { type: 'subagent/descriptor', data: { version: 3, provider: 'spawn', label: 'T12 会话目录', agentProvider: 'deepseek-account', agentModel: 'deepseek-flash', agentReasoningEffort: 'max' } },
    { type: 'permission/preset', data: { preset: 'auto' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'request/header', data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max', maxTokens: 256000 } }, reason: 'turn' } },
    { type: 'session/title', data: { title: '<system-reminder> You are teammate "x"', messageSeqs: [9], source: { kind: 'fallback' } } },
    { type: 'session-log-deepseek/delivery-accepted', data: { sessionId: 's1', throughSeq: 15 } },
  ];
  const header = { type: 'session', version: 4, id: 's1', createdAt: 1791172829778, cwd: '/x', agentPreset: 'ptc' };
  const meta = extractMeta(events, { header });
  eq('meta.model ← request/header.config', meta.model, 'deepseek-flash');
  eq('meta.reasoningEffort ← request/header.config', meta.reasoningEffort, 'max');
  eq('meta.provider ← request/header.config', meta.provider, 'deepseek-account');
  ok('meta.sources.model 指向 request/header', meta.sources.model === 'request/header.data.header.config.model', meta.sources);
  eq('meta.title：system-reminder 回显 → descriptor.label', meta.title, 'T12 会话目录');
  eq('meta.titleRaw 保留原值', meta.titleRaw, '<system-reminder> You are teammate "x"');
  eq('meta.agentPreset ← header.agentPreset（无 agent-preset/selected 时）', meta.agentPreset, 'ptc');
  eq('meta.logFormatVersion=4（≠ 应用版本）', meta.logFormatVersion, 4);
  eq('meta.agentVersion 是应用版本', meta.agentVersion, AGENT_VERSION);
  ok('meta.agentVersion !== logFormatVersion', meta.agentVersion !== String(meta.logFormatVersion));

  const meta2 = extractMeta([...events, { type: 'agent-preset/selected', data: { agentPreset: 'cordis' } }], { header });
  eq('agent-preset/selected 覆盖 header.agentPreset', meta2.agentPreset, 'cordis');

  const meta3 = extractMeta([{ type: 'model/selection', data: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' } }], { header });
  eq('无 request/header 时回退 model/selection', [meta3.provider, meta3.model, meta3.reasoningEffort], ['deepseek-official', 'deepseek-v4-pro', 'high']);
  const meta4 = extractMeta([
    { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } } } },
    { type: 'model/selection', data: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } },
  ], { header });
  eq('冲突：生效值取 request/header', meta4.reasoningEffort, 'max');
  eq('冲突：selection 保留显式选择', meta4.selection.reasoningEffort, 'high');
  eq('冲突：conflicts 报告 provider/reasoningEffort', meta4.conflicts.map((c) => c.field), ['provider', 'reasoningEffort']);

  // --- activity：结构上不可能泄漏参数/命令/步骤号 ---
  const SECRET = 'rm -rf /Users/demo/secret && cat ~/.dsh/.credentials.yaml';
  const act = activityForNative({ type: 'tool/call', data: { toolName: 'bash', callId: 'c1', input: { command: SECRET }, index: 42 } }, { seq: 1, ts: 1, sessionId: 's1', workspace: '/x' });
  eq('tool/call → kind=tool', act.data.kind, 'tool');
  eq('exec 类工具 → 固定文案「运行命令」', act.data.text, '运行命令');
  ok('activity.text 不含命令原文', !JSON.stringify(act).includes('rm -rf') && !JSON.stringify(act).includes('credentials'));
  ok('activity.text 不含步骤序号', !/\b42\b/.test(act.data.text));
  eq('activity.data 只有 nativeSessionId/text/kind', JSON.stringify(Object.keys(act.data).sort()), JSON.stringify(['kind', 'nativeSessionId', 'text']));
  eq('read 类工具 → 读取文件', activityForNative({ type: 'tool/call', data: { toolName: 'read_file', input: { file_path: '/etc/passwd' } } }, { seq: 2, ts: 2, sessionId: 's1' }).data.text, '读取文件');
  eq('write 类工具 → 修改文件', activityForNative({ type: 'tool/call', data: { toolName: 'apply_patch', input: { patch: 'x' } } }, { seq: 3, ts: 3, sessionId: 's1' }).data.text, '修改文件');
  eq('net 类工具 → 联网检索', activityForNative({ type: 'tool/call', data: { toolName: 'web_search', input: { query: 'secret' } } }, { seq: 4, ts: 4, sessionId: 's1' }).data.text, '联网检索');
  eq('未知工具 → 调用工具', activityForNative({ type: 'tool/call', data: { toolName: 'mystery', input: { p: 1 } } }, { seq: 5, ts: 5, sessionId: 's1' }).data.text, '调用工具');
  ok('自由文本类事件：要么无 activity，要么只用固定文案', [
    { type: 'tool/result', data: { status: 'ok', output: SECRET } },
    { type: 'assistant/message', data: { text: SECRET } },
    { type: 'user/message', data: { text: SECRET } },
    { type: 'command/run', data: { name: 'permission', args: SECRET } },
  ].every((ev) => {
    const a = activityForNative(ev, { seq: 0, ts: 0, sessionId: 's1' });
    return a === null || (Object.values(ACTIVITY_TEXT).includes(a.data.text) && !JSON.stringify(a).includes('rm -rf'));
  }));
  eq('assistant/message → 固定文案「撰写回复」（不含正文）', activityForNative({ type: 'assistant/message', data: { text: SECRET } }, { seq: 0, ts: 0, sessionId: 's1' }).data.text, '撰写回复');
  eq('step/start 只给「思考中」，无序号', activityForNative({ type: 'step/start', data: { index: 7 } }, { seq: 0, ts: 0, sessionId: 's1' }).data.text, '思考中');

  // --- 长文本截断（CJK/代理对安全） ---
  eq('truncateText 截到 80 码点', Array.from(truncateText('思'.repeat(120), 80)).length, 80);
  ok('truncateText 不劈代理对', Array.from(truncateText('😀'.repeat(100), 80)).length === 80 && !truncateText('😀'.repeat(100), 80).includes('\uFFFD'));

  // --- 粗粒度状态 ---
  eq('turn/start 无配对 → running', coarseState([{ type: 'turn/start', data: { turn: 1 } }]).state, 'running');
  eq('turn/end(completed) → idle', coarseState([{ type: 'turn/start' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }]).state, 'idle');
  eq('session/end-seed → ended', coarseState([{ type: 'turn/end', data: { reason: { kind: 'completed' } } }, { type: 'session/end-seed', data: {} }]).state, 'ended');
  eq('turn/end(error) → error', coarseState([{ type: 'turn/start' }, { type: 'turn/end', data: { reason: { kind: 'error' } } }]).state, 'error');

  // --- 契约事件信封 ---
  const me = toMetaEvent(meta, { seq: 7, ts: 1791172829778, sessionId: 's1', workspace: '/x' });
  eq('session.meta 信封 type', me.type, 'session.meta');
  eq('session.meta 必填 nativeSessionId', me.data.nativeSessionId, 's1');
  ok('session.meta 信封必填齐全', ['v', 'seq', 'ts', 'source', 'sessionId', 'workspace', 'type', 'data'].every((k) => k in me));
  ok('session.meta 不含 null/undefined 字段', Object.values(me.data).every((v) => v !== undefined && v !== null));
  const ae = toActivityEvent('tool', '思'.repeat(120), { seq: 8, ts: 1, sessionId: 's1' });
  ok('session.activity text ≤ 80 字符', Array.from(ae.data.text).length <= ACTIVITY_TEXT_MAX);
  eq('session.activity kind 白名单兜底', toActivityEvent('bogus', 'x', { seq: 9, ts: 1, sessionId: 's1' }).data.kind, 'thinking');

  const failed = checks.filter((c) => !c.pass);
  return { total: checks.length, failed: failed.length, failures: failed, checks };
}

// ---------------------------------------------------------------------------
// 5. CLI
// ---------------------------------------------------------------------------
function main(argv) {
  if (argv.includes('--selftest')) {
    const r = selfTest();
    for (const c of r.checks) if (!c.pass) console.log('  FAIL ' + c.name + '  → ' + JSON.stringify(c.extra));
    console.log('dsh-meta selfTest: ' + (r.total - r.failed) + '/' + r.total + ' 通过' + (r.failed ? '  ❌ ' + r.failed + ' 失败' : '  ✅'));
    process.exit(r.failed ? 1 : 0);
  }
  const i = argv.indexOf('--read');
  if (i >= 0) {
    const file = argv[i + 1];
    const { records, frames, tornFrames } = decodeZstdFrames(fs.readFileSync(file));
    const header = records.find((r) => r.type === 'session') ?? null;
    const meta = extractMeta(records, { header });
    console.log(JSON.stringify({ file, nativeEvents: records.length, frames, tornFrames, meta, state: coarseState(records), activities: records.map(activityOf).filter(Boolean).slice(0, 8) }, null, 2));
    return;
  }
  console.log('用法: node adapters/dsh-meta.mjs --selftest | --read <session.vN.jsonl.zstd>');
}
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main(process.argv.slice(2));
