/**
 * 工具定义共享部分：工具名、描述、参数 Schema、输出 Schema 与 render 函数。
 *
 * 被两处复用，保证 Schema 完全一致：
 * - plugin/plugin.js   —— 可安装的 Cordis 插件入口（defineTool + ctx.tools.register）
 * - scripts/build-host-body.mjs —— 生成动态插件宿主代码（harness.defineTool）
 *
 * Schema 遵循 DSH 官方参数 DSL：object 节点必须显式 additionalProperties，
 * 必填属性使用 required: true；数组用 items 描述元素。
 */

export const TOOL_NAME = "analyze_urge_risks";

export const TOOL_DESCRIPTION =
  "批量分析流程节点的催办风险：对每条流程，根据当前节点已停留小时数（nodeStayHours）" +
  "与节点处理时限（slaHours）的对比，输出红（超时）、黄（临期）、绿（正常）三档风险等级、" +
  "判断依据与处理建议。规则：停留时间 < SLA×80% 为正常（green，暂不处理）；" +
  "SLA×80% ≤ 停留时间 < SLA 为临期（yellow，提前提醒）；停留时间 ≥ SLA 为超时（red，立即催办）。" +
  "若距上次催办（lastUrgedHoursAgo）不足 4 小时，则保留原风险等级但暂缓重复催办" +
  "（shouldUrge=false，suppressedByCooldown=true，建议为“暂缓重复催办”），并返回距允许再次催办的剩余小时数。" +
  "仅做确定性规则计算：不连接真实流程系统、不发送真实催办消息。参数非法（空数组、负数、" +
  "slaHours 非正、缺失必填字段等）时返回清晰错误。";

/** 参数 Schema（逐属性 DSL）。 */
export const PARAMETERS = {
  processes: {
    type: "array",
    required: true,
    description: "待分析的流程数组（非空）。",
    items: {
      type: "object",
      additionalProperties: false,
      description: "单条流程数据。",
      properties: {
        processId: { type: "string", required: true, description: "流程编号（必填，非空字符串）。" },
        processName: { type: "string", required: true, description: "流程名称（必填，非空字符串）。" },
        currentNode: { type: "string", required: true, description: "当前节点（必填，非空字符串）。" },
        handler: { type: "string", required: true, description: "当前处理人（必填，非空字符串）。" },
        nodeStayHours: { type: "number", required: true, description: "节点已停留小时数（必填，非负数字）。" },
        slaHours: { type: "number", required: true, description: "节点处理时限小时数（必填，正数）。" },
        lastUrgedHoursAgo: {
          type: "number",
          description: "距上次催办的小时数（可选，非负数字；从未催办时不传）。",
        },
      },
    },
  },
};

/** 输出 Schema（值 DSL；root 属性用 required: true）。 */
export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "object",
      additionalProperties: false,
      required: true,
      description: "汇总统计。",
      properties: {
        total: { type: "integer", required: true },
        redCount: { type: "integer", required: true },
        yellowCount: { type: "integer", required: true },
        greenCount: { type: "integer", required: true },
        shouldUrgeCount: { type: "integer", required: true },
        suppressedCount: { type: "integer", required: true },
      },
    },
    items: {
      type: "array",
      required: true,
      description: "逐条风险分析结果，顺序与输入一致。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          processId: { type: "string", required: true },
          processName: { type: "string", required: true },
          currentNode: { type: "string", required: true },
          handler: { type: "string", required: true },
          riskLevel: { type: "string", enum: ["green", "yellow", "red"], required: true },
          riskLabel: { type: "string", required: true },
          progressPercent: { type: "number", required: true },
          remainingHours: { type: "number", required: true },
          overdueHours: { type: "number", required: true },
          shouldUrge: { type: "boolean", required: true },
          suppressedByCooldown: { type: "boolean", required: true },
          cooldownRemainingHours: { type: "number", required: true },
          reason: { type: "string", required: true },
          suggestedAction: { type: "string", required: true },
        },
      },
    },
  },
};

/**
 * render：把结构化结果渲染为模型可读的 Markdown 表格（降级展示）。
 * 「风险等级」与「本次操作」分列：冷却中的流程风险等级照旧显示
 * （如 P004 为 🔴 超时），而本次操作列显示「暂缓重复催办（冷却中…）」，
 * 两个语义不混为一谈。
 * 函数必须自包含（不引用模块级符号），因为构建脚本会以 toString()
 * 方式把它内联进动态插件宿主代码。
 */
export function renderResult(args, value) {
  const ICON = { red: "🔴", yellow: "🟡", green: "🟢" };
  const s = value.summary;
  const head =
    `催办风险分析结果（共 ${s.total} 条）：红色 ${s.redCount} / 黄色 ${s.yellowCount} / 绿色 ${s.greenCount}；` +
    `应催办 ${s.shouldUrgeCount}；冷却抑制 ${s.suppressedCount}`;
  const lines = [
    "| 流程 | 节点 | 处理人 | 风险等级 | 进度 | 剩余/超时 | 本次操作 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...value.items.map((item) => {
      const timer = item.overdueHours > 0
        ? `超时 ${item.overdueHours} 小时`
        : `剩余 ${item.remainingHours} 小时`;
      const action = item.suppressedByCooldown
        ? `暂缓重复催办（冷却中，${item.cooldownRemainingHours} 小时后可再催）`
        : item.suggestedAction;
      return (
        `| ${item.processId} ${item.processName} | ${item.currentNode} | ${item.handler} | ` +
        `${ICON[item.riskLevel]} ${item.riskLabel} | ${item.progressPercent}% | ${timer} | ${action} |`
      );
    }),
  ];
  return [{ type: "text", text: `${head}\n\n${lines.join("\n")}` }];
}

/** presentationMeta：原样透出结构化结果供 UI 渲染。 */
export function presentationMeta(args, value) {
  return value;
}
