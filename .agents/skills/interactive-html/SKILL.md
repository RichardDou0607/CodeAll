---
name: interactive-html
description: Create standalone, dependency-free interactive HTML pages for any project. Use when the user wants an interactive HTML dashboard, project observatory, architecture cards, before/after metrics, version timeline, task-progress tracker, or a browser-openable project report.
---

# Interactive HTML

Generate one browser-openable HTML file from project evidence and a small JSON document. The output has no runtime, package, CDN, or backend dependency.

## Workflow

### 1. Establish the evidence boundary

Read the project's README, manifests, docs, tests, release notes, and task trackers as relevant. Choose only views that answer the user's request: `cards`, `metrics`, `timeline`, `tasks`, or `table`.

Every displayed fact must be traceable to evidence, explicitly marked as planned / unknown / estimated, or identified as synthetic example data. Use the environment's actual snapshot date. Never invent a metric, completion percentage, release state, or live connection.

Completion: the selected views and every status have an evidence-backed or explicitly labeled meaning.

### 2. Write the project JSON

Read [references/DATA_CONTRACT.md](references/DATA_CONTRACT.md) when creating or editing the JSON. Start from [examples/project.json](examples/project.json) if a complete shape is useful.

Keep secrets out of the JSON. Do not read credential stores, `.env`, tokens, or private keys merely to enrich the page. Record static data as a snapshot; do not describe it as live telemetry.

Completion: the JSON contains `meta.project` and at least one valid view, with unique view and item IDs.

### 3. Generate the HTML

Run:

```bash
node "<skill-dir>/scripts/generate.mjs" --input "<project-data.json>" --output "<observatory.html>"
```

The generator validates the data, escapes script-breaking characters, and refuses to overwrite an existing file. Use `--force` only when replacing the generated file is part of the request.

Completion: the command exits 0 and prints the generated path.

### 4. Verify the deliverable

Run [scripts/test.mjs](scripts/test.mjs) after changing the skill itself. For every generated page, open the actual output in an available browser and exercise:

- every view and hash navigation, including back / forward;
- task filters and timeline item selection when present;
- global search, result navigation, and theme switching;
- a narrow viewport, keyboard focus, and reduced-motion behavior when supported.

The generator checks data shape and JavaScript syntax, but that does not replace browser verification. If no browser is available, state exactly what remains unverified.

Completion: the generated file opens directly, requested interactions work, and no data was silently substituted to make the page look complete.

### 5. Deliver

Give the user the HTML path, the JSON path when useful, and the direct-open command. Mention the snapshot date and any planned, estimated, unknown, or synthetic states. Leave unrelated project files unchanged.

## Reference

- [Data contract](references/DATA_CONTRACT.md)
- [Example input](examples/project.json)
- [Generator](scripts/generate.mjs)
- [Skill self-test](scripts/test.mjs)
