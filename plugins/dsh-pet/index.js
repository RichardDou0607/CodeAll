/**
 * plugins/dsh-pet/index.js
 * ---------------------------------------------------------------------------
 * DSH 桌宠桥接插件（Cordis 用户插件，零外部依赖）。
 *
 * 跑在 DSH 主进程内，做三件事：
 *   1) 事件直推：ctx.on('session/event' | 'session/created' | 'session/disposed')
 *      → 映射成契约 v1.3 的规范事件 → 推给所有 GET /events 订阅者（NDJSON）。
 *      进程内同步派发，延迟 <1ms（对比日志 tail 的 ~250ms）。
 *   2) 输入投递：POST /input {"text":…,"sessionId"?}
 *      → ctx.get('sessionController').prompt(...)（首选，可自动 resume 冷会话）
 *        或 ctx.get('agents').get(id).followup(message)（回退）。
 *   3) 会话操作：POST /new {"cwd":…}、POST /open {"sessionId":…}、POST /ctl {"ctl":"catalog.get"}。
 *
 * 挂载（用户自己的 profile，一行 insert，详见 docs/54-dsh-plugin.md）：
 *   - insert:
 *       - id: dsh-pet
 *         name: '/绝对路径/plugins/dsh-pet/index.js'
 *         config: { socket: null }        # 可选，缺省 $TMPDIR/agent-pet/dsh-plugin.sock
 *
 * 硬约束：只读 DSH 状态；不读写 .credentials.yaml；不写用户会话日志；所有出站事件都截断/脱敏。
 * @module dsh-pet
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'dsh-pet';
export const inject = ['sessions'];

const CONTRACT = 3;                 // 契约 v1.3（信封 v 仍为 1）
const SOURCE = 'dsh';
const MAX_TEXT = 280;               // 契约 §3：message.assistant.text ≤ 280
const MAX_ACTIVITY = 80;            // 契约 §3：session.activity.text ≤ 80
const HEARTBEAT_MS = 15000;
const OBSERVES = ['session.*', 'turn.*', 'step.*', 'tool.*', 'approval.*', 'message.assistant', 'error.*', 'pet.heartbeat'];

function defaultSocketPath() {
  const base = process.env.DSH_PET_DIR || path.join(os.tmpdir(), 'agent-pet');
  return process.env.DSH_PET_SOCK || path.join(base, 'dsh-plugin.sock');
}

/** 生命周期调试日志（超 256KB 重置；诊断 HMR 重载问题用）。写在 socket 同目录，随实例走。 */
function dbgTo(file, msg) {
  try {
    const line = new Date().toISOString() + ' [' + process.pid + '] ' + msg + '\n';
    let over = false; try { over = fs.statSync(file).size > 256 * 1024; } catch { /* 首次 */ }
    if (over) fs.writeFileSync(file, line);
    else fs.appendFileSync(file, line);
  } catch { /* 日志失败绝不影响主流程 */ }
}

function truncate(text, max) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max - 1) + '…', truncated: true };
}

function firstLine(text, max) {
  if (typeof text !== 'string') return '';
  const line = text.split('\n').find((l) => l.trim() !== '') || '';
  return truncate(line, max).text;
}

/** 契约 v1.3 §3：session.activity 只允许粗粒度摘要，禁止步骤/参数/命令原文/文件内容。 */
export function coarseActivity(type, data) {
  switch (type) {
    case 'turn/start': return { kind: 'thinking', text: '思考中' };
    case 'step/start': return { kind: 'thinking', text: '规划下一步' };
    case 'tool/call': return { kind: 'tool', text: '执行工具' };
    case 'tool/result': return data && data.message && data.message.isError === true
      ? { kind: 'error', text: '工具失败' } : { kind: 'tool', text: '工具完成' };
    case 'assistant/message': return { kind: 'reply', text: '回复中' };
    case 'approval/asked': return { kind: 'waiting', text: '等待批准' };
    case 'turn/end': {
      const kind = data && data.reason && data.reason.kind;
      return kind === 'completed' ? { kind: 'done', text: '本轮完成' } : { kind: 'error', text: '本轮中断' };
    }
    default: return null;
  }
}

/** 原生事件 → 契约规范事件（与 adapters/_reference/dsh-log-tail.mjs 同一份映射规则，取所需子集）。 */
export class DshEventMapper {
  constructor() {
    this.turnOpen = new Map();
    this.stepOpen = new Map();
    this.stepError = new Map();
    this.calls = new Map();
    this.approvals = new Map();
    this.questions = new Map();
    this.lastInputKind = 'user';
    this.unknownTypes = new Map();
  }
  turnId(t) { return 'turn-' + t; }
  stepId(t, s) { return 'turn-' + t + '/step-' + s; }

