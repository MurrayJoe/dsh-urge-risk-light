/**
 * 全新安装验证脚本：npm pack 产出的 .tgz 安装到全新临时目录后，
 * 验证 Runtime 与 Client 模块都能正确加载。
 *
 * 用法（在包仓库内运行，react/react-dom 从仓库 devDeps 解析）：
 *   npm run verify:install -- <包名> <临时安装目录>
 *
 * 验证项：
 * 1. package.json 结构：name/version/private 移除/exports/dsh.client/files 产物存在；
 * 2. Runtime 工具加载：导入安装包 . 入口（宿主插件），并直接调用
 *    lib/index.js 的 analyzeUrgeRisks（演示数据）——同时证明 peer 依赖可解析；
 * 3. Client 模块加载：读取 exports["./client"] 产物，在 vm 中经
 *    __ModuleLoader__.load 注册工厂，插件 apply 注册 tool.call.toolview（结果卡片）
 *    与 shell.overlay（悬浮组件）两个槽位；
 * 4. SSR 渲染：空态「尚未分析」、投递后计数、卡片含 P004 双状态。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEMO } from "../test/fixtures.js";

const pkgName = process.argv[2] ?? "dsh-urge-risk-light";
const installDir = process.argv[3] ?? process.cwd();
const pkgRoot = join(installDir, "node_modules", pkgName);

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures += 1;
}

// ── 1) 包结构 ──
check("包已安装到 node_modules", existsSync(pkgRoot));
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
check(`name === ${pkgName}`, pkg.name === pkgName);
check("version === 0.1.0", pkg.version === "0.1.0");
check("private 已移除", pkg.private !== true);
check('exports["."] 存在（Runtime 入口）', typeof pkg.exports?.["."]?.default === "string");
check('exports["./client"] 存在（Client bundle）', typeof pkg.exports?.["./client"] === "string");
check("dsh.client.platform === web", pkg.dsh?.client?.platform === "web");
check("license === MIT", pkg.license === "MIT");
check("files 白名单不含测试/缓存", !JSON.stringify(pkg.files).includes("test") && !JSON.stringify(pkg.files).includes("npm-cache"));

const clientBundlePath = join(pkgRoot, pkg.exports["./client"]);
const hostEntryPath = join(pkgRoot, pkg.exports["."].default);
check("Client bundle 产物存在", existsSync(clientBundlePath));
check("Runtime 入口产物存在", existsSync(hostEntryPath));

// ── 2) Runtime 工具加载 ──
let hostMod = null;
try {
  hostMod = await import(pathToFileURL(hostEntryPath).href);
} catch (error) {
  check(`Runtime 导入失败：${error.message}`, false);
}
check("Runtime 宿主插件可加载（apply 存在）", hostMod !== null && typeof hostMod?.apply === "function");

const lib = await import(pathToFileURL(join(pkgRoot, "lib", "index.js")).href);
const result = lib.analyzeUrgeRisks(DEMO);
check(
  `analyzeUrgeRisks 逻辑正确（共 ${result.summary.total} 条，红 ${result.summary.redCount}）`,
  result.summary.total === 4 && result.summary.redCount === 2 && result.summary.suppressedCount === 1,
);

// ── 3) Client 模块加载（VM 模拟 web 运行时） ──
let handoff = null;
const registered = { toolview: null, widget: null };
const sandbox = {
  console,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  window: { __ModuleLoader__: { load(h) { handoff = h; } } },
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(clientBundlePath, "utf8"), sandbox);
check("Client bundle 注册 __ModuleLoader__", handoff !== null);
check(`bundle id === ${pkgName}`, handoff?.id === pkgName);

const plugin = handoff.factory((spec) => {
  if (spec === "react") return React;
  throw new Error(`unexpected require("${spec}")`);
});
plugin.apply({
  slots: {
    inject: (key, cb) => cb(),
    register: (options, component) => {
      if (options.name === "tool.call.toolview") registered.toolview = component;
      if (options.name === "shell.overlay") registered.widget = component;
      return () => {};
    },
  },
});
check("注册结果卡片（tool.call.toolview）", typeof registered.toolview === "function");
check("注册悬浮组件（shell.overlay）", typeof registered.widget === "function");

// ── 4) SSR 渲染验证 ──
const widgetEmpty = renderToStaticMarkup(React.createElement(registered.widget, {}));
check("悬浮组件空态显示「尚未分析」", widgetEmpty.includes("尚未分析"));

const meta = result;
plugin.__test.setState({ result: meta, failed: false, failedAt: null, updatedAt: Date.now(), rev: 1 });
const widgetFilled = renderToStaticMarkup(React.createElement(registered.widget, {}));
check("悬浮组件显示「🔴2 🟡1 🟢1 · 需催办 2」", widgetFilled.includes("🔴2 🟡1 🟢1") && widgetFilled.includes("需催办 2"));

const block = {
  kind: "tool-result",
  callId: "c1",
  seq: 1,
  time: Date.now(),
  call: { name: "analyze_urge_risks", argsRaw: JSON.stringify({ processes: DEMO }) },
  content: [],
  isError: false,
  meta: result,
};
const card = renderToStaticMarkup(
  React.createElement(registered.toolview, { callId: "c1", toolName: "analyze_urge_risks", block, openFile: () => {} }),
);
check("结果卡片渲染（催办风险灯）", card.includes("催办风险灯"));
check("结果卡片含 P004 双状态（🔴 超时 + 暂缓催办）", card.includes("🔴 超时") && card.includes("暂缓催办 · 2 小时后可再催办"));

console.log(failures === 0 ? "\n全部验证通过 ✔" : `\n${failures} 项验证失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
