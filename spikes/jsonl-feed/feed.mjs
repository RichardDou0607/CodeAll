#!/usr/bin/env node
// T1 spike · 假适配器（fakes adapter）
// 依据 docs/00-interface-contract.md §2/§3 生成规范事件，经 Unix domain socket 以 JSONL 写入桌宠。
// 用法：
//   node feed.mjs --socket "$TMPDIR/agent-pet/swift-spike.sock" --scenario demo
//   node feed.mjs --socket <sock> --scenario unknown-storm --count 1000
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const o = { socket: "", scenario: "demo", source: "dsh", count: 1000, gap: 700, record: "", wait: 15 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const name = k.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) { o[name] = true; continue; }
    o[name] = /^\d+$/.test(v) ? Number(v) : v;
    i++;
  }
  if (!o.socket) o.socket = path.join(process.env.TMPDIR || "/tmp", "agent-pet", `${o.source}.sock`);
  return o;
}
const opts = parseArgs(process.argv.slice(2));

const petDir = path.parse(opts.socket).dir;
fs.mkdirSync(petDir, { recursive: true });

// 等待 socket 出现（桌宠先起、适配器后连，符合契约 §5）
const deadline = Date.now() + opts.wait * 1000;
while (!fs.existsSync(opts.socket) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200));
}
if (!fs.existsSync(opts.socket)) {
  console.error(`FEED_FAIL socket-not-found ${opts.socket}`);
  process.exit(2);
}

let seq = 0;
const sessionId = "session-spike-0001";
const t0 = Date.now();
const recordPath = opts.record || path.join(petDir, "fed-events.jsonl");
const record = fs.createWriteStream(recordPath, { flags: "w" });

function envelope(type, data) {
  return {
    v: 1, seq: seq++, ts: Date.now(), source: opts.source, sessionId,
    workspace: process.cwd(), agent: { name: "DSH", version: "0.2.0-rc.2" },
    type, data,
  };
}

function demoScript() {
  return [
    ["session.start", { source: opts.source, nativeSessionId: sessionId, workspace: process.cwd(), agentName: "DSH", agentVersion: "0.2.0-rc.2", title: "spike" }],
    ["turn.start", { nativeSessionId: sessionId, turnId: "t1", inputKind: "user" }],
    ["step.start", { turnId: "t1", stepId: "s1", index: 0 }],
    ["tool.call", { toolName: "Bash", callId: "c1", summary: "pnpm test", category: "exec", risk: 1 }],
    ["tool.result", { callId: "c1", status: "ok", durationMs: 1200, summary: "12 passed" }],
    ["approval.request", { callId: "c2", kind: "shell-write", risk: 2, summary: "允许写入 ~/.config ?" }],
    ["approval.resolved", { callId: "c2", decision: "allow", latencyMs: 3400 }],
    ["message.assistant", { turnId: "t1", text: "已完成 spike 验证", truncated: false }],
    ["error.raised", { scope: "tool", code: "E_SPIKE", message: "模拟工具失败", fatal: false }],
    ["turn.end", { nativeSessionId: sessionId, turnId: "t1", status: "ok", durationMs: 8000, summary: "ok" }],
    ["agent.status", { state: "idle", detail: "spike 结束" }],
  ];
}

function unknownScript(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([`future.event.v2.${i % 7}`, { i }]);
  return out;
}

const script = opts.scenario === "unknown-storm" ? unknownScript(opts.count) : demoScript();

const sock = net.createConnection({ path: opts.socket }, () => {
  void (async () => {
    console.log(`FEED_CONNECTED ${opts.socket} scenario=${opts.scenario} events=${script.length}`);
    for (const [type, data] of script) {
      const line = JSON.stringify(envelope(type, data));
      record.write(line + "\n");
      sock.write(line + "\n");
      if (opts.gap > 0) await new Promise((r) => setTimeout(r, opts.gap));
    }
    await new Promise((r) => setTimeout(r, 400));
    sock.end();
    console.log(`FEED_DONE events=${seq} ms=${Date.now() - t0} record=${recordPath}`);
    process.exit(0);
  })();
});
sock.on("error", (e) => { console.error("FEED_SOCKET_ERR", e.message); process.exit(3); });
