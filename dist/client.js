// 催办风险灯 — 持久化 Client 模块（classic script，由 web 运行时经
// window.__ModuleLoader__.load 注册工厂后装载；graph id = 'urge-risk-light'）。
//
// 职责：
// 1. tool.call.toolview 的 analyze_urge_risks key —— 工具结果卡片（会话内渲染）；
// 2. shell.overlay 的 urge-risk-light id —— 右下角常驻悬浮组件（全局渲染）；
// 3. 两者通过模块闭包内的共享 store 通信：卡片在「新结果」到达时把
//    analyze_urge_risks 的结构化输出（block.meta，presentationMeta 透出）原样
//    写入 store，悬浮组件订阅展示。客户端不重新计算任何业务规则。
//
// 更新语义：仅投递 block.time >= 页面启动时刻的新结果（历史重放不触发）；
// 调用失败（isError）保留上一次成功结果并标记“本次更新失败”；
// 不轮询、不请求网络。
window.__ModuleLoader__.load({
	id: "dsh-urge-risk-light",
	factory: (require) => {
		var React = require("react");
		var el = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;
		var useSyncExternalStore = React.useSyncExternalStore;

		// ── 展示映射（与 plugin/display-model.js 语义一致，parity 测试覆盖） ──
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
					processId: item.processId, processName: item.processName,
					currentNode: item.currentNode, handler: item.handler,
					nodeStayHours: nodeStayHours, slaHours: slaHours, staySlaDerived: derived !== null,
					level: level, levelLabel: item.riskLabel, tone: level,
					highlight: highlight, highlightTone: highlightTone,
					action: suppressed ? "暂缓重复催办" : item.suggestedAction,
					actionTone: suppressed ? "muted" : level,
					suppressed: suppressed, nextUrgeIn: suppressed ? item.cooldownRemainingHours : null
				};
			});
			return { summaryCells: summaryCells, rows: rows };
		}

		// ── 悬浮组件状态模型（与 plugin/widget-model.js 语义一致） ──
		function redUrgeCount(meta) {
			if (meta === null || typeof meta !== "object" || !Array.isArray(meta.items)) return 0;
			return meta.items.filter(function (item) { return item.riskLevel === "red" && item.shouldUrge === true; }).length;
		}
		function createWidgetState() { return { result: null, failed: false, failedAt: null, updatedAt: null, rev: 0 }; }
		function applyResult(state, meta) {
			return { result: meta, failed: false, failedAt: null, updatedAt: Date.now(), rev: state.rev + 1 };
		}
		function applyFailure(state, at) {
			return { result: state.result, failed: true, failedAt: at, updatedAt: at, rev: state.rev + 1 };
		}
		function collapsedModel(state) {
			var result = state.result;
			var counts = result !== null && typeof result === "object" && result.summary
				? { red: result.summary.redCount, yellow: result.summary.yellowCount, green: result.summary.greenCount, urge: result.summary.shouldUrgeCount }
				: null;
			return {
				name: "催办风险灯",
				counts: counts,
				urgeText: counts === null ? null : "需催办 " + counts.urge,
				empty: counts === null,
				failed: state.failed === true
			};
		}
		function expandedModel(state) {
			var result = state.result;
			if (result === null || typeof result !== "object") return null;
			var model = buildDisplayModel(result, null);
			return { cells: model.summaryCells, rows: model.rows, failed: state.failed === true };
		}
		function shouldHighlight(prev, next) {
			if (next === null || next.result === null) return false;
			if (prev === null || prev.result === null) return true;
			return redUrgeCount(next.result) > redUrgeCount(prev.result);
		}

		// ── 共享 store（模块闭包，页面生命周期；不落盘） ──
		var bootTime = Date.now();
		var storeState = createWidgetState();
		var listeners = new Set();
		var lastPushed = null;
		function getSnapshot() { return storeState; }
		function setState(next) { storeState = next; listeners.forEach(function (fn) { fn(); }); }
		function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }
		/** 仅投递本页加载后的新结果；错误结果保留上次成功并标记失败。 */
		function feed(block) {
			if (block === null || typeof block !== "object" || block.kind !== "tool-result") return;
			if (typeof block.time !== "number" || block.time < bootTime) return;
			var key = String(block.callId) + ":" + String(block.seq);
			if (key === lastPushed) return;
			lastPushed = key;
			if (block.isError === true || block.meta === null || typeof block.meta !== "object" ||
				!block.meta.summary || !Array.isArray(block.meta.items)) {
				setState(applyFailure(getSnapshot(), block.time));
				return;
			}
			setState(applyResult(getSnapshot(), block.meta));
		}

		// ── 视觉调色（明显但克制；深浅主题均可读） ──
		var C = {
			red: { text: "#e0524f", bg: "rgba(224, 82, 79, 0.10)", border: "rgba(224, 82, 79, 0.45)" },
			yellow: { text: "#d9a13b", bg: "rgba(217, 161, 59, 0.12)", border: "rgba(217, 161, 59, 0.45)" },
			green: { text: "#57a86c", bg: "rgba(87, 168, 108, 0.10)", border: "rgba(87, 168, 108, 0.45)" },
			amber: { text: "#d9a13b", bg: "rgba(217, 161, 59, 0.14)", border: "rgba(217, 161, 59, 0.5)" },
			muted: { text: "#8a93a5", bg: "rgba(138, 147, 165, 0.10)", border: "rgba(138, 147, 165, 0.45)" },
			neutral: { text: "#9aa4b5", bg: "rgba(138, 147, 165, 0.06)", border: "rgba(138, 147, 165, 0.3)" }
		};
		var ICON = { red: "🔴", yellow: "🟡", green: "🟢" };

		function contentText(content) {
			if (!Array.isArray(content)) return "";
			return content
				.filter(function (b) { return b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string"; })
				.map(function (b) { return b.text; })
				.join("\n");
		}

		// ── 结果卡片（tool.call.toolview） ──
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
		function CardDashboard(props) {
			var model = props.model;
			return el("div", { style: { padding: "12px 14px" } }, [
				el("div", { key: "h", style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, "催办风险灯"),
				el(SummaryBar, { key: "s", cells: model.summaryCells }),
				el("div", { key: "l", style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 } },
					model.rows.map(function (row) { return el(RiskRow, { key: row.processId, row: row }); }))
			]);
		}
		function Toolview(props) {
			var block = props.block;
			var isObject = block !== null && typeof block === "object";
			var settled = isObject && block.kind === "tool-result";
			useEffect(function () {
				if (settled) feed(block);
			}, [settled, block]);
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
			return el(CardDashboard, { model: model });
		}

		// ── 右下角悬浮组件（shell.overlay） ──
		function FloatingWidget(props) {
			var state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
			var openState = useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var flashState = useState(false);
			var flash = flashState[0];
			var setFlash = flashState[1];
			var prevRef = useRef(null);
			useEffect(function () {
				var prev = prevRef.current;
				prevRef.current = state;
				if (shouldHighlight(prev, state)) {
					setFlash(true);
					var timer = setTimeout(function () { setFlash(false); }, 1800);
					return function () { clearTimeout(timer); };
				}
				return undefined;
			}, [state]);
			var m = collapsedModel(state);
			if (!open) {
				return el("div", {
					onClick: function () { setOpen(true); },
					style: pillStyle(flash, m.failed),
					role: "button",
					title: "催办风险灯 · 点击展开",
					"aria-label": "催办风险灯"
				}, [
					el("span", { key: "n", style: { fontSize: 12, fontWeight: 600 } }, m.name),
					m.empty
						? el("span", { key: "e", style: { fontSize: 11, color: C.neutral.text } }, "尚未分析")
						: el("span", { key: "c", style: { fontSize: 12, fontWeight: 600, color: C.neutral.text } },
							"🔴" + m.counts.red + " 🟡" + m.counts.yellow + " 🟢" + m.counts.green + " · " + m.urgeText),
					m.failed ? el("span", { key: "f", style: { fontSize: 10, padding: "1px 6px", borderRadius: 8, background: C.yellow.bg, border: "1px solid " + C.yellow.border, color: C.yellow.text } }, "本次更新失败") : null
				]);
			}
			var ex = expandedModel(state);
			return el("div", { style: panelStyle(flash) }, [
				el("div", { key: "h", style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, cursor: "pointer" },
					onClick: function () { setOpen(false); } }, [
					el("span", { key: "n", style: { fontSize: 13, fontWeight: 600 } }, "催办风险灯"),
					el("span", { key: "x", style: { fontSize: 11, color: C.neutral.text } }, "点击收起")
				]),
				ex === null
					? el("div", { key: "e", style: { fontSize: 12, color: C.neutral.text, padding: "4px 2px" } }, "尚未分析")
					: [
						ex.failed
							? el("div", { key: "f", style: { fontSize: 11, padding: "3px 8px", borderRadius: 8, background: C.yellow.bg, border: "1px solid " + C.yellow.border, color: C.yellow.text, marginBottom: 8 } }, "本次更新失败 · 以下为最近一次成功结果")
							: null,
						el(SummaryBar, { key: "s", cells: ex.cells }),
						el("div", { key: "l", style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 } },
							ex.rows.map(function (row) { return el(RiskRow, { key: row.processId, row: row }); }))
					]
			]);
		}
		function pillStyle(flash, failed) {
			return {
				position: "absolute", right: 16, bottom: 16,
				display: "flex", alignItems: "center", gap: 8,
				padding: "8px 12px", borderRadius: 12,
				background: "rgba(30, 32, 40, 0.86)",
				border: "1px solid " + (failed ? C.yellow.border : C.neutral.border),
				color: "#e8eaef", cursor: "pointer", userSelect: "none",
				boxShadow: flash ? "0 0 0 3px rgba(224, 82, 79, 0.35)" : "0 2px 10px rgba(0, 0, 0, 0.25)",
				transition: "box-shadow 0.4s ease"
			};
		}
		function panelStyle(flash) {
			return {
				position: "absolute", right: 16, bottom: 16,
				width: 380, maxHeight: "62vh", overflowY: "auto",
				padding: "12px 14px", borderRadius: 14,
				background: "rgba(30, 32, 40, 0.94)",
				border: "1px solid " + C.neutral.border,
				boxShadow: flash ? "0 0 0 3px rgba(224, 82, 79, 0.35)" : "0 4px 20px rgba(0, 0, 0, 0.35)",
				transition: "box-shadow 0.4s ease",
				color: "#e8eaef"
			};
		}

		// ── 插件：注册结果卡片 + 悬浮组件 ──
		var urgeRiskUiPlugin = {
			name: "dsh-urge-risk-light-ui",
			inject: ["slots"],
			apply: function (ctx) {
				var disposeCard = ctx.slots.inject("tool.call.toolview", function () {
					return ctx.slots.register({
						name: "tool.call.toolview",
						key: "analyze_urge_risks"
					}, Toolview);
				});
				var disposeWidget = ctx.slots.inject("shell.overlay", function () {
					return ctx.slots.register({
						name: "shell.overlay",
						id: "dsh-urge-risk-light",
						order: 100,
						label: "催办风险灯"
					}, FloatingWidget);
				});
				return function () {
					disposeCard();
					disposeWidget();
				};
			}
		};
		// 测试缝：仅测试使用，暴露 store 与纯函数，便于 parity 与集成测试。
		urgeRiskUiPlugin.__test = {
			feed: feed,
			getSnapshot: getSnapshot,
			setState: setState,
			fns: {
				round1: round1,
				parseArgsProcesses: parseArgsProcesses,
				deriveStaySla: deriveStaySla,
				buildDisplayModel: buildDisplayModel,
				redUrgeCount: redUrgeCount,
				createWidgetState: createWidgetState,
				applyResult: applyResult,
				applyFailure: applyFailure,
				collapsedModel: collapsedModel,
				expandedModel: expandedModel,
				shouldHighlight: shouldHighlight
			}
		};
		return urgeRiskUiPlugin;
	}
});
