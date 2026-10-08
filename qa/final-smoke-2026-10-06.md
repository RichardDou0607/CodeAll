# 最终烟测 + 回归报告（2026-10-06 深夜 · 手动隐藏版）

## A. 回归套件（9/9 通过，1 项既有失败）

| 套件 | 结果 |
|---|---|
| demo/test-window.mjs（App 界面，含状态独立页/手动隐藏/形态徽标） | ✅ 34 项 |
| demo/test-mini.mjs（迷你条动态单行） | ✅ 11 项 |
| demo/test-html.mjs（终端可视化页） | ✅ |
| scripts/multi-source-check.mjs 静态 | ✅ 31 项 |
| scripts/multi-source-check.mjs --live（真实投递闭环） | ✅ 34 项（MD3/ME3/MH3 三家文件增长） |
| scripts/catalog-check.mjs（DSH 目录） | ✅ 15 项 |
| schema/validate-pet-event.mjs --self-test | ✅ |
| scripts/replay-check.mjs | ✅ |
| adapters/cli-control.mjs --selftest | ✅ 3 CLI 通道 + Terminal 机制 |
| scripts/check-fixtures.mjs | ⚠️ 既有失败（session-replay 乱序断言，改动前基线即失败，与本轮无关；该 fixture 已于 2026-10-08 因隐私移除，现为合成样本全绿） |

## B. 真实投递闭环（--live）

- CLAUDE-CODE ✅ 转录增长 · CODEX ✅ rollout 增长 · KIMI-CODE ✅ wire 增长
- **烟测新抓到的 bug（已修）**：目标会话的 cwd 已被用户删除时，spawn 异步 ENOENT（pid undefined）被误报「已投递」——deliverViaCli 现把 pid 缺失判失败；验收脚本跳过 cwd 失效的会话。

## C. 正式版烟测（/Applications/AgentPet.app，受控启动）

- 外壳日志：WINDOW_SHOWN · REMOTE_COMMITTED[main]+[app]（双窗同屏）· REMOTE_IPC_OK · 单 shell 进程 + 单服务进程
- 端点：/ · /window.html · /api/state · /api/agents · /api/catalog 全部 200（≤4ms）；SSE 首帧正常
- 快照：catalog.source=四源标注；四态 = DSH/Claude/Codex/Kimi 全部已连接（观察通道，静默不算断连）；形态计数 Claude Code{cli:13,desktop:33,ide:4} · Codex{desktop:32} · Kimi{desktop:7,cli:3}；cliChannels 三家
- /api/catalog perSource：dsh 7 项目/29 会话 · claude-code 11/50 · codex 10/13 · kimi-code 4/10
- 浏览器实测：手动隐藏闭环（✕ 隐藏 1 行 → 恢复按钮复原）；软件状态独立页 6 卡；迷你条动态单行 + 形态徽标

## 结论

观察 + 控制 + 双形态 UI 全链路可用；唯一遗留为既有的 session-replay fixture 乱序断言（待重录 fixture）。
