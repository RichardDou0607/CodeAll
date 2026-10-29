# Interactive HTML Skill

把任意项目的结构化数据生成一个可直接打开的交互式 HTML 页面。单文件输出，无框架、无 CDN、无后端、无运行时依赖。

## 下载与安装

压缩包解压后会得到 `interactive-html/` 目录。

- **作为 Agent Skill**：把整个目录放到你的 Agent 所使用的 skills 目录。本仓库使用 `.agents/skills/`；其他宿主按各自 Skill 加载目录安装。然后请求“使用 interactive-html 为当前项目创建交互式 HTML 页面”。
- **只使用命令行**：无需安装 Agent 或依赖，保留 `scripts/` 与 `assets/` 的相对位置即可运行。

## 直接生成

需要 Node.js 18 或更高版本。

```bash
node interactive-html/scripts/generate.mjs \
  --input interactive-html/examples/project.json \
  --output ./observatory.html
```

打开结果：

- macOS：`open observatory.html`
- Windows：`start observatory.html`
- Linux：`xdg-open observatory.html`

默认不覆盖已有文件；确认要重新生成同一文件时添加 `--force`。

## 支持的内容

- `cards`：架构、模块、能力卡片与详情。
- `metrics`：优化前后数值和比例条。
- `timeline`：版本演进、上一版提升、能力边界与选择交互。
- `tasks`：任务状态、阻塞、下一步、筛选和原生进度条。
- `table`：任意语义化表格，窄屏自动转为卡片。

所有视图支持 hash 导航和全局搜索；页面还支持深浅色主题、键盘操作、减少动画偏好和响应式布局。

## 文件说明

- `SKILL.md`：Agent 调用流程。
- `references/DATA_CONTRACT.md`：JSON 数据契约。
- `assets/template.html`：通用页面模板。
- `scripts/generate.mjs`：数据校验与生成器。
- `scripts/test.mjs`：无依赖自测。
- `examples/project.json`：覆盖五种视图的合成示例。
- `examples/observatory.html`：由示例数据生成的页面。

## 自测

```bash
node interactive-html/scripts/test.mjs
```

生成器只负责数据与脚本检查；交付实际项目页面时仍应在浏览器中验证视图、筛选、搜索、主题和移动端交互。静态 JSON 不等于实时数据，规划项、估算值和未知状态应如实标注。
