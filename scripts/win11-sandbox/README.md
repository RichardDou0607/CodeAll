# Win11 沙箱环境脚本

远端 Windows 11 验证机（`ssh win11` 免密直达，Tailscale 组网）的接入层。背景、连接方式、
坑与验收记录见 [docs/36-win11-sandbox.md](../../docs/36-win11-sandbox.md)。

```bash
node scripts/win11-sandbox/check.mjs     # 体检：连接/系统/工具链/Agent CLI 矩阵
./scripts/win11-sandbox/sync.sh          # 源码同步到 C:\Users\admin\codeall（tar over ssh，~3MB）
./scripts/win11-sandbox/exec.sh "node --version"          # 工作区里跑命令（cmd）
./scripts/win11-sandbox/exec.sh --ps "Get-Location"       # 同上，走 PowerShell（中文不乱码）
./scripts/win11-sandbox/service.sh start | status | stop | log   # 沙箱上的本地服务管理
```

环境变量：`WIN11_HOST`（默认 `win11`）、`WIN11_DEST`（默认 `C:\Users\admin\codeall`）、
`WIN11_PORT`（默认 `7799`）。
