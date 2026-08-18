/**
 * 催办风险灯 — 悬浮组件状态模型（纯函数，无 React、无宿主依赖）。
 *
 * 悬浮 UI 只展示 analyze_urge_risks 最近一次调用返回的结构化结果（meta），
 * 不在客户端重新计算业务规则：本模块只做「展示层」的状态转换与文案映射。
 *
 * 状态转换：
 * - applyResult(state, meta)   —— 调用成功：以新结果替换，清除失败标记；
 * - applyFailure(state)        —— 调用失败：保留上一次成功结果，标记本次更新失败；
 * - shouldHighlight(prev, next)—— 新增需要催办的红色流程时触发一次性高亮。
 */
import { buildDisplayModel } from "./display-model.js";

/** 需要催办的红色流程数（level=red 且 shouldUrge=true）。 */
export function redUrgeCount(meta) {
  if (meta === null || typeof meta !== "object" || !Array.isArray(meta.items)) return 0;
  return meta.items.filter((item) => item.riskLevel === "red" && item.shouldUrge === true).length;
}

/** 初始状态：无结果、未失败。 */
export function createWidgetState() {
  return { result: null, failed: false, failedAt: null, updatedAt: null, rev: 0 };
}

/** 调用成功：以结构化结果更新；rev 递增用于驱动一次性高亮。 */
export function applyResult(state, meta) {
  return { result: meta, failed: false, failedAt: null, updatedAt: Date.now(), rev: state.rev + 1 };
}

/** 调用失败：保留上一次成功结果，标记本次更新失败。 */
export function applyFailure(state, at) {
  return { result: state.result, failed: true, failedAt: at ?? Date.now(), updatedAt: at ?? Date.now(), rev: state.rev + 1 };
}

/** 收起状态展示模型。 */
export function collapsedModel(state) {
  const result = state.result;
  const counts =
    result !== null && typeof result === "object" && result.summary
      ? {
          red: result.summary.redCount,
          yellow: result.summary.yellowCount,
          green: result.summary.greenCount,
          urge: result.summary.shouldUrgeCount,
        }
      : null;
  return {
    name: "催办风险灯",
    counts,
    urgeText: counts === null ? null : `需催办 ${counts.urge}`,
    empty: counts === null,
    failed: state.failed === true,
  };
}

/** 展开状态展示模型：6 项汇总 + 流程行（复用 display-model 的行映射）。 */
export function expandedModel(state) {
  const result = state.result;
  if (result === null || typeof result !== "object") return null;
  const model = buildDisplayModel(result, null);
  return {
    cells: model.summaryCells,
    rows: model.rows,
    failed: state.failed === true,
  };
}

/**
 * 是否触发一次性高亮：新结果中「需催办的红色流程数」比上一次多。
 * 仅返回布尔值，由 UI 决定一次性动画（不持续闪烁）。
 */
export function shouldHighlight(prev, next) {
  if (next === null || next.result === null) return false;
  if (prev === null || prev.result === null) return true;
  return redUrgeCount(next.result) > redUrgeCount(prev.result);
}
