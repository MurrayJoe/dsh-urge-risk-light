/**
 * 催办风险灯 — 展示映射（纯函数，无 React、无宿主依赖）。
 *
 * 把 analyze_urge_risks 的结构化结果（meta）与原始入参（argsRaw 中的
 * processes）映射为客户端可视化所需的展示模型：
 * - summaryCells：汇总卡 6 格（流程总数/红色/黄色/绿色/应催办/冷却抑制）；
 * - rows：逐条风险行（风险等级 tone、突出指标、本次操作、冷却状态）。
 *
 * 设计要点：
 * - 风险等级与「本次操作」是两个独立字段：level/levelLabel 表达风险，
 *   action/suppressed/nextUrgeIn 表达本次操作——P004 既保持 level='red'，
 *   又 suppressed=true，二者互不覆盖；
 * - 展示数据（停留/SLA）优先取原始入参；入参缺失时从进度/剩余/超时派生
 *   （受 progressPercent 一位小数舍入影响，派生值保留一位小数，并标记
 *   staySlaDerived）；
 * - 纯确定性：相同输入产生完全相同的展示模型（测试覆盖）。
 */

/** 三条风险色调名：red / yellow / green（客户端据此取色）。 */
export const TONES = { red: "red", yellow: "yellow", green: "green" };

/** 保留一位小数（四舍五入）。 */
export function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * 解析工具调用的原始入参 JSON 字符串，返回 processes 数组；无法解析或
 * 结构不符时返回 null（展示层据此降级为从 meta 派生或省略）。
 * @param argsRaw - ToolCallBlock.arguments（JSON 字符串）。
 */
export function parseArgsProcesses(argsRaw) {
  if (typeof argsRaw !== "string" || argsRaw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(argsRaw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.processes)) return null;
  return parsed.processes;
}

/**
 * 从结构化结果条目派生停留/SLA（当原始入参缺失时）。
 * 由 progressPercent 与 remaining/overdue 反解：
 * - 未超时：sla = remaining / (1 - p/100)
 * - 已超时：sla = overdue / (p/100 - 1)
 * @returns {{ nodeStayHours: number, slaHours: number } | null}
 */
export function deriveStaySla(item) {
  const p = item.progressPercent;
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) return null;
  let sla = null;
  if (item.overdueHours > 0) {
    sla = item.overdueHours / (p / 100 - 1);
  } else if (typeof item.remainingHours === "number" && item.remainingHours >= 0 && p < 100) {
    sla = item.remainingHours / (1 - p / 100);
  }
  if (sla === null || !(sla > 0)) return null;
  return { nodeStayHours: round1(sla * (p / 100)), slaHours: round1(sla) };
}

/**
 * 构建展示模型。
 * @param result - analyze_urge_risks 的结构化结果（{ summary, items }）。
 * @param processes - 原始入参的 processes 数组（可选）；缺失时停留/SLA 派生。
 * @returns {{ summaryCells: Array<{key,label,value,tone}>, rows: Array<object> }}
 */
export function buildDisplayModel(result, processes) {
  const s = result.summary;
  const summaryCells = [
    { key: "total", label: "流程总数", value: s.total, tone: "neutral" },
    { key: "red", label: "红色", value: s.redCount, tone: "red" },
    { key: "yellow", label: "黄色", value: s.yellowCount, tone: "yellow" },
    { key: "green", label: "绿色", value: s.greenCount, tone: "green" },
    { key: "urge", label: "应催办", value: s.shouldUrgeCount, tone: "amber" },
    { key: "suppressed", label: "冷却抑制", value: s.suppressedCount, tone: "neutral" },
  ];

  const rows = result.items.map((item, index) => {
    const src = processes !== null && Array.isArray(processes) && index < processes.length ? processes[index] : null;
    const derived = src === null ? deriveStaySla(item) : null;
    const nodeStayHours =
      src !== null && typeof src.nodeStayHours === "number" ? src.nodeStayHours : derived !== null ? derived.nodeStayHours : null;
    const slaHours =
      src !== null && typeof src.slaHours === "number" ? src.slaHours : derived !== null ? derived.slaHours : null;

    const level = item.riskLevel;
    const suppressed = item.suppressedByCooldown === true;

    let highlight;
    let highlightTone;
    if (level === "red") {
      highlight = `超时 ${item.overdueHours} 小时`;
      highlightTone = "red";
    } else if (level === "yellow") {
      highlight = `剩余 ${item.remainingHours} 小时`;
      highlightTone = "yellow";
    } else {
      highlight = `剩余 ${item.remainingHours} 小时`;
      highlightTone = "green";
    }

    return {
      processId: item.processId,
      processName: item.processName,
      currentNode: item.currentNode,
      handler: item.handler,
      nodeStayHours,
      slaHours,
      staySlaDerived: derived !== null,
      level,
      levelLabel: item.riskLabel,
      tone: level,
      highlight,
      highlightTone,
      action: suppressed ? "暂缓重复催办" : item.suggestedAction,
      actionTone: suppressed ? "muted" : level,
      suppressed,
      nextUrgeIn: suppressed ? item.cooldownRemainingHours : null,
    };
  });

  return { summaryCells, rows };
}
