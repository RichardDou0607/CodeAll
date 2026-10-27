$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PipeSec {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern uint GetSecurityInfo(IntPtr handle, int objType, uint info, out IntPtr sidOwner, out IntPtr sidGroup, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint rev, uint info, out IntPtr str, out uint len);
}
"@
# GENERIC_READ|GENERIC_WRITE = 0xC0000000, OPEN_EXISTING = 3
$h = [PipeSec]::CreateFileW('\\.\pipe\agent-pet-dsh-plugin', [uint32]3221225472, [uint32]0, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)
if ($h -eq [IntPtr](-1)) { Write-Output ("CreateFile failed err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }
$o=[IntPtr]::Zero; $g=[IntPtr]::Zero; $d=[IntPtr]::Zero; $s=[IntPtr]::Zero; $sd=[IntPtr]::Zero
# SE_KERNEL_OBJECT=6, DACL_SECURITY_INFORMATION=4
$rc = [PipeSec]::GetSecurityInfo($h, 6, 4, [ref]$o, [ref]$g, [ref]$d, [ref]$s, [ref]$sd)
if ($rc -ne 0) { Write-Output ("GetSecurityInfo rc=" + $rc); exit 1 }
$str=[IntPtr]::Zero; $len=[uint32]0
if (-not [PipeSec]::ConvertSecurityDescriptorToStringSecurityDescriptorW($sd, 1, 4, [ref]$str, [ref]$len)) { Write-Output "conv failed"; exit 1 }
Write-Output ("DACL_SDDL: " + [Runtime.InteropServices.Marshal]::PtrToStringUni($str))
Write-Output ("creator: " + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
