// 催办风险灯 — analyze_urge_risks 运行时宿主代码（cordis_define 的 code.host）。
// 本文件是「实际提交给运行时的那段文本」的权威副本：
// 纯 JS、无 import、仅使用 harness 内建能力；语义与 lib/index.js（tsc 产物）一致，
// 由 test/dynamic-host.test.js 的 parity 用例矩阵逐分支验证等价。
var YELLOW_THRESHOLD = 0.8;
var URGE_COOLDOWN_HOURS = 4;

function round1(value) { return Math.round(value * 10) / 10; }

function isPlainObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

function isNonEmptyString(value) { return typeof value === "string" && value.trim().length > 0; }

function isFiniteNumber(value) { return typeof value === "number" && Number.isFinite(value); }

function validateProcesses(input) {
  if (!Array.isArray(input)) return ["processes 必须是数组"];
  if (input.length === 0) return ["processes 为空数组，没有可分析的流程"];
  var errors = [];
  input.forEach(function (raw, index) {
    if (!isPlainObject(raw)) { errors.push("第 " + (index + 1) + " 条流程必须是对象"); return; }
    var pid = raw.processId;
    var suffix = (typeof pid === "string" && pid.trim().length > 0) ? "(" + pid + ")" : "";
    var label = "第 " + (index + 1) + " 条流程" + suffix;
    if (!isNonEmptyString(raw.processId)) errors.push(label + "：processId 必填且为非空字符串");
    if (!isNonEmptyString(raw.processName)) errors.push(label + "：processName 必填且为非空字符串");
    if (!isNonEmptyString(raw.currentNode)) errors.push(label + "：currentNode 必填且为非空字符串");
    if (!isNonEmptyString(raw.handler)) errors.push(label + "：handler 必填且为非空字符串");
    var stay = raw.nodeStayHours;
    if (!isFiniteNumber(stay)) errors.push(label + "：nodeStayHours 必填且为数字");
    else if (stay < 0) errors.push(label + "：nodeStayHours 不能为负数（得到 " + stay + "）");
    var sla = raw.slaHours;
    if (!isFiniteNumber(sla)) errors.push(label + "：slaHours 必填且为数字");
    else if (sla <= 0) errors.push(label + "：slaHours 必须为正数（得到 " + sla + "）");
    if (raw.lastUrgedHoursAgo !== undefined) {
      var urged = raw.lastUrgedHoursAgo;
      if (!isFiniteNumber(urged)) errors.push(label + "：lastUrgedHoursAgo 必须为数字");
      else if (urged < 0) errors.push(label + "：lastUrgedHoursAgo 不能为负数（得到 " + urged + "）");
    }
  });
  return errors;
}

function classifyProcess(input) {
  var processId = input.processId;
  var processName = input.processName;
  var currentNode = input.currentNode;
  var handler = input.handler;
  var nodeStayHours = input.nodeStayHours;
  var slaHours = input.slaHours;
  var lastUrgedHoursAgo = input.lastUrgedHoursAgo;
  var progressPercent = round1((nodeStayHours / slaHours) * 100);
  var thresholdHours = slaHours * YELLOW_THRESHOLD;
  var overdue = nodeStayHours >= slaHours;
  var riskLevel, riskLabel, suggestedAction, reason;
  if (nodeStayHours < thresholdHours) {
    riskLevel = "green"; riskLabel = "正常"; suggestedAction = "暂不处理";
    reason = "节点已停留 " + round1(nodeStayHours) + " 小时，SLA 时限 " + round1(slaHours) + " 小时（进度 " + progressPercent + "%），未达到 SLA 的 80% 阈值（" + round1(thresholdHours) + " 小时），判定为正常";
  } else if (!overdue) {
    riskLevel = "yellow"; riskLabel = "临期"; suggestedAction = "提前提醒";
    reason = "节点已停留 " + round1(nodeStayHours) + " 小时，SLA 时限 " + round1(slaHours) + " 小时（进度 " + progressPercent + "%），已达到 SLA 的 80% 阈值（" + round1(thresholdHours) + " 小时）但尚未超时，判定为临期";
  } else {
    riskLevel = "red"; riskLabel = "超时"; suggestedAction = "立即催办";
    reason = "节点已停留 " + round1(nodeStayHours) + " 小时，SLA 时限 " + round1(slaHours) + " 小时（进度 " + progressPercent + "%），已达到 SLA 时限，判定为超时";
  }
  var shouldUrge = riskLevel !== "green";
  var suppressedByCooldown = false;
  var cooldownRemainingHours = 0;
  if (lastUrgedHoursAgo !== undefined && lastUrgedHoursAgo < URGE_COOLDOWN_HOURS) {
    suppressedByCooldown = true;
    shouldUrge = false;
    cooldownRemainingHours = URGE_COOLDOWN_HOURS - lastUrgedHoursAgo;
    suggestedAction = "暂缓重复催办";
    reason += "；距上次催办 " + round1(lastUrgedHoursAgo) + " 小时，处于 " + URGE_COOLDOWN_HOURS + " 小时冷却期内，暂缓重复催办（" + cooldownRemainingHours + " 小时后可再次催办）";
  }
  return {
    processId: processId, processName: processName, currentNode: currentNode, handler: handler,
    riskLevel: riskLevel, riskLabel: riskLabel, progressPercent: progressPercent,
    remainingHours: overdue ? 0 : round1(slaHours - nodeStayHours),
    overdueHours: overdue ? round1(nodeStayHours - slaHours) : 0,
    shouldUrge: shouldUrge, suppressedByCooldown: suppressedByCooldown, cooldownRemainingHours: cooldownRemainingHours,
    reason: reason, suggestedAction: suggestedAction
  };
}