  map(sessionId, event) {
    const type = event.type;
    const data = event.data || {};
    const at = typeof event.time === 'number' ? event.time : Date.now();
    const out = [];
    switch (type) {
      case 'turn/start':
        this.turnOpen.set(data.turn, at);
        out.push({ type: 'turn.start', data: { nativeSessionId: sessionId, turnId: this.turnId(data.turn), inputKind: this.lastInputKind } });
        out.push({ type: 'agent.status', data: { state: 'thinking', detail: null } });
        break;
      case 'turn/end': {
        const startedAt = this.turnOpen.get(data.turn);
        this.turnOpen.delete(data.turn);
        const kind = (data.reason && data.reason.kind) || 'completed';
        const status = kind === 'completed' ? 'ok' : (kind === 'aborted' ? 'aborted' : 'error');
        out.push({ type: 'turn.end', data: { turnId: this.turnId(data.turn), status,
          durationMs: startedAt === undefined ? 0 : Math.max(0, at - startedAt), summary: kind === 'completed' ? null : kind } });
        break;
      }
      case 'step/start': {
        const key = this.stepId(data.turn, data.step);
        this.stepOpen.set(key, at); this.stepError.set(key, false);
        out.push({ type: 'step.start', data: { turnId: this.turnId(data.turn), stepId: key, index: data.step } });
        out.push({ type: 'agent.status', data: { state: 'working', detail: null } });
        break;
      }
      case 'step/end': {
        const key = this.stepId(data.turn, data.step);
        const startedAt = this.stepOpen.get(key);
        const failed = this.stepError.get(key) === true;
        this.stepOpen.delete(key); this.stepError.delete(key);
        out.push({ type: 'step.end', data: { turnId: this.turnId(data.turn), stepId: key, index: data.step,
          status: failed ? 'error' : 'ok', durationMs: startedAt === undefined ? 0 : Math.max(0, at - startedAt) } });
        break;
      }
      case 'tool/call': {
        const toolName = String(data.name || 'unknown');
        const category = classifyTool(toolName);
        this.calls.set(data.callId, { at: at, turn: data.turn, step: data.step, category: category });
        if (/ask_user/i.test(toolName)) {
          const args = safeJson(data.arguments);
          const q = (args.questions && args.questions[0]) || {};
          this.questions.set(data.callId, true);
          out.push({ type: 'user.question', data: { questionId: data.callId, text: firstLine(q.question || args.question || '提问', MAX_TEXT) } });
        } else {
          out.push({ type: 'tool.call', data: { callId: data.callId, toolName: toolName, category: category,
            risk: riskOf(category), summary: summariseToolCall(toolName, data.arguments) } });
        }
        break;
      }
      case 'tool/result': {
        const callId = data.toolCallId || (data.message && data.message.source && data.message.source.callId);
        const call = this.calls.get(callId);
        this.calls.delete(callId);
        const message = data.message || {};
        const text = (message.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
        const status = message.isError === true ? 'error' : (/denied by|blocked by|rejected|not permitted/i.test(text) ? 'denied' : 'ok');
        if (call !== undefined && status === 'error') {
          const key = this.stepId(call.turn, call.step);
          if (this.stepError.has(key)) this.stepError.set(key, true);
        }
        if (this.questions.has(callId)) {
          this.questions.delete(callId);
          out.push({ type: 'user.answer', data: { questionId: callId, choice: firstLine(text || 'answered', MAX_TEXT) } });
        } else {
          out.push({ type: 'tool.result', data: { callId: callId, status: status, summary: firstLine(text, 160) || null,
            durationMs: call === undefined ? 0 : Math.max(0, at - call.at) } });
        }
        break;
      }
      case 'approval/asked': {
        this.approvals.set(data.id, at);
        const call = data.callId === undefined ? undefined : this.calls.get(data.callId);
        const category = (call && call.category) || classifyTool(String(data.toolName || ''));
        out.push({ type: 'approval.request', data: { requestId: String(data.id), kind: approvalKind(category),
          summary: firstLine(data.reason || '需要批准', MAX_TEXT), risk: Math.max(1, riskOf(category)),
          callId: data.callId === undefined ? null : data.callId, expiresAt: null } });
        out.push({ type: 'agent.status', data: { state: 'waiting', detail: null } });
        break;
      }
      case 'approval/decided': {
        const startedAt = this.approvals.get(data.id);
        this.approvals.delete(data.id);
        const decision = APPROVAL_OUTCOME[data.outcome] || 'deny';
        out.push({ type: 'approval.resolved', data: { requestId: String(data.id), decision: decision,
          latencyMs: startedAt === undefined ? 0 : Math.max(0, at - startedAt) } });
        break;
      }
      case 'assistant/message': {
        const message = data.message || {};
        const text = (message.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
        if (text !== '') {
          const t = truncate(text, MAX_TEXT);
          out.push({ type: 'message.assistant', data: { turnId: this.turnId(data.turn || 0), text: t.text, truncated: t.truncated } });
        }
        break;
      }
      case 'user/message':
      case 'agent/inbox/spliced':
        this.lastInputKind = 'user';
        break;
      case 'system/message':
        this.lastInputKind = 'system';
        break;
      case 'llm/retry':
      case 'llm/retry-started':
        out.push({ type: 'error.raised', data: { scope: 'llm', code: data.code || null, message: firstLine(data.message || '模型请求重试', MAX_TEXT), fatal: false } });
        break;
      default:
        this.unknownTypes.set(type, (this.unknownTypes.get(type) || 0) + 1);
    }
    return out;
  }
}

const APPROVAL_OUTCOME = { 'allowed-once': 'allow', rejected: 'deny', unavailable: 'deny', cancelled: 'timeout' };

function safeJson(raw) {
  if (typeof raw !== 'string') return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; }
  catch { return {}; }
}

export function classifyTool(name) {
  if (/^(bash|run_code|pwsh|terminal|shell|execute)/i.test(name)) return 'exec';
  if (/^(read|view|cat|grep|glob|search|ls|list|fs_search)/i.test(name)) return 'read';
  if (/^(write|edit|str_replace|apply_patch|create|mkdir|rm|delete|move|present)/i.test(name)) return 'write';
  if (/^(web_fetch|web_search|http|fetch|curl|browser)/i.test(name)) return 'net';
  return 'other';
}
export function riskOf(category) { return { read: 0, net: 1, write: 1, exec: 2, other: 0 }[category] || 0; }
export function approvalKind(category) {
  if (category === 'exec') return 'command';
  if (category === 'write') return 'file-write';
  if (category === 'net') return 'network';
  return 'other';
}
function summariseToolCall(toolName, rawArguments) {
  const a = safeJson(rawArguments);
  for (const key of ['command', 'cmd', 'file_path', 'path', 'url', 'pattern', 'query', 'description']) {
    if (typeof a[key] === 'string' && a[key].trim() !== '') return firstLine(a[key], 160);
  }
  if (typeof a.code === 'string') return firstLine(a.code, 160);
  return firstLine(toolName, 160);
}

/** 构造 dsh-llm 的 user message（不 import，避免插件对安装包内部模块的裸 specifier 依赖）。 */
export function buildUserMessage(text, clientTimeZone) {
  const source = { kind: 'user', rpcId: randomUUID() };
  if (typeof clientTimeZone === 'string' && clientTimeZone !== '') source.clientTimeZone = clientTimeZone;
  const message = { role: 'user', content: [{ type: 'text', text: text }], source: source, id: randomUUID() };
  message.content.forEach((part) => Object.freeze(part));
  Object.freeze(message.content);
  Object.freeze(message.source);
  return Object.freeze(message);
}

// ---------------------------------------------------------------------------
// 2. 会话操作（输入投递 / 新建 / 打开 / 目录）
// ---------------------------------------------------------------------------

function isFn(value) { return typeof value === 'function'; }

/** 把 AgentHandle / Agent 统一成 Agent。 */
function unwrapAgent(value) { return value && value.agent ? value.agent : value; }

/**
 * 投递一条用户输入到指定会话。
 * 首选 ctx.get('agents') 的 get/resume + followup/steer（2026-10-05 实测：desktop 与 /tmp 预演均送达，
 * 且 agents.resume 可自动恢复冷会话）；回退 sessionController.prompt —— 它在 desktop profile 的
 * 进程内直调路径上会丢 cancellation signal（`signal.throwIfAborted` 抛 undefined），仅作兼容保留。
 */
export async function deliverInput(ctx, request, bridge) {
  const text = typeof request.text === 'string' ? request.text : '';
  if (text.trim() === '') return { ok: false, code: 'empty-text', detail: 'text 不能为空' };
  let sessionId = typeof request.sessionId === 'string' && request.sessionId !== '' ? request.sessionId : null;
  let sessionSource = 'explicit';
  if (sessionId === null) {
    // 未指定时按「最近有事件的活跃主会话」推断；再退回磁盘上最新的会话（投递时会 resume）
    const inferred = bridge ? bridge.currentSessionId(ctx) : null;
    if (inferred === null) return { ok: false, code: 'no-session', detail: '未指定 sessionId，且当前没有可推断的活跃会话' };
    sessionId = inferred.sessionId;
    sessionSource = inferred.source;
  }
  const mode = request.mode === 'steer' ? 'steer' : 'followup';

  // ① 首选 agents.get/resume + followup/steer（进程内 Agent API，不改 DSH）
  let agentsError = null;
  const agents = ctx.get('agents');
  if (agents !== undefined && isFn(agents.get)) {
    try {
      let agent = unwrapAgent(agents.get(sessionId));
      let resumed = false;
      if (agent === undefined || agent === null) {
        if (isFn(agents.resume)) {
          agent = unwrapAgent(await agents.resume({ resumeSessionId: sessionId }));
          resumed = true;
        }
      }
      if (agent !== undefined && agent !== null) {
        const message = buildUserMessage(text, request.clientTimeZone);
        if (mode === 'steer' && isFn(agent.steer)) agent.steer(message);
        else if (isFn(agent.followup)) agent.followup(message);
        else throw new Error('Agent 上没有 followup/steer');
        return {
          ok: true, via: (resumed ? 'agents.resume+followup' : 'agents.followup'),
          sessionId: sessionId, mode: mode, sessionSource: sessionSource, resumed: resumed,
        };
      }
    } catch (error) {
      // agents 路径失败（如 resume 被拒）→ 继续走 ② prompt，把原因记进 detail
      agentsError = String((error && error.message) || error);
    }
  }

  // ② 回退 sessionController.prompt（Web 端同一条路径）。注意：desktop 进程内直调会丢
  //    cancellation signal（实测 2026-10-05，'throwIfAborted' of undefined），失败时如实返回。
  const controller = ctx.get('sessionController');
  if (controller !== undefined && isFn(controller.prompt)) {
    const abort = new AbortController();
    try {
      const result = await controller.prompt({
        sessionId: sessionId,
        content: [{ type: 'text', text: text }],
        requestId: randomUUID(),
        ...(request.clientTimeZone ? { clientTimeZone: request.clientTimeZone } : {}),
        ...(mode === 'steer' ? { mode: 'steer' } : {}),
      }, abort.signal);
      if (result !== undefined && result !== null && result.ok === true) {
        return { ok: true, via: 'sessionController.prompt', sessionId: sessionId, mode: mode, sessionSource: sessionSource, detail: result };
      }
      return { ok: false, code: 'prompt-rejected', via: 'sessionController.prompt', sessionId: sessionId,
        detail: 'prompt 未被接受：' + String(JSON.stringify(result && result.error ? result.error : result)).slice(0, 220)
          + (agentsError ? ' | agents: ' + agentsError : '') };
    } catch (error) {
      return { ok: false, code: 'agent-error', via: 'sessionController.prompt', sessionId: sessionId,
        detail: String((error && error.message) || error) + (agentsError ? ' | agents: ' + agentsError : ''),
        diag: { hasAgentsService: agents !== undefined, hasGet: isFn(agents && agents.get), hasResume: isFn(agents && agents.resume), hasList: isFn(agents && agents.list) } };
    }
  }
  if (agents === undefined || !isFn(agents.get)) {
    return { ok: false, code: 'no-delivery-api', detail: '组合里既没有 agents 服务，也没有 sessionController.prompt' + (agentsError ? '（agents 路径失败：' + agentsError + '）' : '') };
  }
  return { ok: false, code: 'delivery-failed', sessionId: sessionId, detail: agentsError || 'agents 路径未能投递' };
}

/**
 * 解析（或创建）cwd 对应的 workspace。
 * 关键：DSH 的 create 只带 cwd 时**不会**把会话挂进 workspace（session 日志有 cwd，但 DSH 界面
 * 把它归到当前默认项目）。要落进指定项目，必须先 resolveByPath/create workspace，再带 workspaceId 创建
 * （DSH 内部 create 对 workspaceId 分支会 attachSession）。
 * @returns {Promise<{id:string}|null>} workspace 视图（含 id）或 null（registry 不可用/失败 → 退回纯 cwd）
 */
export async function resolveWorkspace(ctx, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined) return null;
  try {
    let ws;
    if (isFn(registry.resolveByPath)) ws = await registry.resolveByPath(cwd);
    if ((ws === undefined || ws === null) && isFn(registry.create)) ws = await registry.create(cwd);
    return ws && ws.id ? ws : null;
  } catch { return null; }
}

