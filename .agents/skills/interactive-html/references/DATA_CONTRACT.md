# 数据契约

生成器接受 UTF-8 JSON。根字段为 `meta`、可选 `summary` 和必需的 `views`。所有文本可以是中文或英文；除非特别说明，字段为可选。

## 根结构

```json
{
  "meta": {
    "project": "项目名称（必填）",
    "title": "页面主标题，默认“项目名称 · 交互观测台”",
    "description": "页面说明",
    "version": "当前版本",
    "baseline": "分支、commit 或数据基线",
    "snapshot": "数据快照日期或时间",
    "sourceLabel": "数据来源说明",
    "accent": "lime | teal | blue | amber | violet",
    "demo": true
  },
  "summary": [
    { "label": "指标名", "value": "显示值", "note": "补充说明", "tone": "teal" }
  ],
  "views": []
}
```

`demo: true` 会明确显示“合成示例”，适合演示，不应出现在真实项目交付中。`summary.tone` 可为 `accent`、`teal`、`blue`、`amber` 或省略。

每个 view 都必须包含：

```json
{
  "id": "kebab-case-id",
  "label": "导航短名称",
  "title": "视图标题",
  "description": "视图说明",
  "type": "cards | metrics | timeline | tasks | table",
  "items": []
}
```

view ID 必须匹配 `^[a-z][a-z0-9-]*$` 且不可重复。所有需要定位的 item ID 在同一视图内唯一，并使用相同格式。

## cards

用于模块、架构和能力卡片。

```json
{
  "id": "api",
  "title": "API 服务",
  "subtitle": "Node.js",
  "description": "职责说明",
  "status": "运行中",
  "path": "src/server.ts",
  "tags": ["HTTP", "本地"],
  "facts": ["职责一", "职责二"],
  "fields": [{ "label": "入口", "value": "src/server.ts" }]
}
```

`path` 显示为可复制路径。`facts` 放在可展开详情中。

## metrics

用于优化前后或两组数值比较。

```json
{
  "id": "cpu",
  "name": "空闲 CPU",
  "before": 1080,
  "after": 190,
  "unit": "ms / min",
  "format": "number",
  "delta": "−82.4%",
  "note": "同口径、同窗口实测"
}
```

`before` / `after` 必须为有限非负数值。`format` 可为 `number`（默认）或 `bytes`。`delta` 不应由页面自动推断；需要显示时提供有证据的值。比例条只表达同一指标的 before / after 关系，不表达整体任务完成率。

## timeline

用于版本、里程碑或阶段演进。

```json
{
  "id": "v0-2-0",
  "title": "v0.2.0",
  "date": "2026-10-01",
  "status": "开发中",
  "summary": "本版范围",
  "previous": "v0.1.0",
  "upgrades": ["相比上一版的提升一", "提升二"],
  "can": ["实际具备的能力"],
  "cannot": ["不支持或不承诺的能力"],
  "note": "验收、降级或发布边界"
}
```

`previous`、`upgrades`、`can`、`cannot` 均可省略，但真实版本对比建议提供。规划中的条目应在 `status`、`summary` 或提升项中明确标注。

## tasks

用于当前开发进度。

```json
{
  "id": "w05",
  "title": "桌面端验收",
  "status": "blocked",
  "summary": "当前状态与证据",
  "remaining": "剩余工作",
  "evidence": "qa/acceptance.md"
}
```

允许的 `status`：

- `done`：已完成。
- `in_progress`：进行中。
- `blocked`：阻塞。
- `pending`：待启动。

`tasks` 视图还支持两个可选数组，与 `items` 同级：

```json
{
  "blockers": [{ "title": "当前阻塞", "detail": "原因与影响" }],
  "next": [{ "title": "下一步", "detail": "建议顺序与完成条件" }]
}
```

完成度只按 `done / items.length` 计算，并明确标为“任务项完成度”，不是代码量或整体工作量百分比。

## table

`columns` 必需，定义键和显示名；`items` 的每个对象按 key 提供值。

```json
{
  "columns": [
    { "key": "platform", "label": "平台" },
    { "key": "state", "label": "状态" }
  ],
  "items": [
    { "id": "macos", "platform": "macOS", "state": "已发布" }
  ],
  "caption": "表格说明"
}
```

表格值可以是字符串、数字、布尔值或字符串数组。对象应先在 JSON 编写阶段转换为可读文本，避免无意义的 `[object Object]`。

## 生成与安全边界

- 不写入未经证实的数字或状态；使用“未知 / 待验证 / 计划 / 估算 / 合成示例”等明确标签。
- 不读取或输出凭证、token、隐私文件内容。
- 默认不覆盖输出文件，只有显式 `--force` 才覆盖。
- 输出是静态快照。需要实时数据时，应由项目另行生成新的 JSON 快照并重新运行生成器，不把静态页面描述成实时监控。
