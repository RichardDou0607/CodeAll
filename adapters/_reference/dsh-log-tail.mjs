#!/usr/bin/env node
/**
 * adapters/_reference/dsh-log-tail.mjs
 * ---------------------------------------------------------------------------
 * DSH 会话日志 → 规范事件 v1（docs/00-interface-contract.md）参考适配器。
 *
 * 事实基础（2026-10-05 在本机 DSH 0.2.0-rc.2 上实测，详见 docs/35-dsh-pet-bridge.md）：
 *   1. 会话日志 ~/.dsh/sessions/--<escaped-cwd>--/<escaped-id>/session.v<N>.jsonl.zstd
 *      是「多帧 Zstandard 拼接容器」：一个批次（200 ms 窗口 / 满一批）一个独立可解压的
 *      frame，frame 之间没有任何分隔符。Node 的 zlib.zstdDecompressSync 只解第一帧，
 *      createZstdDecompress 流式解压同样在第一帧结束处停止 —— 这是「只能读到首行
 *      session 头」的真正原因。
 *   2. 正确读法：先**结构化扫描** frame 边界（RFC 8878 的 frame header + block header），
 *      再对每个完整 frame 调 zstdDecompressSync。算法与 DSH 自己的
 *      dsh-session-persistence-jsonl/lib/index.js 中的 scanZstdFrames 一致。
 *   3. 追加写入 = 追加一个新 frame；写入过程中可能出现「尾部半帧」(torn tail)，
 *      扫描器会返回 tornStart，本脚本用 ZSTD_e_flush 尽力恢复其明文前缀，
 *      半行 JSON 一律丢弃（绝不把半个 JSON 送出去）。
 *
 * 用法：
 *   node adapters/_reference/dsh-log-tail.mjs --list
 *   node adapters/_reference/dsh-log-tail.mjs --latest            # 打印最新会话全量规范事件
 *   node adapters/_reference/dsh-log-tail.mjs --session 0a1b2c3d-... --follow
 *   node adapters/_reference/dsh-log-tail.mjs --file <path> --follow --socket /tmp/agent-pet/dsh.sock
 *   node adapters/_reference/dsh-log-tail.mjs --self-check
 *
 * 退出码：0 正常；1 运行期错误（打印人类可读原因，不抛栈崩掉）；2 参数错误。
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528; // readUInt32LE === 4247762216
const CONTRACT_VERSION = 1;
const SOURCE_ID = 'dsh';
const MAX_SUMMARY = 160;
const MAX_TEXT = 280; // 契约 §3 message.assistant.text <= 280
const HEARTBEAT_MS = 15_000;   // 契约 §3.1 心跳间隔
const BACKEND_SESSION_ID = 'backend'; // 契约 §2.4 后端级事件的保留 sessionId
// 契约 v1.2 §5.2.1：observes 声明适配器实际能产生的事件族，Hub 据此在工作中隐藏不支持的指标。
const OBSERVES = ['session.*', 'turn.*', 'step.*', 'tool.*', 'approval.*', 'message.assistant', 'error.*', 'pet.heartbeat'];
const CONTRACT_HELLO = { ctl: 'hello', contract: CONTRACT_VERSION, source: SOURCE_ID, adapterVersion: '0.2.0', resumeAfter: null, canDecide: false, observes: OBSERVES };

// ---------------------------------------------------------------------------
// 1. Zstandard 多帧扫描 / 解码（纯 JS，不依赖 zstd CLI）
// ---------------------------------------------------------------------------

/** 结构化定位所有完整 frame；EOF 落在最后一帧内部时返回 tornStart。 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error('不是 Zstandard frame：offset ' + offset + ' 处 magic 不符（' + buffer.subarray(offset, offset + 4).toString('hex') + '）');
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset); offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('frame header 保留了 bit（offset ' + (offset - 1) + '）');
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictFlag = descriptor & 3;
    const dictBytes = dictFlag === 3 ? 4 : dictFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const rest = (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes;
    if (buffer.length - offset < rest) return { frames, tornStart: start };
    offset += rest;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('block type 3 是保留值（offset ' + (offset - 3) + '）');
      const payload = blockType === 1 ? 1 : blockSize; // RLE 块只有 1 字节载荷
      if (buffer.length - offset < payload) return { frames, tornStart: start };
      offset += payload;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/**
 * 解码整个容器：完整帧逐个解压；尾部半帧用 ZSTD_e_flush 尽力恢复，且只保留完整行。
 * @returns {{frames:number, tornStart:(number|undefined), lines:string[], warnings:string[]}}
 */
