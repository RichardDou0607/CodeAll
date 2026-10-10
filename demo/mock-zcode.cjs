#!/usr/bin/env node
// Test-only app-server implementing the small NDJSON surface used by cli-control.
const readline = require('node:readline');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const sessionId = 'sess_mock_create';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!request.method) return;
  const { id, method, params } = request;
  fs.appendFileSync(process.env.MOCK_ZCODE_CALLS, JSON.stringify({ method, params }) + '\n');
  if (method === 'session/create') {
    if (process.env.MOCK_ZCODE_DB) {
      const db = new DatabaseSync(process.env.MOCK_ZCODE_DB);
      try {
        const now = Date.now();
        const workspace = params.workspace?.workspacePath || process.cwd();
        db.prepare('INSERT OR IGNORE INTO session (id, path, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
          .run(sessionId, workspace, 'mock created', 'main', now, now);
      } finally { db.close(); }
    }
    emit({ id, result: { sessionId } });
  }
  else if (method === 'session/resume' || method === 'session/subscribe') emit({ id, result: {} });
  else if (method === 'session/send') {
    if (process.env.MOCK_ZCODE_REJECT === '1' || params.content === 'reject') emit({ id, error: { message: 'mock send rejected' } });
    else {
      emit({ id, result: { accepted: true } });
      emit({ method: 'state.updated', params: { scope: 'session', patch: { status: 'running' } } });
      if (params.content === 'late-fail')
        setTimeout(() => emit({ method: 'session/event', params: { type: 'turn.failed', error: { message: 'mock delayed failure' } } }), 8500);
      else
        setTimeout(() => emit({ method: 'state.updated', params: { scope: 'session', patch: { status: 'idle' } } }), 50);
    }
  } else if (method === 'session/close') emit({ id, result: {} });
});
