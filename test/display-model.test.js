/**
 * 展示映射单元测试：plugin/display-model.js（纯函数，无 React / 宿主依赖）。
 * 覆盖汇总卡 6 格、行 tone/highlight/action、P004 双状态（风险等级与
 * 本次操作分离）、入参缺失时派生停留/SLA、args 解析、确定性。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildDisplayModel, parseArgsProcesses, deriveStaySla } from "../plugin/display-model.js";
import { analyzeUrgeRisks } from "../lib/index.js";
import { DEMO } from "./fixtures.js";

const RESULT = analyzeUrgeRisks(DEMO);

test("汇总卡 6 格：值、标签、色调正确", () => {
  const model = buildDisplayModel(RESULT, DEMO);
  assert.deepEqual(
    model.summaryCells.map((cell) => [cell.key, cell.value, cell.tone]),
    [
      ["total", 4, "neutral"],
      ["red", 2, "red"],
      ["yellow", 1, "yellow"],
      ["green", 1, "green"],
      ["urge", 2, "amber"],
      ["suppressed", 1, "neutral"],
    ],
  );
  assert.deepEqual(
    model.summaryCells.map((cell) => cell.label),
    ["流程总数", "红色", "黄色", "绿色", "应催办", "冷却抑制"],
  );
});

test("行：顺序与输入一致，展示数据取自原始入参", () => {
  const model = buildDisplayModel(RESULT, DEMO);
  assert.deepEqual(model.rows.map((row) => row.processId), ["P001", "P002", "P003", "P004"]);
  const p1 = model.rows[0];
  assert.equal(p1.processName, "员工证明审批");
  assert.equal(p1.currentNode, "部门负责人审批");
  assert.equal(p1.handler, "张三");
  assert.equal(p1.nodeStayHours, 30);
  assert.equal(p1.slaHours, 24);
  assert.equal(p1.staySlaDerived, false);
});

test("P001 红色：突出超时小时数，动作立即催办", () => {
  const row = buildDisplayModel(RESULT, DEMO).rows[0];
  assert.equal(row.level, "red");
  assert.equal(row.levelLabel, "超时");
  assert.equal(row.tone, "red");
  assert.equal(row.highlight, "超时 6 小时");
  assert.equal(row.highlightTone, "red");
  assert.equal(row.action, "立即催办");
  assert.equal(row.actionTone, "red");
  assert.equal(row.suppressed, false);
  assert.equal(row.nextUrgeIn, null);
});

test("P002 黄色：突出剩余小时数，动作提前提醒", () => {
  const row = buildDisplayModel(RESULT, DEMO).rows[1];
  assert.equal(row.level, "yellow");
  assert.equal(row.levelLabel, "临期");
  assert.equal(row.highlight, "剩余 4 小时");
  assert.equal(row.highlightTone, "yellow");
  assert.equal(row.action, "提前提醒");
  assert.equal(row.actionTone, "yellow");
  assert.equal(row.suppressed, false);
});

test("P003 绿色：剩余小时数弱提示，动作暂不处理", () => {
  const row = buildDisplayModel(RESULT, DEMO).rows[2];
  assert.equal(row.level, "green");
  assert.equal(row.levelLabel, "正常");
  assert.equal(row.highlight, "剩余 16 小时");
  assert.equal(row.highlightTone, "green");
  assert.equal(row.action, "暂不处理");
  assert.equal(row.actionTone, "green");
  assert.equal(row.suppressed, false);
});

test("P004 双状态：风险等级仍为红色，本次操作被冷却抑制（两字段互不覆盖）", () => {
  const row = buildDisplayModel(RESULT, DEMO).rows[3];
  // 风险等级：红色不变
  assert.equal(row.level, "red");
  assert.equal(row.levelLabel, "超时");
  assert.equal(row.tone, "red");
  assert.equal(row.highlight, "超时 12 小时");
  assert.equal(row.highlightTone, "red");
  // 本次操作：冷却抑制
  assert.equal(row.suppressed, true);
  assert.equal(row.nextUrgeIn, 2);
  assert.equal(row.action, "暂缓重复催办");
  assert.equal(row.actionTone, "muted");
});

test("入参缺失：停留/SLA 从进度与剩余/超时派生，并标记 staySlaDerived", () => {
  const model = buildDisplayModel(RESULT, null);
  assert.equal(model.rows[0].staySlaDerived, true);
  assert.equal(model.rows[0].nodeStayHours, 30);
  assert.equal(model.rows[0].slaHours, 24);
  assert.equal(model.rows[3].staySlaDerived, true);
  assert.equal(model.rows[3].nodeStayHours, 36);
  assert.equal(model.rows[3].slaHours, 24);
});

test("入参与 meta 数量不匹配：缺少的条目降级（派生或 null），不崩溃", () => {
  const partial = buildDisplayModel(RESULT, DEMO.slice(0, 2));
  assert.equal(partial.rows.length, 4);
  assert.equal(partial.rows[0].nodeStayHours, 30); // 有入参
  assert.equal(partial.rows[3].staySlaDerived, true); // 无入参 → 派生
  assert.equal(partial.rows[3].nodeStayHours, 36);
});

test("parseArgsProcesses：合法 JSON → 数组；异常输入 → null", () => {
  assert.deepEqual(parseArgsProcesses(JSON.stringify({ processes: DEMO })), DEMO);
  assert.equal(parseArgsProcesses("not json"), null);
  assert.equal(parseArgsProcesses("{}"), null);
  assert.equal(parseArgsProcesses(""), null);
  assert.equal(parseArgsProcesses(null), null);
  assert.equal(parseArgsProcesses(undefined), null);
  assert.equal(parseArgsProcesses(JSON.stringify({ foo: 1 })), null);
});

test("deriveStaySla：异常进度返回 null", () => {
  assert.equal(deriveStaySla({ progressPercent: 0, overdueHours: 0, remainingHours: 10 }), null);
  assert.equal(deriveStaySla({ progressPercent: -1, overdueHours: 0, remainingHours: 10 }), null);
  assert.equal(deriveStaySla({ progressPercent: 100, overdueHours: 0, remainingHours: 0 }), null);
});

test("确定性：相同输入产生完全相同的展示模型", () => {
  assert.deepEqual(buildDisplayModel(RESULT, DEMO), buildDisplayModel(RESULT, DEMO));
});
