#!/usr/bin/env node
/**
 * 极简规范事件校验器（无第三方依赖）。
 *
 * 用法：
 *   node schema/validate-pet-event.mjs <events.pet.jsonl> [schema/pet-event.schema.json]
 *   node schema/validate-pet-event.mjs --self-test
 *
 * 行为：
 *   - 逐行解析 JSONL；已知 type（契约 §3 的 16 个 type）按 schema/pet-event.schema.json 校验。
 *   - 未知 type 不报错，计入 unknownEvents 并丢弃（契约 §1.5 / §7.3）。
 *   - 退出码：0 = 没有已知事件校验失败；1 = 存在失败行或文件不可读。
 *
 * 说明：本脚本实现的是 json-schema 2020-12 的**子集**，只覆盖 schema/pet-event.schema.json
 * 实际用到的关键字（$ref/$defs/oneOf/allOf/type/const/enum/required/properties/
 * additionalProperties/items/minimum/maximum/minLength/maxLength/not）。
 * 需要完整语义时请用 ajv：
 *   node -e "const Ajv=require('/Users/<you>/.dsh/profiles/node_modules/ajv/dist/2020'); \
 *     const v=new Ajv().compile(require('./schema/pet-event.schema.json')); ..."
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = path.join(HERE, 'pet-event.schema.json');

export const KNOWN_TYPES = new Set([
  'session.start', 'session.end', 'pet.heartbeat',
  'turn.start', 'turn.end', 'step.start', 'step.end', 'message.assistant',
  'tool.call', 'tool.result', 'approval.request', 'approval.resolved',
  'user.question', 'user.answer', 'agent.status', 'error.raised',
]);

/** 契约 §2.2 控制帧：没有 type，用 ctl 判别（消费方必须先判 ctl 再判 type）。 */
export const CONTROL_KINDS = new Set(['hello', 'ack', 'decide', 'snapshot']);
export const RESERVED_BACKEND_SESSION = 'backend';

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error('unsupported $ref: ' + ref);
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error('unresolvable $ref: ' + ref);
  }
  return node;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function check(schema, value, root, at, errors) {
  if (schema === true || schema === undefined) return true;
  if (schema.$ref !== undefined) return check(resolveRef(root, schema.$ref), value, root, at, errors);
  const before = errors.length;

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(at + ': 期望常量 ' + JSON.stringify(schema.const));
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(at + ': 取值不在 enum ' + JSON.stringify(schema.enum));
  }
  if (schema.not !== undefined && check(schema.not, value, root, at, [])) {
    errors.push(at + ': 命中了 not 分支');
  }
  if (schema.type !== undefined) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    const got = typeOf(value);
    const okType = want.some((w) => w === got || (w === 'number' && got === 'integer'));
    if (!okType) {
      errors.push(at + ': 类型应为 ' + want.join('|') + '，实为 ' + got);
      return false;
    }
  }
  if (schema.oneOf !== undefined) {
    const passing = schema.oneOf.filter((sub) => check(sub, value, root, at, []));
    if (passing.length !== 1) errors.push(at + ': oneOf 命中 ' + passing.length + ' 个分支（应为 1）');
  }
  if (schema.allOf !== undefined) for (const sub of schema.allOf) check(sub, value, root, at, errors);
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    errors.push(at + ': 长度小于 minLength ' + schema.minLength);
  }
  if (schema.maxLength !== undefined && typeof value === 'string' && value.length > schema.maxLength) {
    errors.push(at + ': 长度超过 maxLength ' + schema.maxLength);
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(at + ': 小于 minimum ' + schema.minimum);
  }
  if (schema.maximum !== undefined && typeof value === 'number' && value > schema.maximum) {
    errors.push(at + ': 超过 maximum ' + schema.maximum);
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((v, i) => check(schema.items, v, root, at + '[' + i + ']', errors));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(at + ': 缺少必填字段 ' + key);
    }
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(at + ': 出现未声明字段 ' + key);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) check(sub, value[key], root, at + '.' + key, errors);
    }
  }
  return errors.length === before;
}

export function validateEvent(schema, event) {
  const errors = [];
  const valid = check(schema, event, schema, '$', errors);
  return { valid, errors };
}