export function decodeContainer(buffer) {
  const warnings = [];
  const { frames, tornStart } = scanZstdFrames(buffer);
  const parts = [];
  for (const frame of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
    } catch (error) {
      warnings.push('frame@' + frame.start + ' 解压失败，已跳过：' + error.message);
    }
  }
  let tornText = '';
  if (tornStart !== undefined) {
    try {
      const prefix = zlib.zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: zlib.constants.ZSTD_e_flush });
      tornText = prefix.toString('utf8');
      const cut = tornText.lastIndexOf('\n'); // 只保留完整行，半行必须丢掉
      tornText = cut >= 0 ? tornText.slice(0, cut + 1) : '';
    } catch (error) {
      warnings.push('尾部半帧不可恢复（写入中，下轮重试）：' + error.message);
    }
  }
  const text = Buffer.concat(parts).toString('utf8') + tornText;
  const lines = text.split('\n').filter((line) => line.length > 0);
  return { frames: frames.length, tornStart, lines, warnings };
}

// ---------------------------------------------------------------------------
// 2. 会话日志定位
// ---------------------------------------------------------------------------

export function sessionsRoot() {
  return process.env.DSH_SESSIONS_ROOT ?? path.join(os.homedir(), '.dsh', 'sessions');
}

/** 列出 root 下所有会话日志，最新（mtime）在前。只读，不进入、不写。 */
export function listSessionLogs(root = sessionsRoot()) {
  const out = [];
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { throw new Error('无法读取会话根目录 ' + root + '：' + error.message); }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    let sessions;
    try { sessions = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(projectDir, session.name);
      let entries;
      try { entries = fs.readdirSync(sessionDir); } catch { continue; }
      // runtime 选「编号最高的 canonical generation」；本脚本按同样规则取 v 最高的 .jsonl.zstd
      const candidates = entries
        .filter((name) => /^session(\.v\d+)?\.jsonl\.zstd$/.test(name))
        .map((name) => ({ name, version: Number((/\.v(\d+)\./.exec(name) ?? [])[1] ?? 0) }))
        .sort((a, b) => b.version - a.version);
      if (candidates.length === 0) continue;
      const file = path.join(sessionDir, candidates[0].name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      out.push({
        file,
        project: project.name,
        sessionDirName: session.name,
        nativeSessionId: session.name.replace(/^session-/, ''),
        version: candidates[0].version,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** 会话 id 的注入式转义：把不安全字符转成 ~XXXX~（与 DSH 的目录命名规则一致）。 */
export function escapeSessionId(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, (ch) => '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '~');
}

// ---------------------------------------------------------------------------
// 3. DSH 原生事件 → 规范事件（映射表见 docs/35-dsh-pet-bridge.md §5）
// ---------------------------------------------------------------------------

const TOOL_CATEGORY = [
  [/^(bash|run_code|pwsh|terminal|shell|execute)/i, 'exec'],
  [/^(read|view|cat|grep|glob|search|ls|list|fs_search)/i, 'read'],
  [/^(write|edit|str_replace|apply_patch|create|mkdir|rm|delete|move|present)/i, 'write'],
  [/^(web_fetch|web_search|http|fetch|curl|browser)/i, 'net'],
];

export function classifyTool(name) {
  for (const [re, category] of TOOL_CATEGORY) if (re.test(name)) return category;
  return 'other';
}

/** DSH 工具名 → 契约 §3.3 的 kind 枚举 command|file-write|network|permission|other。 */
export function approvalKind(toolName, category) {
  if (category === 'exec' || /^(bash|run_code|pwsh|terminal|shell)/i.test(toolName)) return 'command';
  if (category === 'write') return 'file-write';
  if (category === 'net') return 'network';
  if (/sandbox|permission|escalat/i.test(toolName)) return 'permission';
  return 'other';
}

export function riskOf(category) {
  return { read: 0, net: 1, write: 1, exec: 2, other: 0 }[category] ?? 0;
}

function firstLine(text, max = MAX_SUMMARY) {
  if (typeof text !== 'string') return '';
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function parseArgs(raw) {
  if (typeof raw !== 'string') return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; }
  catch { return {}; }
}

/** 从工具参数里挑一个人类可读摘要（命令 / 路径 / URL / 描述）。 */
export function summariseToolCall(name, args) {
  const a = parseArgs(args);
  for (const key of ['command', 'cmd', 'file_path', 'path', 'url', 'pattern', 'query', 'description']) {
    if (typeof a[key] === 'string' && a[key].trim() !== '') return firstLine(a[key]);
  }
  if (typeof a.code === 'string') return firstLine(a.code);
  return firstLine(String(name));
}

/** 工具结果 → {status, summary}；isError 是权威信号，denied 只能靠文本启发式。 */
export function summariseToolResult(data) {
  const message = data?.message ?? {};
  const text = (message.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
  const status = message.isError === true ? 'error'
    : (/denied by|blocked by|rejected|not permitted|permission denied/i.test(text) ? 'denied' : 'ok');
  return { status, summary: firstLine(text) || null };
}

function assistantText(data) {
  const content = data?.message?.content ?? [];
  const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();
  return text === '' ? null : text;
}

const APPROVAL_OUTCOME = { 'allowed-once': 'allow', rejected: 'deny', unavailable: 'deny', cancelled: 'timeout' };

/** 有状态映射器：把一条条原生事件折成 0..n 条规范事件（信封由适配器补）。 */
export class DshEventMapper {
  constructor({ nativeSessionId, workspace, agentVersion }) {
    this.nativeSessionId = nativeSessionId ?? null;
    this.workspace = workspace ?? null;
    this.agent = { name: 'DSH', version: agentVersion ?? null };
    this.turnOpen = new Map();      // turn -> 开始时刻
    this.stepOpen = new Map();      // 'turn/step' -> {startedAt, index}
    this.stepToolError = new Map(); // 'turn/step' -> 该步是否出现过工具错误
    this.calls = new Map();         // callId -> {name, category, at, turn, step}
    this.approvals = new Map();     // approval id -> {at, callId}
    this.questions = new Map();     // callId -> questionId
    this.lastInputKind = 'user';
    this.unknownTypes = new Map();
  }

  reset() {
    this.turnOpen.clear(); this.stepOpen.clear(); this.stepToolError.clear();
    this.calls.clear(); this.approvals.clear(); this.questions.clear();
  }

  turnId(turn) { return 'turn-' + turn; }
  stepId(turn, step) { return 'turn-' + turn + '/step-' + step; }

  /** 把一条原生事件映射为规范事件数组（{type, data}）。 */
  map(event) {
    const t = event?.type;
    const d = event?.data ?? {};
    const at = typeof event?.time === 'number' ? event.time : Date.now();
    switch (t) {
      case 'turn/start': {
        this.turnOpen.set(d.turn, at);
        return [
          { type: 'turn.start', data: { nativeSessionId: this.nativeSessionId, turnId: this.turnId(d.turn), inputKind: this.lastInputKind } },
          { type: 'agent.status', data: { state: 'thinking', detail: null } },
        ];
      }
      case 'turn/end': {
        const startedAt = this.turnOpen.get(d.turn);
        this.turnOpen.delete(d.turn);
        const kind = d.reason?.kind ?? 'completed';
        const status = kind === 'completed' ? 'ok' : (kind === 'aborted' ? 'aborted' : 'error');
        const out = [{ type: 'turn.end', data: {
          nativeSessionId: this.nativeSessionId, turnId: this.turnId(d.turn), status,
          durationMs: startedAt === undefined ? 0 : Math.max(0, at - startedAt),
          summary: kind === 'completed' ? null : kind } }];
        if (status === 'error') out.push({ type: 'error.raised', data: { scope: 'session', code: kind, message: 'turn 以 ' + kind + ' 结束', fatal: false } });
        return out;
      }
      case 'step/start': {
        const key = this.stepId(d.turn, d.step);
        this.stepOpen.set(key, { startedAt: at, index: d.step });
        this.stepToolError.set(key, false);
        return [
          { type: 'step.start', data: { turnId: this.turnId(d.turn), stepId: key, index: d.step } },
          { type: 'agent.status', data: { state: 'working', detail: null } },
        ];
      }
      case 'step/end': {
        const key = this.stepId(d.turn, d.step);
        const open = this.stepOpen.get(key);
        const failed = this.stepToolError.get(key) === true;
        this.stepOpen.delete(key); this.stepToolError.delete(key);
        return [{ type: 'step.end', data: {
          turnId: this.turnId(d.turn), stepId: key, index: d.step,
          status: failed ? 'error' : 'ok',
          durationMs: open === undefined ? 0 : Math.max(0, at - open.startedAt) } }];
      }
      case 'tool/call': {
        const name = String(d.name ?? 'unknown');
        const category = classifyTool(name);
        this.calls.set(d.callId, { name, category, at, turn: d.turn, step: d.step });
        const summary = summariseToolCall(name, d.arguments);
        if (/ask_user/i.test(name)) {
          const a = parseArgs(d.arguments);
          const q = a.questions?.[0] ?? {};
          const questionId = d.callId;
          this.questions.set(d.callId, questionId);
          const options = Array.isArray(q.options)
            ? q.options.map((o) => (typeof o === 'string' ? o : (o?.label ?? ''))).filter(Boolean).slice(0, 8)
            : [];
          return [{ type: 'user.question', data: {
            questionId, text: firstLine(q.question ?? a.question ?? summary) || summary,
            ...(options.length > 0 ? { options } : {}) } }];
        }
        return [{ type: 'tool.call', data: { toolName: name, callId: d.callId, summary, category, risk: riskOf(category) } }];
      }
      case 'tool/result': {
        const callId = d.toolCallId ?? d.message?.source?.callId;
        const call = this.calls.get(callId);
        this.calls.delete(callId);
        const { status, summary } = summariseToolResult(d);
        if (call !== undefined && status === 'error') {
          const key = this.stepId(call.turn, call.step);
          if (this.stepToolError.has(key)) this.stepToolError.set(key, true);
        }
        const out = [];
        if (this.questions.has(callId)) {
          this.questions.delete(callId);
          out.push({ type: 'user.answer', data: { questionId: callId, choice: firstLine(summary ?? 'answered') } });
        } else {
          out.push({ type: 'tool.result', data: {
            callId, status, summary,
            durationMs: call === undefined ? 0 : Math.max(0, at - call.at) } });
        }
        if (status === 'error') out.push({ type: 'error.raised', data: { scope: 'tool', code: null, message: summary ?? '工具失败', fatal: false } });
        return out;
      }
      case 'approval/asked': {
        // DSH 的审批审计 id 是 data.id —— 契约 §3.3 要求 requestId 必填并与 resolved 配对
        this.approvals.set(d.id, { at, callId: d.callId ?? null });
        const call = d.callId === undefined ? undefined : this.calls.get(d.callId);
        const category = call?.category ?? classifyTool(String(d.toolName ?? ''));
        return [
          { type: 'approval.request', data: {
            requestId: String(d.id),
            kind: approvalKind(String(d.toolName ?? ''), category),
            summary: firstLine(d.reason ?? '需要批准'),
            risk: Math.max(1, riskOf(category)),
            ...(d.callId === undefined ? {} : { callId: d.callId }),
            expiresAt: null } },
          { type: 'agent.status', data: { state: 'waiting', detail: null } },
        ];
      }
      case 'approval/decided': {
        const open = this.approvals.get(d.id);
        this.approvals.delete(d.id);
        // DSH OUTCOMES = allowed-once | rejected | cancelled | unavailable（dsh-user-approval）
        const decision = APPROVAL_OUTCOME[d.outcome] ?? 'deny';
        return [{ type: 'approval.resolved', data: {
          requestId: String(d.id), decision,
          latencyMs: open === undefined ? 0 : Math.max(0, at - open.at) } }];
      }
      case 'llm/retry':
      case 'llm/retry-started':
        return [{ type: 'error.raised', data: { scope: 'llm', code: d.code ?? null, message: firstLine(d.message ?? '模型请求重试'), fatal: false } }];
      case 'assistant/message': {
        const text = assistantText(d);
        if (text === null) return [];
        const truncated = text.length > MAX_TEXT;
        return [{ type: 'message.assistant', data: {
          turnId: this.turnId(d.turn ?? 0), text: truncated ? text.slice(0, MAX_TEXT - 1) + '…' : text, truncated } }];
      }
      case 'user/message':
      case 'agent/inbox/spliced':
        this.lastInputKind = 'user';
        return [];
      case 'system/message':
        this.lastInputKind = 'system';
        return [];
      default:
        this.unknownTypes.set(t, (this.unknownTypes.get(t) ?? 0) + 1);
        return [];
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 输出：stdout / Unix domain socket（契约 §5 行分隔 JSONL）
// ---------------------------------------------------------------------------

/** 简单的 socket 输出端：连不上就退避重连，并做有界缓冲，绝不让适配器崩掉。 */
export class SocketSink {
  constructor(socketPath, { onWarn = () => {} } = {}) {
    this.socketPath = socketPath;
    this.onWarn = onWarn;
    this.socket = null;
    this.buffer = [];
    this.retryAt = 0;
    this.ackFrame = null; // 契约 §5.2：Hub 回 {"ctl":"ack",...}
    this.onControl = () => {};
  }
  ensure() {
    if (this.socket !== null || Date.now() < this.retryAt) return;
    const socket = net.createConnection(this.socketPath);
    let incoming = '';
    socket.on('data', (chunk) => {
      incoming += chunk.toString('utf8');
      for (;;) {
        const cut = incoming.indexOf('\n');
        if (cut < 0) break;
        const line = incoming.slice(0, cut); incoming = incoming.slice(cut + 1);
        if (line.trim() === '') continue;
        let frame;
        try { frame = JSON.parse(line); }
        catch { this.onWarn('忽略无法解析的 Hub 下行帧（' + line.length + ' 字节）'); continue; }
        if (frame.ctl === 'ack') { this.ackFrame = frame; this.onControl(frame); continue; }
        this.onControl(frame); // snapshot / decide 等交给上层
      }
    });
    socket.on('connect', () => {
      this.socket = socket;
      this.onWarn('已连接 ' + this.socketPath);
      // 契约 §5.2 步骤 1：连接后立即发 hello（先判 ctl 再判 type）
      socket.write(JSON.stringify(CONTRACT_HELLO) + '\n');
      while (this.buffer.length > 0) socket.write(this.buffer.shift());
    });
    socket.on('error', (error) => {
      this.socket = null;
      this.retryAt = Date.now() + 2000;
      this.onWarn('socket 连接失败（' + error.message + '），2 s 后重试');
    });
    socket.on('close', () => { this.socket = null; this.retryAt = Date.now() + 1000; });
  }
  write(line) {
    this.ensure();
    if (this.socket !== null && this.socket.writable) { this.socket.write(line); return; }
    if (this.buffer.length < 512) this.buffer.push(line); // 有界缓冲：桌宠没起来时不 OOM
  }
  close() { try { this.socket?.end(); } catch { /* 忽略关闭失败 */ } }
  /**
   * 契约 §5.2 步骤 2/3：等 ack（3 s 超时，重试 2 次）。
   * @returns ack 帧，或 null（调用方必须停止发送事件并以非 0 退出）。
   */
  async handshake({ timeoutMs = 3000, retries = 2 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      this.ensure();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (this.ackFrame !== null) return this.ackFrame;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      this.onWarn('等待 ack 超时（第 ' + (attempt + 1) + '/' + (retries + 1) + ' 次，' + timeoutMs + ' ms）');
      try { this.socket?.destroy(); } catch { /* 忽略 */ }
      this.socket = null; this.retryAt = 0;
    }
    return null;
  }
}

/**
 * 契约 v1.2 §5.1 单实例：同目录写 <source>.lock（pid + 心跳时间戳）；
 * 已有存活锁则拒绝启动，且**绝不 unlink 他人的 socket**。
 * @returns {{lockPath:string, release:() => void}}
 */
export function acquireInstanceLock(socketPath, { onWarn = () => {} } = {}) {
  const lockPath = path.join(path.dirname(socketPath), SOURCE_ID + '.lock');
  const write = () => fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), source: SOURCE_ID }));
  if (fs.existsSync(lockPath)) {
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { previous = null; }
    if (previous !== null && Number.isInteger(previous.pid) && previous.pid !== process.pid) {
      let alive = false;
      try { process.kill(previous.pid, 0); alive = true; }
      catch (error) { alive = error.code === 'EPERM'; }
      if (alive) {
        throw new Error('已有存活的 ' + SOURCE_ID + ' 适配器占用 ' + lockPath
          + '（pid ' + previous.pid + '，心跳 ' + new Date(previous.at ?? 0).toISOString() + '）；按契约 §5.1 拒绝启动');
      }
      onWarn('发现陈旧锁（pid ' + previous.pid + ' 已不存在），接管 ' + lockPath);
    }
  }
  write();
  const timer = setInterval(() => { try { write(); } catch { /* 心跳写失败不致命 */ } }, 5000);
  if (typeof timer.unref === 'function') timer.unref();
  const release = () => {
    clearInterval(timer);
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (current.pid === process.pid) fs.unlinkSync(lockPath);
    } catch { /* 锁已被他人接管或已删除 */ }
  };
  return { lockPath, release };
}

function makeSink(argv) {
  if (argv.socket !== undefined) {
    fs.mkdirSync(path.dirname(argv.socket), { recursive: true });
    return new SocketSink(argv.socket, { onWarn: (m) => process.stderr.write('[dsh-log-tail] ' + m + '\n') });
  }
  return { write: (line) => process.stdout.write(line), close: () => {} };
}

// ---------------------------------------------------------------------------
// 5. 适配器主体：一次性回放 + 跟随追加
// ---------------------------------------------------------------------------

export class DshLogAdapter {
  constructor({ file, mapper, sink, follow = false, pollMs = 150, idleEndMs = 0, onWarn = () => {} }) {
    this.file = file;
    this.mapper = mapper;
    this.sink = sink;
    this.follow = follow;
    this.pollMs = pollMs;
    this.idleEndMs = idleEndMs;
    this.onWarn = onWarn;
    this.seqBySession = new Map(); // 契约 §2.4：seq 作用域为 per-(source, sessionId)，各自从 0 开始
    this.frameOffset = 0;      // 已消费到的「帧边界」字节偏移
    this.lastNativeSeq = null; // 原生 seq 高水位，用于尾部半帧恢复后的去重
    this.lastEventAt = 0;
    this.lastGrowthAt = Date.now();
    this.sawHeader = false;
    this.stopped = false;
    this.sessionStartedAt = null; // v1.2：会话计时起点（来自日志首行 createdAt）
  }

  /** 后端级事件（如 pet.heartbeat）用契约 §2.4 的保留会话 id。 */
  emit(type, data, ts, sessionIdOverride) {
    const sessionId = sessionIdOverride ?? this.mapper.nativeSessionId;
    const seq = this.seqBySession.get(sessionId) ?? 0;
    this.seqBySession.set(sessionId, seq + 1);
    const envelope = {
      v: CONTRACT_VERSION,
      seq,
      ts: ts ?? Date.now(),
      source: SOURCE_ID,
      sessionId,
      workspace: sessionId === BACKEND_SESSION_ID ? null : this.mapper.workspace,
      agent: { name: 'DSH', version: this.mapper.agent.version ?? null },
      type,
      data,
    };
    this.sink.write(JSON.stringify(envelope) + '\n');
  }

  handleLine(line) {
    let event;
    try { event = JSON.parse(line); }
    catch { this.onWarn('跳过无法解析的 JSONL 行（' + line.length + ' 字节）'); return; }
    if (event.type === 'session') { this.applyHeader(event); return; }
    if (typeof event.seq === 'number') {
      if (this.lastNativeSeq !== null && event.seq <= this.lastNativeSeq) return; // 尾部半帧恢复的重读去重
      this.lastNativeSeq = event.seq;
    }
    for (const canonical of this.mapper.map(event)) this.emit(canonical.type, canonical.data, event.time);
    this.lastEventAt = event.time ?? Date.now();
  }

  /** 读一次文件，只处理 frameOffset 之后的新完整帧；半帧留到下一轮。 */
  drain() {
    let buffer;
    try { buffer = fs.readFileSync(this.file); }
    catch (error) { this.onWarn('读取 ' + this.file + ' 失败：' + error.message); return; }
    if (buffer.length < this.frameOffset) {
      this.onWarn('日志长度回退（' + this.frameOffset + ' -> ' + buffer.length + '），按新文件重新扫描');
      this.frameOffset = 0;
    }
    if (buffer.length === this.frameOffset) return;

    const base = this.frameOffset;
    let scan;
    try { scan = scanZstdFrames(buffer.subarray(base)); }
    catch (error) { this.onWarn('帧扫描失败，下一轮重试：' + error.message); return; }

    for (const frame of scan.frames) {
      let text;
      try { text = zlib.zstdDecompressSync(buffer.subarray(base + frame.start, base + frame.end)).toString('utf8'); }
      catch (error) { this.onWarn('frame@' + (base + frame.start) + ' 解压失败，已跳过：' + error.message); continue; }
      for (const line of text.split('\n')) if (line.length > 0) this.handleLine(line);
    }
    if (scan.frames.length > 0) this.frameOffset = base + scan.frames[scan.frames.length - 1].end;

    // 尾部半帧：尽力提前恢复完整行（seq 去重保证下一轮不会重复发）
    if (scan.tornStart !== undefined) {
      try {
        const prefix = zlib.zstdDecompressSync(buffer.subarray(base + scan.tornStart), { finishFlush: zlib.constants.ZSTD_e_flush }).toString('utf8');
        const cut = prefix.lastIndexOf('\n');
        if (cut > 0) for (const line of prefix.slice(0, cut).split('\n')) if (line.length > 0) this.handleLine(line);
      } catch { /* 写入中的半帧，忽略 */ }
    }
    this.lastGrowthAt = Date.now();
  }

  applyHeader(header) {
    if (this.sawHeader) return;
    this.sawHeader = true;
    this.mapper.nativeSessionId = header.id ?? this.mapper.nativeSessionId;
    this.mapper.workspace = header.cwd ?? this.mapper.workspace;
    // 契约 v1.2 §3.1：startedAt 必填（工作框计时起点）——DSH 的权威来源是日志首行 createdAt
    const startedAt = typeof header.createdAt === 'number' ? header.createdAt : Date.now();
    this.sessionStartedAt = startedAt;
    this.emit('session.start', {
      nativeSessionId: header.id ?? null,
      startedAt,
      workspace: header.cwd ?? null,
      agentName: 'DSH',
      agentVersion: this.mapper.agent.version ?? null,
      title: null,
    }, startedAt);
    this.lastEventAt = header.createdAt ?? Date.now();
  }

  start() {
    this.drain();
    if (!this.follow) return;
    this.timer = setInterval(() => {
      this.drain();
      if (this.idleEndMs > 0 && Date.now() - this.lastGrowthAt > this.idleEndMs) this.finish('unknown');
    }, this.pollMs);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastEventAt >= HEARTBEAT_MS) {
        // §3.1：nativeSessionId 可为 null、load 缺省 0；§2.4：后端级事件 sessionId = "backend"
        this.emit('pet.heartbeat', {
          nativeSessionId: this.mapper.nativeSessionId ?? null,
          load: 0,
          sessionCount: this.mapper.nativeSessionId === null ? 0 : 1,
        }, Date.now(), BACKEND_SESSION_ID);
      }
    }, HEARTBEAT_MS);
  }

  finish(reason) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    // 契约 v1.2 §3.1：endedAt 必填（工作框结束计时并归档卡片）
    const endedAt = Date.now();
    const startedAt = this.sessionStartedAt ?? (this.lastEventAt > 0 ? this.lastEventAt : endedAt);
    this.emit('session.end', {
      nativeSessionId: this.mapper.nativeSessionId,
      endedAt,
      reason,
      durationMs: Math.max(0, endedAt - startedAt),
      summary: null,
    }, endedAt);
    this.sink.close();
    this.onWarn('未知原生事件类型统计（已忽略并计数）：' + JSON.stringify(Object.fromEntries(this.mapper.unknownTypes)));
  }
}