/** 新建一个会话（工作目录 cwd）。cwd 对应的 workspace 不存在时会先创建，保证会话落在指定项目里。 */
export async function createSession(ctx, request) {
  const cwd = typeof request.cwd === 'string' && request.cwd !== '' ? request.cwd : null;
  const workspace = request.workspaceId
    ? { id: request.workspaceId }
    : (cwd ? await resolveWorkspace(ctx, cwd) : null);
  const controller = ctx.get('sessionController');
  if (controller !== undefined && isFn(controller.create)) {
    // workspaceId 优先：DSH 内部 create 的 workspaceId 分支会 attachSession（cwd 分支不会）。
    // 带 workspaceId 的调用被拒（如 RPC schema 不认）时退回纯 cwd —— 会话能建出来，只是没挂项目。
    let wsError = null;
    if (workspace) {
      try {
        const result = await controller.create({
          workspaceId: workspace.id,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        });
        return { ok: true, via: 'sessionController.create+workspace', sessionId: result && result.sessionId ? result.sessionId : null,
          workspaceId: workspace.id, detail: result };
      } catch (error) { wsError = String((error && error.message) || error); }
    }
    try {
      const result = await controller.create({
        ...(cwd ? { cwd: cwd } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      });
      const sid = result && result.sessionId ? result.sessionId : null;
      // cwd-only create 不会挂 workspace（DSH 界面就不显示这个会话）→ 手动补挂
      let attached = false, attachError = null;
      if (sid && workspace && workspace.id) {
        try {
          const registry2 = ctx.get('workspaceRegistry');
          const entity = registry2 !== undefined && isFn(registry2.get) ? registry2.get(workspace.id) : undefined;
          if (entity !== undefined && entity !== null && isFn(entity.attachSession)) {
            await entity.attachSession(sid);
            attached = true;
          }
        } catch (e) { attachError = String((e && e.message) || e); }
      }
      return { ok: true, via: 'sessionController.create' + (attached ? '+workspace.attachSession' : ''),
        sessionId: sid, workspaceId: attached ? workspace.id : null, detail: result,
        ...(wsError ? { workspaceError: wsError } : {}), ...(attachError ? { attachError: attachError } : {}) };
    } catch (error) {
      return { ok: false, code: 'create-rejected', via: 'sessionController.create', detail: String((error && error.message) || error) + (wsError ? ' | workspace 分支：' + wsError : '') };
    }
  }
  const agents = ctx.get('agents');
  if (agents === undefined || !isFn(agents.create)) {
    return { ok: false, code: 'no-create-api', detail: '组合里既没有 sessionController.create，也没有 agents.create' };
  }
  const sessionId = request.sessionId || 'session-' + randomUUID();
  const defaultModel = ctx.get('agentDefaultModel');
  const selection = defaultModel !== undefined && isFn(defaultModel.currentSelection) ? defaultModel.currentSelection() : null;
  try {
    const handle = await agents.create({
      sessionId: sessionId,
      ...(cwd ? { meta: { cwd: cwd } } : {}),
      ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
    });
    const agent = unwrapAgent(handle);
    const created = (agent && agent.session && agent.session.id) || sessionId;
    // agents.create 不认 workspaceId：手动把会话挂进 workspace（拿 registry 实体上的 attachSession）
    let attached = false;
    if (workspace && workspace.id) {
      try {
        const registry = ctx.get('workspaceRegistry');
        const entity = registry !== undefined && isFn(registry.get) ? registry.get(workspace.id) : undefined;
        if (entity !== undefined && entity !== null && isFn(entity.attachSession)) {
          await entity.attachSession(created);
          attached = true;
        }
      } catch { /* attach 失败不视为创建失败：会话已存在，只是没挂进项目 */ }
    }
    return { ok: true, via: 'agents.create' + (attached ? '+workspace.attachSession' : ''), sessionId: created, workspaceId: workspace ? workspace.id : null };
  } catch (error) {
    return { ok: false, code: 'create-failed', via: 'agents.create', detail: String((error && error.message) || error) };
  }
}

/** 打开（激活/恢复）一个已存在会话。 */
export async function openSession(ctx, request) {
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
  if (sessionId === '') return { ok: false, code: 'missing-session-id', detail: 'sessionId 必填' };
  const controller = ctx.get('sessionController');
  if (controller !== undefined && isFn(controller.resolveAgent)) {
    try {
      const agent = unwrapAgent(await controller.resolveAgent(sessionId));
      if (agent === undefined || agent === null) return { ok: false, code: 'open-failed', via: 'sessionController.resolveAgent', detail: '未返回 Agent' };
      return { ok: true, via: 'sessionController.resolveAgent', sessionId: sessionId };
    } catch (error) {
      return { ok: false, code: 'open-rejected', via: 'sessionController.resolveAgent', sessionId: sessionId, detail: String((error && error.message) || error) };
    }
  }
  const agents = ctx.get('agents');
  if (agents === undefined) return { ok: false, code: 'no-open-api', detail: 'agents 服务不可用' };
  const live = unwrapAgent(isFn(agents.get) ? agents.get(sessionId) : undefined);
  if (live !== undefined && live !== null) return { ok: true, via: 'agents.get', sessionId: sessionId, live: true };
  if (!isFn(agents.resume)) return { ok: false, code: 'no-open-api', detail: 'agents.resume 不可用' };
  try {
    const agent = unwrapAgent(await agents.resume({ resumeSessionId: sessionId }));
    return { ok: true, via: 'agents.resume', sessionId: sessionId, live: true, resumed: agent !== undefined };
  } catch (error) {
    return { ok: false, code: 'open-rejected', via: 'agents.resume', sessionId: sessionId, detail: String((error && error.message) || error) };
  }
}

/** 目录（契约 v1.3 §8.0）：live 会话优先，其次只读扫描 $DSH_HOME/sessions 的日志头。子代理不是「会话」，全部跳过。 */
export function buildCatalog(ctx, { diskScan = true, perProjectLimit = 50 } = {}) {
  const projects = new Map();
  const bucket = (cwd) => {
    const key = cwd || '(no-cwd)';
    if (!projects.has(key)) projects.set(key, { projectId: key, cwd: cwd || null, sessions: [] });
    return projects.get(key);
  };
  const isSubagent = (agent) => {
    const depth = Number((agent && (agent.delegationDepth ?? agent.depth)) ?? 0);
    const parent = agent && (agent.parentSessionId || agent.parentId);
    return depth > 0 || (parent !== undefined && parent !== null && parent !== '');
  };
  try {
    const agents = ctx.get('agents');
    if (agents !== undefined && isFn(agents.list)) {
      for (const item of agents.list()) {
        const agent = unwrapAgent(item);
        const session = agent && agent.session;
        if (!session) continue;
        if (isSubagent(agent)) continue;   // 子代理：不进目录
        bucket(session.header && session.header.cwd).sessions.push({
          sessionId: session.id, title: null, agentName: 'DSH', model: null, reasoningEffort: null,
          state: (agent.status === 'running' ? 'working' : 'idle'), updatedAt: Date.now(), live: true,
        });
      }
    }
  } catch { /* live 枚举失败不影响目录 */ }
  let scanned = 0;
  if (diskScan) {
    const root = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions') : path.join(os.homedir(), '.dsh', 'sessions');
    try {
      for (const projectDir of fs.readdirSync(root)) {
        const projectPath = path.join(root, projectDir);
        let stat; try { stat = fs.statSync(projectPath); } catch { continue; }
        if (!stat.isDirectory()) continue;
        // 目录名是**有损**转义（'/' 与 '-' 无法区分），因此以日志 header.cwd 为准，目录名仅作兜底
        const fallbackCwd = projectDir.startsWith('-') ? unescapeProjectDir(projectDir.slice(1, -1)) : null;
        for (const entry of fs.readdirSync(projectPath)) {
          const sessionDir = path.join(projectPath, entry);
          try { if (!fs.statSync(sessionDir).isDirectory()) continue; } catch { continue; }
          const log = path.join(sessionDir, 'session.v4.jsonl.zstd');
          let logStat; try { logStat = fs.statSync(log); } catch { continue; }
          const header = readLogHeader(log);
          if (header && header.origin === 'subagent') continue;   // 子代理：不进目录
          const row = { sessionId: (header && header.id) || entry.replace(/^session-/, ''), title: null, agentName: 'DSH',
            model: null, reasoningEffort: null, state: 'idle', updatedAt: Math.round(logStat.mtimeMs), live: false,
            agentPreset: header && header.agentPreset ? header.agentPreset : null };
          const target = bucket((header && header.cwd) || fallbackCwd);
          if (!target.sessions.some((s) => s.sessionId === row.sessionId)) target.sessions.push(row);
          scanned += 1;
        }
      }
    } catch { /* 无 sessions 目录时目录为空 */ }
  }
  const list = Array.from(projects.values()).filter((p) => p.sessions.length > 0);
  list.sort((a, b) => (b.sessions[0] ? b.sessions[0].updatedAt : 0) - (a.sessions[0] ? a.sessions[0].updatedAt : 0));
  for (const project of list) project.sessions.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.updatedAt - a.updatedAt);
  return { projects: list, scanned: scanned };
}