function selfTest(schema) {
  const sample = (type, data) => ({
    v: 1, seq: 0, ts: Date.now(), source: 'dsh', sessionId: 's', workspace: '/tmp',
    agent: { name: 'DSH', version: '0.2.0-rc.2' }, type, data,
  });
  const cases = [
    ['session.start', { nativeSessionId: 's', startedAt: 1, workspace: '/tmp', agentName: 'DSH', agentVersion: null }],
    ['session.end', { nativeSessionId: 's', endedAt: 2, reason: 'done', durationMs: 1 }],
    ['pet.heartbeat', { nativeSessionId: null, load: 0, sessionCount: 1 }],
    ['turn.start', { turnId: 't1', inputKind: 'user' }],
    ['turn.end', { turnId: 't1', status: 'ok', durationMs: 1 }],
    ['step.start', { turnId: 't1', stepId: 't1/step-1', index: 1 }],
    ['step.end', { turnId: 't1', stepId: 't1/step-1', index: 1, status: 'ok' }],
    ['message.assistant', { turnId: 't1', text: 'hi', truncated: false }],
    ['tool.call', { callId: 'c1', toolName: 'bash', category: 'exec', risk: 1, summary: 'ls' }],
    ['tool.result', { callId: 'c1', status: 'ok' }],
    ['approval.request', { requestId: 'r1', kind: 'command', summary: 'run ls', risk: 2, callId: 'c1', expiresAt: null }],
    ['approval.resolved', { requestId: 'r1', decision: 'allow', latencyMs: 10 }],
    ['user.question', { questionId: 'q1', text: '继续？' }],
    ['user.answer', { questionId: 'q1', choice: '继续', custom: null }],
    ['agent.status', { state: 'working', detail: null, force: false }],
    ['error.raised', { scope: 'tool', message: 'boom', fatal: false, code: null }],
  ];
  // §2.2 控制帧：必须先判 ctl，且不能被当成非法事件
  const controlCases = [
    { ctl: 'hello', contract: 1, source: 'dsh', adapterVersion: '0.1.0', resumeAfter: null },
    { ctl: 'ack', contract: 1, ok: true, heartbeatMs: 15000, canDecide: false },
    { ctl: 'snapshot', contract: 1, ts: 1, agg: 'waiting',
      sessions: [{ source: 'dsh', sessionId: 's', state: 'waiting', since: 1, title: 't', workspace: '/x', lastTool: 'npm test', elapsedMs: 21000, pending: 1 }],
      degradedSources: [], clearedPending: [{ kind: 'approval', requestId: 'r1', clearedAt: 1, reason: 'stale' }],
      now: { turnId: 't-9', stepIndex: 3, startedAt: 1, elapsedMs: 21000, lastTool: 'npm test' },
      counters: { unknownEvents: 0, lateEvents: 0, duplicates: 0, orphanApprovals: 0, overrideRejected: 0, recoveredErrors: 0, escalatedErrors: 0, stale: 0 },
      bubble: { kind: 'approval', text: 'x', requestId: 'r1' }, effect: 'alert', unknownEvents: 0, offlineSources: [] },
    { ctl: 'decide', requestId: 'r1', decision: 'allow' },
  ];
  // v1.2 负例：这些必须被判为**非法**，否则 schema 又会产生假阴性
  const negativeCases = [
    ['session.start 缺 startedAt', sample('session.start', { nativeSessionId: 's' })],
    ['session.end 缺 endedAt', sample('session.end', { nativeSessionId: 's', reason: 'done' })],
    ['session.end reason 非法枚举', sample('session.end', { nativeSessionId: 's', endedAt: 1, reason: 'finished' })],
    ['tool.call 缺 callId', sample('tool.call', { toolName: 'bash', category: 'exec', risk: 1 })],
    ['approval.request 缺 requestId', sample('approval.request', { kind: 'command', summary: 'x', risk: 1 })],
    ['agent.status state=done（v1.2 不允许）', sample('agent.status', { state: 'done' })],
    ['事件信封缺 data', { v: 1, seq: 0, ts: 1, source: 'dsh', sessionId: 's', workspace: null, type: 'turn.start' }],
    ['未知字段（additionalProperties=false）', sample('turn.start', { turnId: 't', inputKind: 'user', bogus: 1 })],
  ];
  const negativeControl = [
    ['ctl:snapshot 缺 contract', schema.$defs.controlFrame, { ctl: 'snapshot', ts: 1, agg: 'waiting', sessions: [] }],
    ['ctl:ack 缺 ok', schema.$defs.controlFrame, { ctl: 'ack', contract: 1 }],
  ];
  let failures = 0;
  for (const [type, data] of cases) {
    const { valid, errors } = validateEvent(schema, sample(type, data));
    if (!valid) { failures += 1; console.error('SELFTEST FAIL ' + type + ': ' + errors.join('; ')); }
  }
  for (const frame of controlCases) {
    const branch = schema.$defs.controlFrame;
    const { valid, errors } = validateEvent(branch, frame);
    if (!valid) { failures += 1; console.error('SELFTEST FAIL ctl:' + frame.ctl + ': ' + errors.join('; ')); }
    if (!CONTROL_KINDS.has(frame.ctl)) { failures += 1; console.error('SELFTEST FAIL: ' + frame.ctl + ' 不在 CONTROL_KINDS'); }
  }
  for (const [label, event] of negativeCases) {
    const { valid } = validateEvent(schema, event);
    if (valid) { failures += 1; console.error('SELFTEST FAIL（假阴性）: ' + label + ' 本应非法，schema 却判合法'); }
  }
  for (const [label, branch, frame] of negativeControl) {
    const { valid } = validateEvent(branch, frame);
    if (valid) { failures += 1; console.error('SELFTEST FAIL（假阴性）: ' + label + ' 本应非法，schema 却判合法'); }
  }
  // 未知 type 必须不被 KNOWN_TYPES 认领
  if (KNOWN_TYPES.has('x-unknown.foo')) { failures += 1; console.error('SELFTEST FAIL: x-unknown.foo 被当成已知 type'); }
  const positives = cases.length + controlCases.length;
  const negatives = negativeCases.length + negativeControl.length;
  console.log(failures === 0
    ? 'self-test OK (' + cases.length + ' 个事件 type + ' + controlCases.length + ' 种控制帧通过；' + negatives + ' 个负例全部被正确拒绝；契约 v1.2)'
    : 'self-test FAILED: ' + failures);
  void positives;
  return failures === 0;
}