// ---------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------

const HELP = [
  '用法: node adapters/_reference/dsh-log-tail.mjs [选项]',
  '',
  '  --list                 列出所有 DSH 会话日志（最新在前）',
  '  --latest               选择最新的会话日志',
  '  --session <id>         选择指定原生会话 id（或目录名）',
  '  --file <path>          直接指定日志文件',
  '  --follow               持续跟随追加写入（缺省只回放一次）',
  '  --socket <path>        输出到 Unix domain socket（缺省 stdout）',
  '  --sessions-root <dir>  覆盖会话根目录（缺省 $DSH_SESSIONS_ROOT 或 ~/.dsh/sessions）',
  '  --poll-ms <n>          跟随轮询间隔，缺省 150',
  '  --idle-end-ms <n>      空闲超过 n ms 就补一条 session.end(unknown)；0 = 关闭（缺省）',
  '  --self-check           用合成帧自检扫描器（多帧 / 追加 / 半帧）与基础映射',
  '  -h, --help             本帮助',
  '',
].join('\n');

function parseArgv(argv) {
  const out = { follow: false, pollMs: 150, idleEndMs: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (a === '--list') out.list = true;
    else if (a === '--latest') out.latest = true;
    else if (a === '--follow') out.follow = true;
    else if (a === '--self-check') out.selfCheck = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--file') out.file = next();
    else if (a === '--session') out.session = next();
    else if (a === '--socket') out.socket = next();
    else if (a === '--sessions-root') out.root = next();
    else if (a === '--poll-ms') out.pollMs = Number(next());
    else if (a === '--idle-end-ms') out.idleEndMs = Number(next());
    else throw new Error('未知参数 ' + a);
  }
  return out;
}

