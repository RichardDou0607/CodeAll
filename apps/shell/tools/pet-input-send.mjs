#!/usr/bin/env node
// apps/shell/tools/pet-input-send.mjs
// 把 stdin 的文本投递到 DSH 会话（经 plugins/dsh-pet 暴露的 Unix socket）。
// demo/framed.mjs 通过 PET_INPUT_CMD 调用它：stdin 进来的是悬浮窗输入框的原文。
//
// 用法：echo "帮我看一下测试" | node apps/shell/tools/pet-input-send.mjs [sessionId]
// 环境：PET_DSH_SOCK 覆盖 socket 路径（默认 ${TMPDIR}/agent-pet/dsh-plugin.sock）
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SOCK = process.env.PET_DSH_SOCK
  || path.join(process.env.TMPDIR || os.tmpdir(), 'agent-pet', 'dsh-plugin.sock');
const sessionId = process.argv[2] || process.env.PET_DSH_SESSION || undefined;

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const text = Buffer.concat(chunks).toString('utf8').trim();
if (!text) { console.error('pet-input-send: 空输入，忽略'); process.exit(2); }

const body = JSON.stringify(sessionId ? { text, sessionId } : { text });
const req = http.request(
  {
    socketPath: SOCK,
    path: '/input',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  },
  function (res) {
    let out = '';
    res.on('data', function (d) { out += d; });
    res.on('end', function () {
      process.stdout.write(out.charAt(out.length - 1) === '\n' ? out : out + '\n');
      let ok = false;
      try { ok = JSON.parse(out).ok === true; } catch (e) {}
      process.exit(ok ? 0 : 1);
    });
  },
);
req.on('error', function (e) {
  console.error('pet-input-send: 投递失败 ' + e.message + ' · socket=' + SOCK
    + '（插件未挂载？见 docs/54-dsh-plugin.md）');
  process.exit(3);
});
req.end(body);