function main() {
  const args = process.argv.slice(2);
  const schemaPath = args[1] ?? DEFAULT_SCHEMA;
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(args[0] === '--self-test' ? DEFAULT_SCHEMA : schemaPath, 'utf8'));
  } catch (error) {
    console.error('无法读取 schema ' + schemaPath + ': ' + error.message);
    process.exit(2);
  }
  if (args[0] === '--self-test') process.exit(selfTest(schema) ? 0 : 1);
  const file = args[0];
  if (file === undefined) {
    console.error('用法: node schema/validate-pet-event.mjs <events.pet.jsonl> [schema.json] | --self-test');
    process.exit(2);
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { console.error('无法读取 ' + file + ': ' + error.message); process.exit(2); }

  let known = 0, controls = 0, unknown = 0, malformed = 0, invalid = 0;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    let event;
    try { event = JSON.parse(line); }
    catch (error) { malformed += 1; console.error('第 ' + (i + 1) + ' 行不是合法 JSON: ' + error.message); return; }
    // 契约 §5.2.5：先判 ctl，再判 type
    if (event.ctl !== undefined) {
      const { valid, errors } = validateEvent(schema.$defs.controlFrame, event);
      if (valid) controls += 1;
      else { invalid += 1; console.error('第 ' + (i + 1) + ' 行 [ctl:' + event.ctl + '] 校验失败: ' + errors.join('; ')); }
      return;
    }
    if (!KNOWN_TYPES.has(event.type)) { unknown += 1; return; }
    const { valid, errors } = validateEvent(schema, event);
    if (valid) known += 1;
    else { invalid += 1; console.error('第 ' + (i + 1) + ' 行 [' + event.type + '] 校验失败: ' + errors.join('; ')); }
  });
  console.log(JSON.stringify({ file, knownValid: known, controlFrames: controls, unknownTypes: unknown, malformedLines: malformed, invalidKnown: invalid }));
  process.exit(invalid === 0 && malformed === 0 ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('validate-pet-event.mjs')) main();
