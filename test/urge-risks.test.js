/**
 * 单元测试：直接覆盖 lib/index.js（src/index.ts 的 tsc 编译产物）。
 * 覆盖风险边界、超时判断、4 小时催办冷却、进度百分比保留一位小数、
 * 空数组/负数/slaHours 非正/缺失必填字段等错误路径、汇总统计与确定性。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeUrgeRisks,
  classifyProcess,
  validateProcesses,
  UrgeRiskValidationError,
  YELLOW_THRESHOLD,
  URGE_COOLDOWN_HOURS,
} from "../lib/index.js";
import { DEMO, EXPECTED, EXPECTED_SUMMARY } from "./fixtures.js";

const base = (overrides) => ({
  processId: "T001",
  processName: "测试流程",
  currentNode: "测试节点",
  handler: "测试人",
  nodeStayHours: 10,
  slaHours: 24,
  ...overrides,
});

test("常量：黄色阈值为 0.8，冷却期为 4 小时", () => {
  assert.equal(YELLOW_THRESHOLD, 0.8);
  assert.equal(URGE_COOLDOWN_HOURS, 4);
});

test("演示数据：四条流程的判定与预期完全一致", () => {
  const result = analyzeUrgeRisks(DEMO);
  assert.deepEqual(result.summary, EXPECTED_SUMMARY);
  assert.equal(result.items.length, 4);
  for (const item of result.items) {
    const expected = EXPECTED[item.processId];
    assert.ok(expected, `未知流程 ${item.processId}`);
    assert.equal(item.riskLevel, expected.riskLevel, `${item.processId} riskLevel`);
    assert.equal(item.riskLabel, expected.riskLabel, `${item.processId} riskLabel`);
    assert.equal(item.progressPercent, expected.progressPercent, `${item.processId} progressPercent`);
    if ("remainingHours" in expected) assert.equal(item.remainingHours, expected.remainingHours, `${item.processId} remainingHours`);
    if ("overdueHours" in expected) assert.equal(item.overdueHours, expected.overdueHours, `${item.processId} overdueHours`);
    assert.equal(item.shouldUrge, expected.shouldUrge, `${item.processId} shouldUrge`);
    assert.equal(item.suppressedByCooldown, expected.suppressedByCooldown, `${item.processId} suppressedByCooldown`);
    if ("cooldownRemainingHours" in expected) assert.equal(item.cooldownRemainingHours, expected.cooldownRemainingHours, `${item.processId} cooldownRemainingHours`);
    assert.equal(item.suggestedAction, expected.suggestedAction, `${item.processId} suggestedAction`);
  }
});

test("演示数据：reason 明确展示实际停留时间、时限与规则依据", () => {
  const result = analyzeUrgeRisks(DEMO);
  const byId = Object.fromEntries(result.items.map((item) => [item.processId, item]));
  assert.match(byId.P001.reason, /30/);
  assert.match(byId.P001.reason, /24/);
  assert.match(byId.P001.reason, /超时/);
  assert.match(byId.P002.reason, /临期/);
  assert.match(byId.P002.reason, /80%/);
  assert.match(byId.P003.reason, /正常/);
  assert.match(byId.P004.reason, /冷却期/);
  assert.match(byId.P004.reason, /2 小时后可再次催办/);
});

test("边界：停留时间恰好等于 SLA×0.8 → 黄色（临期）", () => {
  const item = classifyProcess(base({ nodeStayHours: 24 * 0.8 }));
  assert.equal(item.riskLevel, "yellow");
  assert.equal(item.riskLabel, "临期");
  assert.equal(item.suggestedAction, "提前提醒");
  assert.equal(item.shouldUrge, true);
});

test("边界：停留时间略低于 SLA×0.8 → 绿色（正常）", () => {
  const item = classifyProcess(base({ nodeStayHours: 24 * 0.8 - 0.001 }));
  assert.equal(item.riskLevel, "green");
  assert.equal(item.shouldUrge, false);
});

test("边界：停留时间恰好等于 SLA → 红色（超时），剩余 0、超时 0", () => {
  const item = classifyProcess(base({ nodeStayHours: 24 }));
  assert.equal(item.riskLevel, "red");
  assert.equal(item.remainingHours, 0);
  assert.equal(item.overdueHours, 0);
  assert.equal(item.suggestedAction, "立即催办");
});

test("边界：停留时间略低于 SLA → 黄色，未超时", () => {
  const item = classifyProcess(base({ nodeStayHours: 23.999 }));
  assert.equal(item.riskLevel, "yellow");
  assert.equal(item.overdueHours, 0);
  // remainingHours 保留一位小数：0.001 小时 → 0
  assert.equal(item.remainingHours, 0);
  const visible = classifyProcess(base({ nodeStayHours: 23.5 }));
  assert.equal(visible.remainingHours, 0.5);
});

test("未超时 remainingHours>0 且 overdueHours=0；已超时反之", () => {
  const yellow = classifyProcess(base({ nodeStayHours: 20 }));
  assert.equal(yellow.remainingHours, 4);
  assert.equal(yellow.overdueHours, 0);
  const red = classifyProcess(base({ nodeStayHours: 30 }));
  assert.equal(red.remainingHours, 0);
  assert.equal(red.overdueHours, 6);
});

test("progressPercent 保留一位小数", () => {
  assert.equal(classifyProcess(base({ nodeStayHours: 20 })).progressPercent, 83.3);
  assert.equal(classifyProcess(base({ nodeStayHours: 8 })).progressPercent, 33.3);
  assert.equal(classifyProcess(base({ nodeStayHours: 30 })).progressPercent, 125);
  assert.equal(classifyProcess(base({ nodeStayHours: 36 })).progressPercent, 150);
  assert.equal(classifyProcess(base({ nodeStayHours: 10 })).progressPercent, 41.7);
});

test("冷却：距上次催办 3.99 小时 → 抑制，剩余约 0.01 小时", () => {
  const item = classifyProcess(base({ nodeStayHours: 30, lastUrgedHoursAgo: 3.99 }));
  assert.equal(item.riskLevel, "red"); // 保留原风险等级
  assert.equal(item.suppressedByCooldown, true);
  assert.equal(item.shouldUrge, false);
  assert.equal(item.suggestedAction, "暂缓重复催办");
  assert.ok(Math.abs(item.cooldownRemainingHours - 0.01) < 1e-9);
});

test("冷却：距上次催办恰好 4 小时 → 不抑制", () => {
  const item = classifyProcess(base({ nodeStayHours: 30, lastUrgedHoursAgo: 4 }));
  assert.equal(item.suppressedByCooldown, false);
  assert.equal(item.shouldUrge, true);
  assert.equal(item.cooldownRemainingHours, 0);
});

test("冷却：距上次催办 0 小时 → 抑制，剩余 4 小时", () => {
  const item = classifyProcess(base({ nodeStayHours: 30, lastUrgedHoursAgo: 0 }));
  assert.equal(item.suppressedByCooldown, true);
  assert.equal(item.shouldUrge, false);
  assert.equal(item.cooldownRemainingHours, 4);
});

test("冷却：绿色流程也应用冷却覆盖（保留绿色等级，改为暂缓重复催办）", () => {
  const item = classifyProcess(base({ nodeStayHours: 8, lastUrgedHoursAgo: 1 }));
  assert.equal(item.riskLevel, "green");
  assert.equal(item.riskLabel, "正常");
  assert.equal(item.suppressedByCooldown, true);
  assert.equal(item.shouldUrge, false);
  assert.equal(item.suggestedAction, "暂缓重复催办");
});

test("从未催办（不传 lastUrgedHoursAgo）→ 不抑制", () => {
  const item = classifyProcess(base({ nodeStayHours: 30 }));
  assert.equal(item.suppressedByCooldown, false);
  assert.equal(item.shouldUrge, true);
  assert.equal(item.cooldownRemainingHours, 0);
});

test("确定性：相同输入两次调用结果完全一致", () => {
  assert.deepEqual(analyzeUrgeRisks(DEMO), analyzeUrgeRisks(DEMO));
});

test("错误：非数组输入", () => {
  assert.throws(() => analyzeUrgeRisks({ processes: DEMO }), (error) => {
    assert.ok(error instanceof UrgeRiskValidationError);
    assert.match(error.message, /processes 必须是数组/);
    return true;
  });
});

test("错误：空数组", () => {
  assert.throws(() => analyzeUrgeRisks([]), /processes 为空数组/);
  assert.deepEqual(validateProcesses([]), ["processes 为空数组，没有可分析的流程"]);
});

test("错误：缺失必填字段", () => {
  const missing = base({});
  delete missing.handler;
  const issues = validateProcesses([missing]);
  assert.ok(issues.some((issue) => issue.includes("handler 必填")));
  assert.throws(() => analyzeUrgeRisks([missing]), /handler 必填/);
});

test("错误：nodeStayHours 为负数", () => {
  const issues = validateProcesses([base({ nodeStayHours: -1 })]);
  assert.ok(issues.some((issue) => issue.includes("nodeStayHours 不能为负数")));
  assert.throws(() => analyzeUrgeRisks([base({ nodeStayHours: -1 })]), /nodeStayHours 不能为负数/);
});

test("错误：slaHours 为 0 或负数", () => {
  for (const sla of [0, -5]) {
    assert.throws(() => analyzeUrgeRisks([base({ slaHours: sla })]), /slaHours 必须为正数/);
  }
});

test("错误：lastUrgedHoursAgo 为负数", () => {
  const issues = validateProcesses([base({ lastUrgedHoursAgo: -0.5 })]);
  assert.ok(issues.some((issue) => issue.includes("lastUrgedHoursAgo 不能为负数")));
});

test("错误：字段类型错误（非数字）", () => {
  assert.throws(() => analyzeUrgeRisks([base({ nodeStayHours: "30" })]), /nodeStayHours 必填且为数字/);
  assert.throws(() => analyzeUrgeRisks([base({ slaHours: "24" })]), /slaHours 必填且为数字/);
});

test("错误：空字符串字段与 NaN/Infinity", () => {
  assert.ok(validateProcesses([base({ processId: "  " })]).some((issue) => issue.includes("processId 必填")));
  assert.ok(validateProcesses([base({ nodeStayHours: Number.NaN })]).some((issue) => issue.includes("nodeStayHours 必填且为数字")));
  assert.ok(validateProcesses([base({ nodeStayHours: Number.POSITIVE_INFINITY })]).some((issue) => issue.includes("nodeStayHours 必填且为数字")));
});

test("错误：数组元素不是对象", () => {
  assert.throws(() => analyzeUrgeRisks([42]), /第 1 条流程必须是对象/);
});

test("错误：多条错误合并为一条清晰消息", () => {
  assert.throws(() => analyzeUrgeRisks([base({ nodeStayHours: -1, slaHours: 0 })]), (error) => {
    assert.ok(error instanceof UrgeRiskValidationError);
    assert.ok(error.message.includes("nodeStayHours 不能为负数"));
    assert.ok(error.message.includes("slaHours 必须为正数"));
    assert.equal(error.code, "INVALID_ARGUMENTS");
    assert.equal(error.issues.length, 2);
    return true;
  });
});

test("汇总统计：混合输入计数正确", () => {
  const result = analyzeUrgeRisks([
    base({ processId: "A1", nodeStayHours: 30 }), // red
    base({ processId: "A2", nodeStayHours: 20 }), // yellow
    base({ processId: "A3", nodeStayHours: 8 }), // green
    base({ processId: "A4", nodeStayHours: 30, lastUrgedHoursAgo: 1 }), // red + suppressed
    base({ processId: "A5", nodeStayHours: 20, lastUrgedHoursAgo: 2 }), // yellow + suppressed
  ]);
  assert.deepEqual(result.summary, {
    total: 5,
    redCount: 2,
    yellowCount: 2,
    greenCount: 1,
    shouldUrgeCount: 2, // A1、A2
    suppressedCount: 2, // A4、A5
  });
});

test("输出顺序与输入顺序一致", () => {
  const result = analyzeUrgeRisks(DEMO);
  assert.deepEqual(result.items.map((item) => item.processId), ["P001", "P002", "P003", "P004"]);
});
