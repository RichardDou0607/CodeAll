#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const binary = require('node:path').basename(process.argv[1]);
if (binary === 'codex' && args.join(' ') === 'debug models') {
  process.stdout.write(fs.readFileSync(process.env.MOCK_CODEX_MODELS_FILE, 'utf8'));
  process.exit(0);
}
if (binary === 'kimi' && args.join(' ') === 'provider list --json') {
  process.stdout.write(fs.readFileSync(process.env.MOCK_KIMI_MODELS_FILE, 'utf8'));
  process.exit(0);
}
fs.appendFileSync(process.env.MOCK_CLI_CALLS, JSON.stringify({
  binary,
  args,
  reasoning: process.env.KIMI_MODEL_THINKING_EFFORT || '',
}) + '\n');
// 测试用可控模式（demo/test-crash-window.mjs）：hang=挂住制造执行中崩溃窗口；early-fail=立即非零退出
const mode = process.env.MOCK_CLI_MODE || '';
if (mode === 'early-fail') { process.stderr.write('Not logged in (mock)\n'); process.exit(1); }
setTimeout(() => process.exit(0), mode === 'hang' ? 60000 : 3000);
