// 催办风险灯 — analyze_urge_risks 客户端渲染（cordis_define 的 code.client）。
// 本文件是「实际提交给浏览器运行时的那段文本」的权威副本：
// 纯 JS、无 import、仅使用 Client 内建（React / ctx.slots），
// 注册 tool.call.toolview 的 analyze_urge_risks key，为该工具调用渲染
// 汇总卡片 + 红黄绿风险列表；专用 UI 不可用时降级为 render 文本。
// 展示映射逻辑（buildDisplayModel 等）与 plugin/display-model.js 语义一致，
// 由 test/dynamic-host.test.js 的 parity 用例矩阵逐分支验证等价。

// ---- 展示映射（纯函数；与 plugin/display-model.js 语义一致） ----
function round1(value) { return Math.round(value * 10) / 10; }

function parseArgsProcesses(argsRaw) {
  if (typeof argsRaw !== "string" || argsRaw.length === 0) return null;
  var parsed;
  try { parsed = JSON.parse(argsRaw); } catch (e) { return null; }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.processes)) return null;
  return parsed.processes;
}

function deriveStaySla(item) {
  var p = item.progressPercent;
  if (typeof p !== "number" || !isFinite(p) || p <= 0) return null;
  var sla = null;
  if (item.overdueHours > 0) sla = item.overdueHours / (p / 100 - 1);
  else if (typeof item.remainingHours === "number" && item.remainingHours >= 0 && p < 100) sla = item.remainingHours / (1 - p / 100);
  if (sla === null || !(sla > 0)) return null;
  return { nodeStayHours: round1(sla * (p / 100)), slaHours: round1(sla) };
}

function buildDisplayModel(result, processes) {
  var s = result.summary;
  var summaryCells = [
    { key: "total", label: "流程总数", value: s.total, tone: "neutral" },
    { key: "red", label: "红色", value: s.redCount, tone: "red" },
    { key: "yellow", label: "黄色", value: s.yellowCount, tone: "yellow" },
    { key: "green", label: "绿色", value: s.greenCount, tone: "green" },
    { key: "urge", label: "应催办", value: s.shouldUrgeCount, tone: "amber" },
    { key: "suppressed", label: "冷却抑制", value: s.suppressedCount, tone: "neutral" }
  ];
  var rows = result.items.map(function (item, index) {
    var src = processes !== null && Array.isArray(processes) && index < processes.length ? processes[index] : null;
    var derived = src === null ? deriveStaySla(item) : null;
    var nodeStayHours = src !== null && typeof src.nodeStayHours === "number" ? src.nodeStayHours : derived !== null ? derived.nodeStayHours : null;
    var slaHours = src !== null && typeof src.slaHours === "number" ? src.slaHours : derived !== null ? derived.slaHours : null;
    var level = item.riskLevel;
    var suppressed = item.suppressedByCooldown === true;
    var highlight, highlightTone;
    if (level === "red") { highlight = "超时 " + item.overdueHours + " 小时"; highlightTone = "red"; }
    else if (level === "yellow") { highlight = "剩余 " + item.remainingHours + " 小时"; highlightTone = "yellow"; }
    else { highlight = "剩余 " + item.remainingHours + " 小时"; highlightTone = "green"; }
    return {
      processId: item.processId,
      processName: item.processName,
      currentNode: item.currentNode,
      handler: item.handler,
      nodeStayHours: nodeStayHours,
      slaHours: slaHours,
      staySlaDerived: derived !== null,
      level: level,
      levelLabel: item.riskLabel,
      tone: level,
      highlight: highlight,
      highlightTone: highlightTone,
      action: suppressed ? "暂缓重复催办" : item.suggestedAction,
      actionTone: suppressed ? "muted" : level,
      suppressed: suppressed,
      nextUrgeIn: suppressed ? item.cooldownRemainingHours : null
    };
  });
  return { summaryCells: summaryCells, rows: rows };
}

