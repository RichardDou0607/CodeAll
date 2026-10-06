#!/usr/bin/env node
// 汇总某进程及其所有后代进程的 RSS（MB）。用法：node tree-rss.mjs <pid> [--label X]
import { execSync } from "node:child_process";
const pid = Number(process.argv[2]);
const labelIdx = process.argv.indexOf("--label");
const label = labelIdx > 0 ? process.argv[labelIdx + 1] : String(pid);
if (!pid) { console.error("usage: tree-rss.mjs <pid> [--label X]"); process.exit(2); }
const raw = execSync("ps -ax -o pid=,ppid=,rss=,comm=", { encoding: "utf8" });
const rows = raw.trim().split("\n").map((l) => {
  const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
  return m ? { pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), comm: m[4] } : null;
}).filter(Boolean);
const byParent = new Map();
for (const r of rows) {
  if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
  byParent.get(r.ppid).push(r);
}
const tree = [];
const stack = [pid];
while (stack.length) {
  const cur = stack.pop();
  const node = rows.find((r) => r.pid === cur);
  if (node) tree.push(node);
  for (const child of byParent.get(cur) ?? []) stack.push(child.pid);
}
let total = 0;
for (const n of tree) {
  total += n.rss / 1024;
  console.log("  pid=" + n.pid + " rss=" + (n.rss / 1024).toFixed(1) + "MB proc=" + n.comm.split("/").pop());
}
console.log(label + "_TREE_RSS=" + total.toFixed(1) + "MB processes=" + tree.length);