/**
 * DSH 的项目目录名是**有损**转义：'/' 和 '-' 都写成 '-'，非 ASCII 写成 ~XXXX~。
 * 因此它只能当兜底；权威 cwd 永远取自日志 header.cwd。
 */
export function unescapeProjectDir(name) {
  return name.replace(/~([0-9A-Fa-f]{4,6})~/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).split('-').join('/');
}

/** 只读读取会话日志的**第一帧**（= session header）。首帧必然自包含，故单次解压即可。 */
export function readLogHeader(logPath) {
  let fd = null;
  try {
    fd = fs.openSync(logPath, 'r');
    const buffer = Buffer.alloc(65536);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = zlib.zstdDecompressSync(buffer.subarray(0, read)).toString('utf8');
    const line = text.split('\n')[0];
    const header = JSON.parse(line);
    return header && header.type === 'session' ? header : null;
  } catch { return null; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ } }
}


// ---------------------------------------------------------------------------
// 2.5 运行时诊断（POST /diag）：探测可用服务句柄与 prompt 调用形态
// ---------------------------------------------------------------------------

/** 列出对象上像方法的属性名（沿原型链两级，截断）。 */
function methodNames(obj, limit = 18) {
  try {
    const out = [];
    let depth = 0;
    for (let p = obj; p && p !== Object.prototype && depth < 3; p = Object.getPrototypeOf(p), depth++) {
      for (const k of Reflect.ownKeys(p)) {
        if (k === 'ctx' || k === 'constructor' || typeof k === 'symbol') continue;
        try { if (typeof obj[k] === 'function' && !String(k).startsWith('_')) out.push(String(k)); } catch { /* getter 抛错 */ }
      }
    }
    return [...new Set(out)].slice(0, limit);
  } catch { return null; }
}

