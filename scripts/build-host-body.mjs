/**
 * 生成 plugin/host-body.js：把 tsc 编译产物 lib/index.js 的纯逻辑
 * 原样内联进动态 Cordis 插件的宿主代码体（code.host），
 * 并拼接工具定义（描述 / 参数 Schema / 输出 Schema / render）。
 *
 * 这样「运行时实际执行的逻辑」与「单元测试覆盖的 lib/index.js」是同一份代码，
 * 不存在手工复制的漂移；parity 测试还会再次断言二者一致。
 *
 * 运行：npm run build
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOL_NAME,
  TOOL_DESCRIPTION,
  PARAMETERS,
  OUTPUT_SCHEMA,
} from "../plugin/tool-definition.js";
import { renderResult, presentationMeta } from "../plugin/tool-definition.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const libSource = readFileSync(join(root, "lib", "index.js"), "utf8");

// 去掉顶层 `export ` 关键字，得到可在沙箱中直接使用的函数/常量声明。
const strippedLogic = libSource.replace(/^export\s+/gm, "");

const wrapper = [
  "// ---- 工具定义（harness 内建 DSL；纯逻辑来自上面的 lib/index.js 编译产物） ----",
  `const TOOL_NAME = ${JSON.stringify(TOOL_NAME)};`,
  `const TOOL_DESCRIPTION = ${JSON.stringify(TOOL_DESCRIPTION)};`,
  `const PARAMETERS = ${JSON.stringify(PARAMETERS)};`,
  `const OUTPUT_SCHEMA = ${JSON.stringify(OUTPUT_SCHEMA)};`,
  `const renderResult = ${renderResult.toString()};`,
  `const presentationMeta = ${presentationMeta.toString()};`,
  "const tool = harness.defineTool({",
  "  name: TOOL_NAME,",
  "  description: TOOL_DESCRIPTION,",
  "  parameters: PARAMETERS,",
  "  output: { schema: OUTPUT_SCHEMA, render: renderResult, presentationMeta },",
  "  async execute(args, exec) {",
  "    return analyzeUrgeRisks(args.processes);",
  "  },",
  "});",
  "return {",
  "  apply(ctx) {",
  "    return harness.registerTool(ctx, tool);",
  "  },",
  "};",
].join("\n");

const body = [
  "// 纯逻辑：tsc 编译 src/index.ts 的产物（去掉 export 关键字），",
  "// 与单元测试直接 import 的 lib/index.js 是同一份代码。",
  strippedLogic,
  wrapper,
].join("\n");

const out = [
  "// 自动生成：请勿手工编辑。运行 `npm run build` 重新生成。",
  "// 内容为 cordis_define 的 code.host 函数体（async IIFE 体，需以 return 结尾）。",
  `export const HOST_BODY = ${JSON.stringify(body)};`,
  "",
].join("\n");

writeFileSync(join(root, "plugin", "host-body.js"), out);
console.log("plugin/host-body.js 已生成（%d 字符）", body.length);