function pickLog(argv, logs) {
  if (argv.file !== undefined) return path.resolve(argv.file);
  if (logs.length === 0) throw new Error('在 ' + (argv.root ?? sessionsRoot()) + ' 下没有找到任何 session*.jsonl.zstd');
  if (argv.session !== undefined) {
    const wanted = [argv.session, 'session-' + argv.session, 'session-' + escapeSessionId(argv.session)];
    const hit = logs.find((s) => s.nativeSessionId === argv.session || wanted.includes(s.sessionDirName));
    if (hit === undefined) throw new Error('找不到会话 ' + argv.session + '（可用 --list 查看）');
    return hit.file;
  }
  return logs[0].file; // --latest 或缺省
}

async function selfCheck() {
  const failures = [];
  const lines = [
    '{"type":"turn/start","seq":0,"time":1,"data":{"turn":1}}',
    '{"type":"step/start","seq":1,"time":2,"data":{"turn":1,"step":1}}',
    '{"type":"tool/call","seq":2,"time":3,"data":{"turn":1,"step":1,"callId":"c1","name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}',
    '{"type":"tool/result","seq":3,"time":4,"data":{"turn":1,"step":1,"message":{"role":"tool","toolCallId":"c1","content":[{"type":"text","text":"ok"}]}}}',
    '{"type":"step/end","seq":4,"time":5,"data":{"turn":1,"step":1}}',
    '{"type":"turn/end","seq":5,"time":6,"data":{"turn":1,"reason":{"kind":"completed"}}}',
  ];
  const frames = lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }));
  const concat = Buffer.concat(frames);
  const one = decodeContainer(concat);
  if (one.lines.length !== lines.length) failures.push('多帧拼接应解出 ' + lines.length + ' 行，实为 ' + one.lines.length);

  const appended = Buffer.concat([concat, frames[0]]);
  if (decodeContainer(appended).lines.length !== lines.length + 1) failures.push('追加第 7 帧后应解出 ' + (lines.length + 1) + ' 行');

  const torn = Buffer.concat([concat, frames[1].subarray(0, Math.max(1, Math.floor(frames[1].length / 2)))]);
  const tornResult = decodeContainer(torn);
  if (tornResult.frames !== frames.length) failures.push('半帧不应被算作完整帧，实为 ' + tornResult.frames);
  if (tornResult.tornStart === undefined) failures.push('半帧尾部应报告 tornStart');

  const mapper = new DshEventMapper({ nativeSessionId: 'self', workspace: '/tmp' });
  const seen = new Set();
  for (const line of one.lines) for (const c of mapper.map(JSON.parse(line))) seen.add(c.type);
  for (const want of ['turn.start', 'step.start', 'tool.call', 'tool.result', 'step.end', 'turn.end', 'agent.status']) {
    if (!seen.has(want)) failures.push('映射器缺少 ' + want);
  }

  if (failures.length > 0) { console.error('self-check FAILED:\n - ' + failures.join('\n - ')); return 1; }
  console.log('self-check OK：多帧 / 追加 / 半帧 / 基础映射 全部通过');
  return 0;
}