export async function diagnose(ctx) {
  const names = ['sessionController', 'remote.session', 'remote.sessionController', 'agents', 'sessions', 'sessionQuery', 'commands', 'remote.commands', 'subagents', 'sessionProjections', 'workspaceRegistry'];
  const services = {};
  for (const n of names) {
    try {
      const v = ctx.get(n);
      services[n] = v === undefined || v === null
        ? null
        : { type: typeof v, methods: methodNames(v) };
    } catch (e) { services[n] = { error: String((e && e.message) || e).slice(0, 120) }; }
  }
  // 在**真实** sessionController 上试 prompt 两种形态（sessionId 用不存在值：若签名走通，
  // 期望得到业务校验错误而不是 throwIfAborted —— 后者说明 signal 没送达）
  const promptTrials = {};
  const sc = (() => { try { return ctx.get('sessionController'); } catch { return undefined; } })();
  if (sc && typeof sc.prompt === 'function') {
    const fakeReq = { sessionId: 'diag-nonexistent-0000', content: [{ type: 'text', text: 'diag' }] };
    for (const [label, args] of [['no-signal', [fakeReq]], ['with-signal', [fakeReq, new AbortController().signal]]]) {
      try { await sc.prompt(...args); promptTrials[label] = { ok: true }; }
      catch (e) { promptTrials[label] = { name: e && e.name, code: e && e.code, error: String((e && e.message) || e).slice(0, 200) }; }
    }
  } else {
    promptTrials.note = sc ? 'sessionController 无 prompt 方法' : 'sessionController 不可用';
  }
  let wsTrial = null;
  try { wsTrial = await resolveWorkspace(ctx, '/tmp/pet-probe-ws'); } catch (e) { wsTrial = { error: String((e && e.message) || e).slice(0, 160) }; }
  return { ok: true, services, promptTrials, wsTrial };
}

// ---------------------------------------------------------------------------
// 3. Unix socket HTTP 服务（事件直推 + 控制端点）
// ---------------------------------------------------------------------------

const MIME = 'application/x-ndjson; charset=utf-8';

export class PetBridge {
  constructor(ctx, options) {
    this.ctx = ctx;
    this.options = options;
    this.socketPath = options.socket || defaultSocketPath();
    this.lockPath = path.join(path.dirname(this.socketPath), SOURCE + '-plugin.lock');
    this.subscribers = new Set();
    this.seqBySession = new Map();
    this.mapper = new DshEventMapper();
    this.server = null;
    this.lockTimer = null;
    this.lockToken = randomUUID();   // 同进程 HMR 新旧实例 pid 相同：靠 token 区分，dispose 只释放自己的锁
    this.socketIno = null;   // 本实例绑定的 socket 文件 inode：dispose 时只删自己的，不误删 HMR 后继实例的
    this.started = 0;
    this.debugLog = null;   // socket 同目录的 plugin-debug.log（listen 时定下来）
    this.stats = { events: 0, dropped: 0, requests: 0, unknownEvents: 0, unknownTypes: {} };
    this.lastEventAt = new Map(); // sessionId -> 最后一次原生事件时刻（用于推断「当前会话」）
  }

  log(message) { try { this.ctx.logger.info('[dsh-pet] ' + message); } catch { /* logger 不可用 */ } }
  dbg(msg) { if (this.debugLog) dbgTo(this.debugLog, msg); }
  warn(message) { try { this.ctx.logger.warn('[dsh-pet] ' + message); } catch { /* logger 不可用 */ } }

