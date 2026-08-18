/**
 * 悬浮组件状态模型测试：plugin/widget-model.js（纯函数）。
 * 覆盖：成功更新、失败保留上次成功结果、收起/展开展示模型、
 * 一次性高亮判定（新增需催办红色流程时）、确定性。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWidgetState,
  applyResult,
  applyFailure,
  collapsedModel,
  expandedModel,
  shouldHighlight,
  redUrgeCount,
} from "../plugin/widget-model.js";
import { analyzeUrgeRisks } from "../lib/index.js";
import { DEMO } from "./fixtures.js";

const RESULT = analyzeUrgeRisks(DEMO);

test("初始状态：无结果、未失败，收起显示「尚未分析」", () => {
  const state = createWidgetState();
  assert.deepEqual(state, { result: null, failed: false, failedAt: null, updatedAt: null, rev: 0 });
  const m = collapsedModel(state);
  assert.equal(m.name, "催办风险灯");
  assert.equal(m.empty, true);
  assert.equal(m.failed, false);
  assert.equal(m.counts, null);
  assert.equal(expandedModel(state), null);
});

test("成功更新：替换结果、清除失败标记、rev 递增", () => {
  const s0 = createWidgetState();
  const s1 = applyResult(s0, RESULT);
  assert.equal(s1.failed, false);
  assert.equal(s1.result, RESULT);
  assert.equal(s1.rev, 1);
  const m = collapsedModel(s1);
  assert.equal(m.empty, false);
  assert.deepEqual(m.counts, { red: 2, yellow: 1, green: 1, urge: 2 });
  assert.equal(m.urgeText, "需催办 2");
});

test("失败更新：保留上一次成功结果，标记本次更新失败", () => {
  const s0 = applyResult(createWidgetState(), RESULT);
  const s1 = applyFailure(s0, 12345);
  assert.equal(s1.result, RESULT, "失败不得清空上一次成功结果");
  assert.equal(s1.failed, true);
  assert.equal(s1.failedAt, 12345);
  const m = collapsedModel(s1);
  assert.equal(m.failed, true);
  assert.deepEqual(m.counts, { red: 2, yellow: 1, green: 1, urge: 2 }, "失败时仍显示上次成功结果的计数");
});

test("展开模型：6 项汇总 + 流程行；P004 双状态保留", () => {
  const state = applyResult(createWidgetState(), RESULT);
  const ex = expandedModel(state);
  assert.ok(ex !== null);
  assert.deepEqual(
    ex.cells.map((c) => [c.key, c.value]),
    [
      ["total", 4],
      ["red", 2],
      ["yellow", 1],
      ["green", 1],
      ["urge", 2],
      ["suppressed", 1],
    ],
  );
  assert.equal(ex.rows.length, 4);
  const p4 = ex.rows[3];
  assert.equal(p4.level, "red");
  assert.equal(p4.suppressed, true);
  assert.equal(p4.nextUrgeIn, 2);
  assert.equal(p4.action, "暂缓重复催办");
});

test("redUrgeCount：仅统计 level=red 且 shouldUrge 的流程", () => {
  assert.equal(redUrgeCount(RESULT), 1); // 演示数据中只有 P001（P004 被冷却抑制）
  assert.equal(redUrgeCount(null), 0);
  assert.equal(redUrgeCount({ items: [] }), 0);
  assert.equal(redUrgeCount({ items: [{ riskLevel: "red", shouldUrge: false }] }), 0);
});

test("shouldHighlight：新增需催办红色流程时返回 true，否则 false", () => {
  const s0 = createWidgetState();
  const s1 = applyResult(s0, RESULT);
  assert.equal(shouldHighlight(null, s1), true, "首个结果触发高亮");
  assert.equal(shouldHighlight(s0, s1), true, "无结果 → 有结果触发高亮");
  assert.equal(shouldHighlight(s1, s1), false, "相同结果不触发");

  // 再分析一次：P004 不再被抑制（lastUrgedHoursAgo >= 4）→ 需催办红增加
  const more = analyzeUrgeRisks([
    ...DEMO.map((p, i) => (i === 3 ? { ...p, lastUrgedHoursAgo: 4 } : p)),
  ]);
  assert.equal(redUrgeCount(more), 2);
  const s2 = applyResult(s1, more);
  assert.equal(shouldHighlight(s1, s2), true, "需催办红 1→2 触发高亮");

  // 数量持平或减少不触发
  const less = analyzeUrgeRisks([DEMO[2]]);
  const s3 = applyResult(s2, less);
  assert.equal(shouldHighlight(s2, s3), false);
});

test("确定性：相同输入产生相同状态转换", () => {
  assert.deepEqual(applyResult(createWidgetState(), RESULT), applyResult(createWidgetState(), RESULT));
});