function analyzeUrgeRisks(input) {
  var issues = validateProcesses(input);
  if (issues.length > 0) throw new Error("analyze_urge_risks 参数校验失败：" + issues.join("；"));
  var items = input.map(classifyProcess);
  return {
    summary: {
      total: items.length,
      redCount: items.filter(function (i) { return i.riskLevel === "red"; }).length,
      yellowCount: items.filter(function (i) { return i.riskLevel === "yellow"; }).length,
      greenCount: items.filter(function (i) { return i.riskLevel === "green"; }).length,
      shouldUrgeCount: items.filter(function (i) { return i.shouldUrge; }).length,
      suppressedCount: items.filter(function (i) { return i.suppressedByCooldown; }).length
    },
    items: items
  };
}

// ---- 工具定义（harness 内建 DSL，schema 与 plugin/tool-definition.js 一致） ----
var TOOL_NAME = "analyze_urge_risks";
var TOOL_DESCRIPTION = "批量分析流程节点的催办风险：对每条流程，根据当前节点已停留小时数（nodeStayHours）与节点处理时限（slaHours）的对比，输出红（超时）、黄（临期）、绿（正常）三档风险等级、判断依据与处理建议。规则：停留时间 < SLA×80% 为正常（green，暂不处理）；SLA×80% ≤ 停留时间 < SLA 为临期（yellow，提前提醒）；停留时间 ≥ SLA 为超时（red，立即催办）。若距上次催办（lastUrgedHoursAgo）不足 4 小时，则保留原风险等级但暂缓重复催办（shouldUrge=false，suppressedByCooldown=true，建议为“暂缓重复催办”），并返回距允许再次催办的剩余小时数。仅做确定性规则计算：不连接真实流程系统、不发送真实催办消息。参数非法（空数组、负数、slaHours 非正、缺失必填字段等）时返回清晰错误。";
var PARAMETERS = {
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
        lastUrgedHoursAgo: { type: "number", description: "距上次催办的小时数（可选，非负数字；从未催办时不传）。" }
      }
    }
  }
};
var OUTPUT_SCHEMA = {
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
        suppressedCount: { type: "integer", required: true }
      }
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
          suggestedAction: { type: "string", required: true }
        }
      }
    }
  }
};
function renderResult(args, value) {
  var ICON = { red: "🔴", yellow: "🟡", green: "🟢" };
  var s = value.summary;
  var head = "催办风险分析结果（共 " + s.total + " 条）：红色 " + s.redCount + " / 黄色 " + s.yellowCount + " / 绿色 " + s.greenCount + "；应催办 " + s.shouldUrgeCount + "；冷却抑制 " + s.suppressedCount;
  var lines = ["| 流程 | 节点 | 处理人 | 风险等级 | 进度 | 剩余/超时 | 本次操作 |", "| --- | --- | --- | --- | --- | --- | --- |"];
  lines = lines.concat(value.items.map(function (item) {
    var timer = item.overdueHours > 0 ? "超时 " + item.overdueHours + " 小时" : "剩余 " + item.remainingHours + " 小时";
    var action = item.suppressedByCooldown ? "暂缓重复催办（冷却中，" + item.cooldownRemainingHours + " 小时后可再催）" : item.suggestedAction;
    return "| " + item.processId + " " + item.processName + " | " + item.currentNode + " | " + item.handler + " | " + ICON[item.riskLevel] + " " + item.riskLabel + " | " + item.progressPercent + "% | " + timer + " | " + action + " |";
  }));
  return [{ type: "text", text: head + "\n\n" + lines.join("\n") }];
}
function presentationMeta(args, value) { return value; }

var tool = harness.defineTool({
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  parameters: PARAMETERS,
  output: { schema: OUTPUT_SCHEMA, render: renderResult, presentationMeta: presentationMeta },
  async execute(args, exec) { return analyzeUrgeRisks(args.processes); }
});
return { apply: function (ctx) { return harness.registerTool(ctx, tool); } };