  /** 契约 §2.4：seq 作用域 per-(source, sessionId)，各自从 0 开始。 */
  nextSeq(sessionId) {
    const key = sessionId === null || sessionId === undefined ? 'backend' : sessionId;
    const next = this.seqBySession.get(key) || 0;
    this.seqBySession.set(key, next + 1);
    return next;
  }

  eventFrame(sessionId, type, data, ts) {
    return {
      v: 1, seq: this.nextSeq(sessionId), ts: ts || Date.now(), source: SOURCE,
      sessionId: sessionId === undefined ? null : sessionId, workspace: this.workspaceOf(sessionId),
      agent: { name: 'DSH', version: this.options.agentVersion || null }, type: type, data: data,
    };
  }

  workspaceOf(sessionId) {
    try {
      const agents = this.ctx.get('agents');
      if (agents === undefined || typeof agents.get !== 'function' || !sessionId || sessionId === 'backend') return null;
      const agent = unwrapAgent(agents.get(sessionId));
      const header = agent && agent.session && agent.session.header;
      return (header && header.cwd) || null;
    } catch { return null; }
  }

  /** 推给所有 /events 订阅者；单个订阅者写失败只丢它，绝不影响 DSH 主流程。 */
  broadcast(frame) {
    const line = JSON.stringify(frame) + '\n';
    for (const res of Array.from(this.subscribers)) {
      try { res.write(line); this.stats.events += 1; }
      catch { this.subscribers.delete(res); this.stats.dropped += 1; }
    }
  }

  emitEvent(sessionId, type, data, ts) { this.broadcast(this.eventFrame(sessionId, type, data, ts)); }

  forgetSession(sessionId) { this.lastEventAt.delete(sessionId); }

  onNativeEvent(session, event) {
    try {
      const sessionId = session.id;
      this.lastEventAt.set(sessionId, typeof event.time === 'number' ? event.time : Date.now());
      for (const item of this.mapper.map(sessionId, event)) this.emitEvent(sessionId, item.type, item.data, event.time);
      const activity = coarseActivity(event.type, event.data || {});
      if (activity !== null) {
        this.emitEvent(sessionId, 'session.activity',
          { nativeSessionId: sessionId, text: truncate(activity.text, MAX_ACTIVITY).text, kind: activity.kind }, event.time);
      }
      if (event.type === 'agent-preset/selected' || event.type === 'model/selection' || event.type === 'session/title') {
        this.emitSessionMeta(session, event);
      }
      this.stats.unknownEvents = Array.from(this.mapper.unknownTypes.values()).reduce((a, b) => a + b, 0);
      this.stats.unknownTypes = Object.fromEntries(this.mapper.unknownTypes);
    } catch (error) {
      this.warn('事件映射失败（已兜住）：' + String((error && error.message) || error));
    }
  }

