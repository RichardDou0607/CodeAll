#!/usr/bin/env node
// Isolated CLI spawn test: arguments and environment only, no real Agent input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-cli-create-'));
const binDir = path.join(home, 'bin');
fs.mkdirSync(binDir);
for (const name of ['claude', 'codex', 'kimi']) {
  const bin = path.join(binDir, name);
  fs.copyFileSync(fileURLToPath(new URL('./mock-cli-create.cjs', import.meta.url)), bin);
  fs.chmodSync(bin, 0o755);
}
const tmuxBin = path.join(binDir, 'tmux');
fs.writeFileSync(tmuxBin, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.MOCK_TMUX_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'list-panes') process.stdout.write('%0\\tcodex\\t' + process.env.MOCK_TMUX_CWD + '\\n');
`);
fs.chmodSync(tmuxBin, 0o755);
const callsFile = path.join(home, 'calls.jsonl');
const tmuxCalls = path.join(home, 'tmux-calls.jsonl');
const control = fileURLToPath(new URL('../adapters/cli-control.mjs', import.meta.url));
try {
  const script = `import { deliverCreateViaCli, deliverControl } from ${JSON.stringify(control)};
    const bad = await deliverCreateViaCli('codex', ${JSON.stringify(home)}, 'hello', 'model', '');
    const results = await Promise.all([
      deliverCreateViaCli('claude-code', ${JSON.stringify(home)}, 'first', 'sonnet', 'xhigh'),
      deliverCreateViaCli('codex', ${JSON.stringify(home)}, 'second', 'gpt-test', 'ultra'),
      deliverCreateViaCli('kimi-code', ${JSON.stringify(home)}, 'third',
        {cliModel:'kimi-code/k3', modelId:'k3', reasoningEfforts:['low','high','max'],canCreate:true}, 'high'),
      deliverCreateViaCli('codex', ${JSON.stringify(home)}, 'fourth', 'gpt-test', 'xhigh')
    ]);
    const targeted = await deliverControl('codex', {sessionId:'target-session', cwd:${JSON.stringify(home)}}, 'targeted');
    console.log(JSON.stringify({bad:bad.error, results:results.map(r=>r.ok), targeted:targeted.ok}));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, PATH: binDir + path.delimiter + process.env.PATH,
      MOCK_CLI_CALLS: callsFile, MOCK_TMUX_CALLS: tmuxCalls, MOCK_TMUX_CWD: home },
    encoding: 'utf8', timeout: 12000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { bad: 'reasoning-required', results: [true, true, true, true], targeted: true });
  const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 5);
  const byName = Object.fromEntries(calls.map(c => [c.binary, c]));
  assert.deepEqual(byName.claude.args, ['--model', 'sonnet', '--effort', 'xhigh', '-p', 'first']);
  assert.deepEqual(calls.find(c => c.args.includes('second')).args, ['exec', '--skip-git-repo-check', '-m', 'gpt-test',
    '-c', 'model_reasoning_effort="ultra"', 'second']);
  assert.ok(calls.find(c => c.args.includes('fourth')).args.includes('model_reasoning_effort="xhigh"'));
  assert.deepEqual(byName.kimi.args, ['-m', 'kimi-code/k3', '-p', 'third']);
  assert.equal(byName.kimi.reasoning, 'high');
  assert.deepEqual(calls.find(c => c.args.includes('targeted')).args,
    ['exec', 'resume', '--skip-git-repo-check', 'target-session', 'targeted']);
  assert.ok(!fs.existsSync(tmuxCalls), '同目录 pane 不能确认 sessionId，不能 send-keys');
  console.log('CLI 新建与定向投递：模型/强度已传递，同目录 tmux 不会误投');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
