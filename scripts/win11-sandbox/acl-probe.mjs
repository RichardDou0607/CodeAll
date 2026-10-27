import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const p = promisify(execFile);
const PIPE = '\\\\.\\pipe\\agent-pet-dsh-plugin';
const server = net.createServer(() => {});
await new Promise((res) => server.listen(PIPE, res));
console.log('pipe listening');
try {
  const { stdout } = await p('powershell.exe', ['-NoProfile', '-File', 'C:\\Users\\admin\\codeall\\scripts\\acl-probe.ps1'], { timeout: 15000 });
  console.log(stdout.trim());
} catch (e) {
  console.log('stdout:', String(e.stdout || '').trim().slice(0, 300));
  console.log('stderr:', String(e.stderr || '').trim().slice(0, 300));
}
server.close();
