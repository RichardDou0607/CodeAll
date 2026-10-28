import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { secureNamedPipe } from '../../plugins/dsh-pet/pipe-acl.mjs';
const p = promisify(execFile);
const PIPE = '\\\\.\\pipe\\agent-pet-dsh-plugin';
const PROBE = fileURLToPath(new URL('./acl-probe.ps1', import.meta.url));
const server = net.createServer(() => {});
await new Promise((res) => server.listen(PIPE, res));
console.log('pipe listening');
await secureNamedPipe(PIPE);
let sddl = '';
try {
  const { stdout } = await p('powershell.exe', ['-NoProfile', '-File', 'C:\\Users\\admin\\codeall\\scripts\\acl-probe.ps1'], { timeout: 15000 });
  sddl = stdout.trim();
  console.log(sddl);
} catch (e) {
  console.log('stdout:', String(e.stdout || '').trim().slice(0, 300));
  console.log('stderr:', String(e.stderr || '').trim().slice(0, 300));
  throw e;
} finally { server.close(); }
const currentSid = sddl.match(/^creatorSid:\s*(\S+)$/m)?.[1];
const aces = (sddl.match(/^DACL_SDDL:\s*(D:P.*)$/m)?.[1].match(/\([^)]+\)/g) || []).sort();
const expected = [`(A;;FA;;;SY)`, `(A;;FA;;;${currentSid})`].sort();
if (!currentSid || JSON.stringify(aces) !== JSON.stringify(expected)) {
  throw new Error('命名管道 DACL 必须受保护，且仅允许 SYSTEM 与当前用户完全控制');
}