async function main() {
  let argv;
  try { argv = parseArgv(process.argv.slice(2)); }
  catch (error) { console.error('[dsh-log-tail] ' + error.message + '\n\n' + HELP); process.exit(2); }
  if (argv.help) { process.stdout.write(HELP); return; }
  if (argv.selfCheck) process.exit(await selfCheck());

  let logs;
  try { logs = listSessionLogs(argv.root ?? sessionsRoot()); }
  catch (error) { console.error('[dsh-log-tail] ' + error.message); process.exit(1); }
  if (argv.list) {
    for (const s of logs) {
      console.log([new Date(s.mtimeMs).toISOString(), String(s.bytes).padStart(9), 'v' + s.version, s.nativeSessionId, s.file].join('  '));
    }
    if (logs.length === 0) console.error('[dsh-log-tail] 未找到任何会话日志');
    return;
  }

  let file;
  try { file = pickLog(argv, logs); }
  catch (error) { console.error('[dsh-log-tail] ' + error.message); process.exit(1); }

  const sink = makeSink(argv);
  const warn = (m) => process.stderr.write('[dsh-log-tail] ' + m + '\n');
  const adapter = new DshLogAdapter({
    file,
    sink,
    follow: argv.follow,
    pollMs: argv.pollMs,
    idleEndMs: argv.idleEndMs,
    onWarn: warn,
    mapper: new DshEventMapper({
      nativeSessionId: path.basename(path.dirname(file)).replace(/^session-/, ''),
      workspace: null,
      agentVersion: process.env.DSH_VERSION ?? '0.2.0-rc.2',
    }),
  });
  // 契约 v1.2 §5.1 单实例锁 + §5.2 握手（socket 模式）；stdout 模式无 ack 通道（仅供回放/调试）
  let instanceLock = null;
  if (sink instanceof SocketSink) {
    try { instanceLock = acquireInstanceLock(argv.socket, { onWarn: warn }); }
    catch (error) { warn(error.message); process.exit(1); }
    warn('已获取单实例锁 ' + instanceLock.lockPath);
    process.on('exit', () => instanceLock?.release());
  }
  if (sink instanceof SocketSink) {
    const ack = await sink.handshake();
    if (ack === null) { warn('Hub 未回 ack（3 s x 3 次），按契约 §5.2 停止发送事件并退出'); process.exit(1); }
    if (ack.ok !== true) { warn('Hub 拒绝契约（' + String(ack.error ?? 'unknown') + '），按契约 §5.2 停止发送事件并退出'); process.exit(1); }
    warn('握手成功：contract=' + String(ack.contract) + ' heartbeatMs=' + String(ack.heartbeatMs ?? HEARTBEAT_MS) + ' canDecide=' + String(ack.canDecide ?? false));
  }
  warn('读取 ' + file + (argv.follow ? '（跟随模式）' : '（一次性回放）'));
  try { adapter.start(); }
  catch (error) { warn('启动失败：' + error.message); process.exit(1); }
  if (!argv.follow) { adapter.finish('done'); return; }
  process.on('SIGINT', () => { warn('收到 SIGINT，退出'); adapter.finish('aborted'); process.exit(0); });
  process.on('uncaughtException', (error) => { warn('未捕获异常（已兜住，不崩）：' + (error?.stack ?? error)); });
}

if (process.argv[1] && process.argv[1].endsWith('dsh-log-tail.mjs')) main();

