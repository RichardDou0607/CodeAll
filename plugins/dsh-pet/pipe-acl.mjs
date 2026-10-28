import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { IS_WIN } from '../../adapters/platform.mjs';

const execFileP = promisify(execFile);

export async function secureNamedPipe(socketPath) {
  if (!IS_WIN) {
    // unix：权限即 ACL 语义——socket 0600（仅属主可连），父目录 0700（拒其他用户进入）。
    // 任一失败都抛错，由调用方「设置失败即关监听」路径兜住（对位 Windows 受保护 DACL 语义）。
    fs.chmodSync(socketPath, 0o600);
    try {
      const dir = path.dirname(socketPath);
      if ((fs.statSync(dir).mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
    } catch { /* 目录属主非本进程时跳过（socket 0600 已挡跨用户连入） */ }
    return;
  }
  const pipe = String(socketPath).replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace CodeAll -Name NativePipeAcl -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativePipeAcl {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint SetNamedSecurityInfo(string name, int objectType, int securityInformation, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
}
'@
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sddl = 'D:P(A;;FA;;;SY)(A;;FA;;;' + $sid + ')'
$sd = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
$bytes = New-Object byte[] $sd.BinaryLength
$sd.DiscretionaryAcl.GetBinaryForm($bytes, 0)
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
try {
  $rc = [CodeAll.NativePipeAcl]::SetNamedSecurityInfo('${pipe}', 6, -2147483644, [IntPtr]::Zero, [IntPtr]::Zero, $ptr, [IntPtr]::Zero)
  if ($rc -ne 0) { throw "SetNamedSecurityInfo=$rc" }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
}
`;
  await execFileP('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
  });
}
