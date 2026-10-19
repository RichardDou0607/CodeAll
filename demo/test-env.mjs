// 隔离测试环境 helper：spawn demo/framed.mjs 的统一 env。
//
// 背景（审查 F4）：framed.mjs 的 DSH 目录扫描经 adapters/session-catalog.mjs:29-31
// 优先读 process.env.DSH_HOME / DSH_SESSIONS / DSH_WORKSPACES——若测试只覆盖 HOME，
// 在 DSH 会话（本机 Agent 环境自带 DSH_HOME 等变量）里跑测试时，子服务会去跟随/扫描
// **真实用户的 ~/.dsh**：合成语料被忽略、证据受污染，且有隐私边界问题。
// 因此所有 spawn framed 的隔离测试都必须用 isolatedEnv() 构造环境：
//   · DSH_HOME / DSH_SESSIONS / DSH_WORKSPACES 显式指向临时 home；
//   · 删除宿主注入的会话/配置变量（DSH_SESSION_ID / DSH_PROFILE / DSH_PROFILE_DIR /
//     DSH_WEB_URL / DSH_SHELL），避免把当前 DSH 会话身份带进被测服务；
//   · HOME 指向临时 home，TMPDIR 指向其下 tmp/（子服务的临时写也落在隔离域内），
//     其余宿主 env（PATH 等）保留，extra 最后覆盖。
// 2026-10-18 审查 S2：scripts/perf-{baseline,verify}.mjs 原各有一份同形实现，收敛到本文件导出。
import fs from 'node:fs';
import path from 'node:path';

const DSH_SESSION_KEYS = ['DSH_SESSION_ID', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL', 'DSH_SHELL'];

/** @param {string} home 临时 HOME（mkdtemp 产物） @param {Record<string,string>} [extra] 额外/覆盖变量 */
export function isolatedEnv(home, extra = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('isolatedEnv: home 必须是绝对路径');
  const tmp = path.join(home, 'tmp');
  try { fs.mkdirSync(tmp, { recursive: true }); } catch { /* 已存在 */ }
  const env = { ...process.env };
  for (const key of DSH_SESSION_KEYS) delete env[key];
  env.HOME = home;
  env.TMPDIR = tmp;
  env.DSH_HOME = path.join(home, '.dsh');
  env.DSH_SESSIONS = path.join(env.DSH_HOME, 'sessions');
  env.DSH_WORKSPACES = path.join(env.DSH_HOME, 'storages', 'workspace.json');
  return { ...env, ...extra };
}
