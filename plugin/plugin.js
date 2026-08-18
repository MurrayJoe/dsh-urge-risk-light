/**
 * 催办风险灯 — 可安装的 Cordis 工具插件入口。
 *
 * 官方插件形态（与 dsh-tool-fs 等内置工具插件一致）：
 * 导出 { name, inject, apply }，apply 中通过 ctx.tools.register(defineTool(...))
 * 注册模型可见工具 analyze_urge_risks。
 *
 * 安装方式（宿主组合行）：
 *   - id: tool-urge-risk-light
 *     name: 'urge-risk-light/plugin'
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { analyzeUrgeRisks } from "../lib/index.js";
import {
  TOOL_NAME,
  TOOL_DESCRIPTION,
  PARAMETERS,
  OUTPUT_SCHEMA,
  renderResult,
  presentationMeta,
} from "./tool-definition.js";

export const name = "tool-urge-risk-light";

/** 硬依赖：工具注册表。 */
export const inject = ["tools"];

/** 注册 analyze_urge_risks 工具；返回值为注册的 disposer，随插件卸载而撤销。 */
export function apply(ctx) {
  return ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: renderResult,
        presentationMeta,
      },
      async execute(args) {
        return analyzeUrgeRisks(args.processes);
      },
    }),
  );
}