// ---- 视觉样式：红/黄/绿三色（明显但克制）+ 琥珀/中性/弱化 ----
var C = {
  red: { text: "#e0524f", bg: "rgba(224, 82, 79, 0.10)", border: "rgba(224, 82, 79, 0.45)" },
  yellow: { text: "#d9a13b", bg: "rgba(217, 161, 59, 0.12)", border: "rgba(217, 161, 59, 0.45)" },
  green: { text: "#57a86c", bg: "rgba(87, 168, 108, 0.10)", border: "rgba(87, 168, 108, 0.45)" },
  amber: { text: "#d9a13b", bg: "rgba(217, 161, 59, 0.14)", border: "rgba(217, 161, 59, 0.5)" },
  muted: { text: "#8a93a5", bg: "rgba(138, 147, 165, 0.10)", border: "rgba(138, 147, 165, 0.45)" },
  neutral: { text: "#9aa4b5", bg: "rgba(138, 147, 165, 0.06)", border: "rgba(138, 147, 165, 0.3)" }
};
var ICON = { red: "🔴", yellow: "🟡", green: "🟢" };
var el = React.createElement;

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(function (b) { return b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string"; })
    .map(function (b) { return b.text; })
    .join("\n");
}

// ---- 主卡片：汇总卡 + 风险列表 ----
function Dashboard(props) {
  var model = props.model;
  return el("div", { style: { padding: "12px 14px" } }, [
    el("div", { key: "h", style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, "催办风险灯"),
    el(SummaryBar, { key: "s", cells: model.summaryCells }),
    el("div", { key: "l", style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 } },
      model.rows.map(function (row) { return el(RiskRow, { key: row.processId, row: row }); }))
  ]);
}

function SummaryBar(props) {
  return el("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
    props.cells.map(function (cell) {
      var c = C[cell.tone];
      return el("div", { key: cell.key, style: {
        display: "flex", alignItems: "center", gap: 6,
        padding: "5px 10px", borderRadius: 8,
        background: c.bg, border: "1px solid " + c.border
      } }, [
        el("span", { key: "v", style: { fontSize: 14, fontWeight: 700, color: c.text } }, String(cell.value)),
        el("span", { key: "l", style: { fontSize: 12, color: c.text, opacity: 0.85 } }, cell.label)
      ]);
    }));
}

function RiskRow(props) {
  var row = props.row;
  var c = C[row.tone];
  var hc = C[row.highlightTone];
  var stay = row.nodeStayHours !== null && row.nodeStayHours !== undefined ? "停留 " + row.nodeStayHours + " 小时" : null;
  var sla = row.slaHours !== null && row.slaHours !== undefined ? "SLA " + row.slaHours + " 小时" : null;
  var metaParts = [row.currentNode, row.handler];
  if (stay !== null) metaParts.push(stay);
  if (sla !== null) metaParts.push(sla);
  var operation = row.suppressed
    ? el("span", { key: "op", style: { fontSize: 12, padding: "2px 9px", borderRadius: 10, background: C.muted.bg, border: "1px solid " + C.muted.border, color: C.muted.text } },
        "暂缓催办 · " + row.nextUrgeIn + " 小时后可再催办")
    : el("span", { key: "op", style: { fontSize: 12, padding: "2px 9px", borderRadius: 10, background: C[row.actionTone].bg, border: "1px solid " + C[row.actionTone].border, color: C[row.actionTone].text } },
        row.action);
  return el("div", { style: {
    display: "flex", alignItems: "center", gap: 12,
    border: "1px solid " + c.border, borderLeft: "4px solid " + c.text,
    borderRadius: 8, padding: "8px 12px", background: c.bg
  } }, [
    el("div", { key: "info", style: { flex: 1, minWidth: 0 } }, [
      el("div", { key: "t", style: { display: "flex", alignItems: "center", gap: 8 } }, [
        el("span", { key: "n", style: { fontSize: 13, fontWeight: 600 } }, row.processName),
        el("span", { key: "i", style: { fontSize: 11, color: C.neutral.text } }, row.processId),
        el("span", { key: "b", style: { fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 10, background: c.bg, border: "1px solid " + c.border, color: c.text } },
          ICON[row.level] + " " + row.levelLabel)
      ]),
      el("div", { key: "m", style: { fontSize: 12, opacity: 0.72, marginTop: 3 } }, metaParts.join(" · "))
    ]),
    el("div", { key: "side", style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 } }, [
      el("span", { key: "hl", style: { fontSize: 13, fontWeight: 700, color: hc.text } }, row.highlight),
      operation
    ])
  ]);
}

// ---- toolview 入口：解析 block（运行中 / 结果 / 错误），降级链 ----
function UrgeRiskToolview(props) {
  var block = props.block;
  var isObject = block !== null && typeof block === "object";
  var settled = isObject && block.kind === "tool-result";
  if (!settled) {
    var runningText = isObject && block.isError ? "analyze_urge_risks 执行出错" : "催办风险灯 · 分析中…";
    return el("div", { style: { padding: "10px 12px", fontSize: 13, color: C.neutral.text } }, runningText);
  }
  if (block.isError || block.meta === null || typeof block.meta !== "object" ||
      !block.meta.summary || !Array.isArray(block.meta.items)) {
    var text = contentText(block.content);
    return el("div", { style: { padding: "10px 12px", fontSize: 13, whiteSpace: "pre-wrap", color: C.neutral.text } },
      text.length > 0 ? text : "analyze_urge_risks 结果不可用");
  }
  var processes = parseArgsProcesses(block.call !== null && block.call !== undefined ? block.call.argsRaw : null);
  var model = buildDisplayModel(block.meta, processes);
  return el(Dashboard, { model: model });
}

// ---- 插件：注册 tool.call.toolview 的 analyze_urge_risks key ----
var UrgeRiskToolviewPlugin = {
  name: "urge-risk-toolview",
  inject: ["slots"],
  apply: function (ctx) {
    return ctx.slots.inject("tool.call.toolview", function () {
      return ctx.slots.register({
        name: "tool.call.toolview",
        key: "analyze_urge_risks"
      }, UrgeRiskToolview);
    });
  }
};
return UrgeRiskToolviewPlugin;