  /**
   * 推断「当前会话」：优先取最近有事件的**活跃**会话；否则取磁盘上 mtime 最新的会话
   * （投递前会由 agents.resume / sessionController.prompt 恢复）。
   * @returns {{sessionId:string, source:string}|null}
   */
  currentSessionId(ctx) {
    // 先问 agents 服务：只要它的列表里有「主会话」（非子代理/委派），优先挑最近活跃的那个。
    // 这是为了避开「子代理会话最近有事件」的情况——用户从悬浮窗发消息，目标是主会话。
    try {
      const agents = ctx.get('agents');
      if (agents !== undefined && typeof agents.list === 'function') {
        const raw = agents.list();
        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.agents) ? raw.agents : []);
        let mainBest = null, mainAt = -1, mainCount = 0;
        for (const item of list) {
          const agent = unwrapAgent(item);
          const id = (agent && (agent.sessionId || agent.id)) || (item && (item.sessionId || item.id));
          if (typeof id !== 'string' || id === '') continue;
          const depth = Number((agent && (agent.delegationDepth ?? agent.depth)) ?? 0);
          const parent = agent && (agent.parentSessionId || agent.parentId);
          if (depth > 0 || (parent !== undefined && parent !== null && parent !== '')) continue;   // 子代理，跳过
          mainCount++;
          const at = this.lastEventAt.has(id) ? this.lastEventAt.get(id) : 0;
          if (at >= mainAt) { mainBest = id; mainAt = at; }
        }
        if (mainBest !== null) return { sessionId: mainBest, source: 'agents.list-main', mainCount: mainCount, agentCount: list.length };
      }
    } catch { /* 列表不可用则继续用事件推断 */ }
    let best = null;
    let bestAt = -1;
    for (const [sessionId, at] of this.lastEventAt) {
      if (at <= bestAt) continue;
      const agents = ctx.get('agents');
      const live = agents !== undefined && typeof agents.get === 'function' ? unwrapAgent(agents.get(sessionId)) : undefined;
      if (live === undefined || live === null) continue;
      const depth = Number((live && (live.delegationDepth ?? live.depth)) ?? 0);
      if (depth > 0) continue;                       // 子代理不当作「当前会话」
      best = sessionId; bestAt = at;
    }
    if (best !== null) return { sessionId: best, source: 'live-most-recent' };
    try {
      const catalog = buildCatalog(ctx, { diskScan: true, perProjectLimit: 1 });
      let newest = null;
      for (const project of catalog.projects) for (const session of project.sessions) {
        if (newest === null || session.updatedAt > newest.updatedAt) newest = session;
      }
      if (newest !== null) return { sessionId: newest.sessionId, source: 'disk-newest' };
    } catch { /* 扫描失败 */ }
    return null;
  }

  /** 契约 v1.3 §3：session.meta（软件名/模型/思考程度/预设/标题）。 */
  emitSessionMeta(session, event) {
    try {
      const header = session.header || {};
      const data = (event && event.data) || {};
      const meta = { nativeSessionId: session.id, agentName: 'DSH', agentVersion: this.options.agentVersion || null };
      if (header.agentPreset) meta.agentPreset = header.agentPreset;
      if (event && event.type === 'session/title' && typeof data.title === 'string') meta.title = data.title;
      if (event && event.type === 'model/selection') {
        if (typeof data.provider === 'string') meta.provider = data.provider;
        if (typeof data.model === 'string') meta.model = data.model;
        if (typeof data.reasoningEffort === 'string') meta.reasoningEffort = data.reasoningEffort;
      }
      if (event && event.type === 'agent-preset/selected' && typeof data.preset === 'string') meta.agentPreset = data.preset;
      this.emitEvent(session.id, 'session.meta', meta, event && event.time);
    } catch (error) {
      this.warn('session.meta 生成失败（已兜住）：' + String((error && error.message) || error));
    }
  }

  emitSessionStart(session) {
    try {
      const header = session.header || {};
      const startedAt = typeof header.createdAt === 'number' ? header.createdAt : Date.now();
      // 子代理 → 宿主关联：agents 服务带 parentSessionId/parentId（快照据此精确挂活跃度；缺失时 Hub 按项目兜底）
      let parentSessionId = null;
      try {
        const agents = this.ctx.get('agents');
        if (agents !== undefined && typeof agents.list === 'function') {
          for (const item of agents.list()) {
            const agent = unwrapAgent(item);
            if (agent && agent.session && agent.session.id === session.id) {
              const p = agent.parentSessionId ?? agent.parentId;
              if (p !== undefined && p !== null && p !== '') parentSessionId = String(p);
              break;
            }
          }
        }
      } catch { /* agents 服务不可用：不带 parent，Hub 按项目兜底 */ }
      // 会话创建 ≠ 开始思考（契约 §4.2 的 session.start → thinking 只用于「会话开始工作」）。
      // 新建会话通常是空闲的：这里发 v1.3 的 session.meta（元数据帧，不进状态机），
      // 让悬浮窗建立该会话的行但显示空闲，而不是永远「思考中」（2026-10-05 实测踩坑）。
      this.emitEvent(session.id, 'session.meta', {
        nativeSessionId: session.id, startedAt: startedAt, workspace: header.cwd || null,
        agentName: 'DSH', agentVersion: this.options.agentVersion || null,
        title: header.title ?? null,
        // origin/delegationDepth：让 Hub 零延迟识别子代理（不必等目录扫描的 5s 缓存）
        origin: header.origin ?? null, delegationDepth: header.delegationDepth ?? null,
        parentSessionId,
      }, startedAt);
      if (header.agentPreset) this.emitSessionMeta(session, { type: 'agent-preset/selected', data: { preset: header.agentPreset }, time: startedAt });
    } catch (error) {
      this.warn('session.meta（created）生成失败（已兜住）：' + String((error && error.message) || error));
    }
  }

  async handle(req, res) {
    this.stats.requests += 1;
    const url = new URL(req.url || '/', 'http://localhost');
    const route = req.method + ' ' + url.pathname;
    if (route === 'GET /health') return this.json(res, 200, {
      ok: true, contract: CONTRACT, source: SOURCE, pid: process.pid, socket: this.socketPath,
      startedAt: this.started, subscribers: this.subscribers.size, events: this.stats.events,
      unknownEvents: this.stats.unknownEvents,
      capabilities: { canDecide: false, canInput: true, canCatalog: true, canOpen: true, canCreate: true },
      codeVersion: 'agents-first-2026-10-05T16:00',
    });
    if (route === 'GET /events') return this.stream(res);
    if (req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { return this.json(res, 400, { ok: false, code: 'bad-json', detail: String((error && error.message) || error) }); }
      if (url.pathname === '/input') return this.json(res, 200, await deliverInput(this.ctx, body, this));
      if (url.pathname === '/new') return this.json(res, 200, await createSession(this.ctx, body));
      if (url.pathname === '/open') return this.json(res, 200, await openSession(this.ctx, body));
      if (url.pathname === '/ctl') return this.control(res, body);
      if (url.pathname === '/diag') return this.json(res, 200, await diagnose(this.ctx));
      return this.json(res, 404, { ok: false, code: 'not-found', detail: url.pathname });
    }
    return this.json(res, 404, { ok: false, code: 'not-found', detail: route });
  }

  /** 契约 v1.3 §2.2 控制帧：catalog.get / session.new / session.open / ack。 */
  async control(res, frame) {
    const ctl = frame && frame.ctl;
    if (ctl === 'catalog.get') {
      const catalog = buildCatalog(this.ctx, { diskScan: this.options.diskScan !== false });
      const payload = { ctl: 'catalog', contract: CONTRACT, ts: Date.now(), projects: catalog.projects };
      this.broadcast(payload);
      return this.json(res, 200, { ok: true, ctl: 'catalog', contract: CONTRACT, projects: catalog.projects, scannedLogs: catalog.scanned });
    }
    if (ctl === 'session.new') return this.json(res, 200, await createSession(this.ctx, frame));
    if (ctl === 'session.open') return this.json(res, 200, await openSession(this.ctx, frame));
    if (ctl === 'ack') return this.json(res, 200, { ok: true, ctl: 'ack', contract: CONTRACT, canDecide: false, canCatalog: true, canOpen: true, canCreate: true, heartbeatMs: HEARTBEAT_MS });
    return this.json(res, 400, { ok: false, code: 'unknown-ctl', detail: String(ctl) });
  }

  json(res, status, payload) {
    const body = JSON.stringify(payload) + '\n';
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    } catch { /* 客户端已断开 */ }
  }

  /** GET /events：长连 NDJSON。先发契约 §5.2 的 hello，再持续推事件。 */
  stream(res) {
    try {
      res.writeHead(200, { 'content-type': MIME, 'cache-control': 'no-store', 'transfer-encoding': 'chunked' });
    } catch { return; }
    this.subscribers.add(res);
    try {
      res.write(JSON.stringify({ ctl: 'hello', contract: CONTRACT, source: SOURCE,
        adapterVersion: this.options.adapterVersion || '0.1.0', resumeAfter: null, canDecide: false,
        canCatalog: true, canOpen: true, canCreate: true, observes: OBSERVES }) + '\n');
    } catch { /* ignore */ }
    res.on('close', () => { this.subscribers.delete(res); });
    res.on('error', () => { this.subscribers.delete(res); });
  }

  acquireLock() {
    if (this.lockTimer) { clearInterval(this.lockTimer); this.lockTimer = null; }   // rebind 重入时先清旧定时器
    if (fs.existsSync(this.lockPath)) {
      let previous = null;
      try { previous = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); } catch { previous = null; }
      if (previous && Number.isInteger(previous.pid) && previous.pid !== process.pid) {
        let alive = false;
        try { process.kill(previous.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
        if (alive) { const m = '已有存活的 dsh-pet 插件（pid ' + previous.pid + '）占用 ' + this.lockPath + '；按契约 §5.1 拒绝启动'; this.dbg('acquireLock 拒绝：' + m); throw new Error(m); }
        this.warn('发现陈旧锁（pid ' + previous.pid + ' 已不存在），接管 ' + this.lockPath);
        this.dbg('acquireLock 接管陈旧锁 pid=' + previous.pid);
      }
    }
    const write = () => fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), source: SOURCE, token: this.lockToken }));
    write();
    this.lockTimer = setInterval(() => {
      try { write(); } catch { /* ignore */ }
      // 自愈：内核还在监听但 socket 文件丢失（HMR 旧实例 dispose 误删 / 外部删除）→ 重绑，
      // 否则外部进程 ENOENT 连不进来，插件「活着却不可达」（2026-10-05 实测踩坑）。
      // server 为 null（重绑中途失败）也算：定时器只在本实例持有锁时存在，重试不会劫持别人的锁。
      try {
        if ((!this.server || this.server.listening) && !fs.existsSync(this.socketPath)) { this.dbg('自愈触发：socket 文件丢失 → rebind'); this.rebind(); }
      } catch { /* ignore */ }
    }, 5000);
    if (typeof this.lockTimer.unref === 'function') this.lockTimer.unref();
  }

  releaseLock() {
    if (this.lockTimer) clearInterval(this.lockTimer);
    try {
      const current = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (current.pid === process.pid && current.token === this.lockToken) fs.unlinkSync(this.lockPath);
    } catch { /* ignore */ }
  }

  /** socket 文件丢失后的自愈重绑：关旧 server（内核监听点）→ 重新 listen 产生新文件。 */
  rebind() {
    this.dbg('rebind 开始');
    this.warn('socket 文件丢失（' + this.socketPath + '），5s 内自动重绑');
    try { if (this.server) this.server.close(); } catch { /* ignore */ }
    this.server = null;
    this.socketIno = null;
    this.listen().then(() => this.dbg('rebind 完成：socket 已重建'), (error) => this.dbg('rebind 失败：' + String((error && error.message) || error)));
  }

  listen() {
    this.debugLog = path.join(path.dirname(this.socketPath), 'plugin-debug.log');
    this.dbg('listen 开始：' + this.socketPath);
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    this.acquireLock();
    if (fs.existsSync(this.socketPath)) {
      try { fs.unlinkSync(this.socketPath); this.warn('清理了陈旧的 socket 文件 ' + this.socketPath); this.dbg('listen：清理陈旧 socket 文件'); }
      catch (error) { const m = '无法清理陈旧 socket ' + this.socketPath + '：' + String((error && error.message) || error); this.dbg('listen 失败：' + m); throw new Error(m); }
    }
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.warn('请求处理失败（已兜住）：' + String((error && error.message) || error));
        this.dbg('请求处理失败：' + String((error && error.message) || error) + ' ' + req.method + ' ' + req.url);
        this.json(res, 500, { ok: false, code: 'internal', detail: String((error && error.message) || error) });
      });
    });
    this.server.on('error', (error) => { this.warn('socket 服务错误：' + String((error && error.message) || error)); this.dbg('server error 事件：' + String((error && error.message) || error)); });
    return new Promise((resolve, reject) => {
      this.server.once('error', (error) => { this.dbg('listen 拒绝：' + String((error && error.message) || error)); reject(error); });
      this.server.listen(this.socketPath, () => {
        this.started = Date.now();
        try { this.socketIno = fs.statSync(this.socketPath).ino; } catch { this.socketIno = null; }
        this.dbg('listen 成功：ino=' + this.socketIno);
        this.log('socket 已监听 ' + this.socketPath + '（契约 v' + CONTRACT + '）');
        resolve();
      });
    });
  }

  dispose() {
    this.dbg('dispose 开始：ino=' + this.socketIno + ' token=' + String(this.lockToken).slice(0, 8));
    for (const res of Array.from(this.subscribers)) { try { res.end(); } catch { /* ignore */ } }
    this.subscribers.clear();
    if (this.server) { try { this.server.close(); } catch { /* ignore */ } }
    this.releaseLock();
    // 只删**自己绑定**的 socket 文件（inode 对照）。HMR 重载时新旧实例同进程共存，
    // 无条件 unlink 会删掉后继实例的 socket，造成「内核在听、文件不在」的孤儿（2026-10-05 实测踩坑）。
    if (this.socketIno !== null) {
      try {
        const st = fs.statSync(this.socketPath);
        if (st.ino === this.socketIno) { fs.unlinkSync(this.socketPath); this.dbg('dispose：删除自己的 socket（ino 匹配）'); }
        else this.dbg('dispose：socket 属于后继实例（ino 不匹配），跳过删除');
      } catch { this.dbg('dispose：socket 文件已不在，无需删除'); /* 文件已不在：无需处理 */ }
    }
    this.dbg('dispose 完成');
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 256) { reject(new Error('请求体超过 256 KB')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 4. Cordis 插件入口
// ---------------------------------------------------------------------------

/** 最近一次 apply 建立的桥（进程内测试用；正常使用请通过 socket 访问）。 */
export let activeBridge = null;

export function apply(ctx, config) {
  // apply 期间的调试日志：socket 目录可能在 listen 前还未知，先落到缺省目录
  dbgTo(path.join(path.dirname(defaultSocketPath()), 'plugin-debug.log'), 'apply 开始：bridge 构造');
  const options = config || {};
  const bridge = new PetBridge(ctx, {
    socket: options.socket || null,
    adapterVersion: options.adapterVersion || '0.1.0',
    agentVersion: options.agentVersion || null,
    diskScan: options.diskScan !== false,
  });
  activeBridge = bridge; // 供测试/探针读取（不注册成 Cordis 服务，避免需要 provide 声明）

  ctx.on('session/created', (session) => bridge.emitSessionStart(session));
  ctx.on('session/event', (session, event) => bridge.onNativeEvent(session, event));
  ctx.on('session/disposed', (session) => bridge.emitEvent(session.id, 'session.end', {
    nativeSessionId: session.id, endedAt: Date.now(), reason: 'unknown', durationMs: null, summary: null,
  }));

  bridge.listen().then(() => bridge.dbg('apply 完成：listen 成功'), (error) => {
    bridge.dbg('apply：listen 失败（插件保持加载）：' + String((error && error.message) || error));
    bridge.warn('监听失败：' + String((error && error.message) || error) + '（插件保持加载，事件仍会映射但无订阅者）');
  });

  const heartbeat = setInterval(() => {
    bridge.emitEvent('backend', 'pet.heartbeat', { nativeSessionId: null, load: 0, sessionCount: bridge.seqBySession.size }, Date.now());
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  ctx.effect(() => () => {
    clearInterval(heartbeat);
    bridge.dispose();
    bridge.log('已卸载，socket 与锁已释放');
  }, 'dsh-pet: dispose socket and lock');
}

export default { name, inject, apply };

