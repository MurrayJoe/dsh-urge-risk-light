/**
 * 动态宿主 + Schema + Client 渲染测试：
 * 1. HOST_BODY（cordis_define 的 code.host）在 node:vm 沙箱中可执行，
 *    返回的插件 apply(ctx) 通过 harness.registerTool 注册工具；
 * 2. 注册的工具 execute/render 可用，且结果与 lib/index.js 完全一致
 *    （证明「运行时执行的逻辑」=「单元测试覆盖的逻辑」，无复制漂移）；
 * 3. 参数/输出 Schema 通过官方 @deepseek-ai/dsh-tools 编译器与校验器；
 * 4. code.client（runtime-client-body.raw.js）在 vm 沙箱中注册
 *    tool.call.toolview 的 analyze_urge_risks key，并用真实 React
 *    （renderToStaticMarkup）验证渲染输出与降级链；
 * 5. client 内联的展示映射与 plugin/display-model.js 逐分支等价。
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HOST_BODY } from "../plugin/host-body.js";
import { analyzeUrgeRisks, validateProcesses } from "../lib/index.js";
import { PARAMETERS, OUTPUT_SCHEMA } from "../plugin/tool-definition.js";
import { buildDisplayModel, parseArgsProcesses, deriveStaySla } from "../plugin/display-model.js";
import {
  defineTool,
  parameterSchemaSpecToJsonSchema,
  valueSchemaSpecToJsonSchema,
  validateJsonSchemaValue,
} from "@deepseek-ai/dsh-tools";
import { DEMO } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

test("HOST_BODY 内联的纯逻辑与 lib/index.js 是同一份代码", () => {
  const libSource = readFileSync(join(root, "lib", "index.js"), "utf8");
  const stripped = libSource.replace(/^export\s+/gm, "");
  assert.ok(HOST_BODY.includes(stripped), "HOST_BODY 必须原样包含剥离 export 后的 lib/index.js");
});

test("参数与输出 Schema 通过官方 DSL 编译器（含 defineTool 全路径）", () => {
  assert.doesNotThrow(() => parameterSchemaSpecToJsonSchema(PARAMETERS));
  assert.doesNotThrow(() => valueSchemaSpecToJsonSchema(OUTPUT_SCHEMA));
  assert.doesNotThrow(() =>
    defineTool({
      name: "analyze_urge_risks",
      description: "test",
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: () => [{ type: "text", text: "" }],
      },
      execute: async () => ({}),
    }),
  );
});

test("Schema 校验：演示数据通过，未知字段被拒绝；空数组由业务校验拒绝", () => {
  const compiledParams = parameterSchemaSpecToJsonSchema(PARAMETERS);
  assert.deepEqual(validateJsonSchemaValue(compiledParams, { processes: DEMO }, ""), []);
  // 注：JSON Schema 子集不支持 minItems，空数组在 schema 层通过，
  // 由工具 execute 的业务校验（validateProcesses）抛出清晰错误——见 VM 执行测试。
  const extraViolations = validateJsonSchemaValue(
    compiledParams,
    { processes: [{ ...DEMO[0], extraField: 1 }] },
    "",
  );
  assert.ok(extraViolations.length > 0, "未知字段（additionalProperties=false）应被拒绝");
  const compiledOutput = valueSchemaSpecToJsonSchema(OUTPUT_SCHEMA);
  assert.deepEqual(
    validateJsonSchemaValue(compiledOutput, analyzeUrgeRisks(DEMO), ""),
    [],
  );
});

test("HOST_BODY 在 vm 沙箱中执行并注册工具，结果与 lib 一致", async () => {
  const captured = { tool: null, ctx: null, disposer: null };
  const fakeHarness = {
    defineTool(options) {
      captured.rawOptions = options;
      return options;
    },
    registerTool(ctx, tool) {
      captured.ctx = ctx;
      captured.tool = tool;
      captured.disposer = () => {
        captured.disposed = true;
      };
      return captured.disposer;
    },
  };
  const sandbox = { harness: fakeHarness, console };
  vm.createContext(sandbox);
  const plugin = await vm.runInContext(`(async () => {\n${HOST_BODY}\n})()`, sandbox);

  assert.equal(typeof plugin, "object", "宿主代码应返回插件对象");
  assert.equal(typeof plugin.apply, "function", "插件应提供 apply(ctx)");

  // 模拟运行：apply(ctx) 返回 disposer
  const disposer = plugin.apply({ fake: true });
  assert.equal(typeof disposer, "function", "apply 应返回注册 disposer");
  assert.ok(captured.tool, "harness.registerTool 应收到工具定义");
  assert.equal(captured.tool.name, "analyze_urge_risks");

  const tool = captured.tool;

  // 合法输入：与 lib 结果深度一致（JSON 归一化，规避 VM 域原型差异）
  const result = await tool.execute({ processes: DEMO }, {});
  assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(analyzeUrgeRisks(DEMO))));

  // 非法输入：抛出的错误消息与 lib 一致
  await assert.rejects(() => tool.execute({ processes: [] }, {}), (error) => {
    assert.match(error.message, /processes 为空数组/);
    return true;
  });
  await assert.rejects(() => tool.execute({ processes: [{ processId: "X" }] }, {}), (error) => {
    assert.match(error.message, /参数校验失败/);
    assert.match(error.message, /processName 必填/);
    return true;
  });

  // render 返回 content block 数组（Markdown 表格降级展示）
  const blocks = tool.output.render({ processes: DEMO }, result);
  assert.ok(Array.isArray(blocks) && blocks.length === 1);
  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text, /催办风险分析结果（共 4 条）/);
  assert.match(blocks[0].text, /\| 流程 \| 节点 \| 处理人 \| 风险等级 \| 进度 \| 剩余\/超时 \| 本次操作 \|/);
  assert.match(blocks[0].text, /🔴 超时/);
  assert.match(blocks[0].text, /🟡 临期/);
  assert.match(blocks[0].text, /🟢 正常/);
  // P004：风险等级列仍为 🔴 超时，本次操作列显示冷却抑制（两列语义分离）
  assert.match(blocks[0].text, /\| 🔴 超时 \| 150% \| 超时 12 小时 \| 暂缓重复催办（冷却中，2 小时后可再催） \|/);

  // presentationMeta 透出结构化结果
  assert.deepEqual(tool.output.presentationMeta({ processes: DEMO }, result), result);
});

test("运行时宿主代码（runtime-host-body.raw.js）与 lib 逐分支等价", async () => {
  const runtimeBody = readFileSync(join(root, "plugin", "runtime-host-body.raw.js"), "utf8");
  const captured = { tool: null };
  const fakeHarness = {
    defineTool(options) {
      captured.rawOptions = options;
      return options;
    },
    registerTool(ctx, tool) {
      captured.tool = tool;
      return () => {};
    },
  };
  const sandbox = { harness: fakeHarness, console };
  vm.createContext(sandbox);
  const plugin = await vm.runInContext(`(async () => {\n${runtimeBody}\n})()`, sandbox);
  assert.equal(typeof plugin.apply, "function");
  plugin.apply({});
  const tool = captured.tool;
  assert.equal(tool.name, "analyze_urge_risks");

  // 运行时宿主代码中的 schema 必须与 tool-definition.js（已通过官方编译器校验）一致
  assert.deepEqual(
    JSON.parse(JSON.stringify(captured.rawOptions.parameters)),
    JSON.parse(JSON.stringify(PARAMETERS)),
    "runtime 参数 schema 与 tool-definition.js 一致",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(captured.rawOptions.output.schema)),
    JSON.parse(JSON.stringify(OUTPUT_SCHEMA)),
    "runtime 输出 schema 与 tool-definition.js 一致",
  );

  const base = (overrides) => ({
    processId: "T001",
    processName: "测试流程",
    currentNode: "测试节点",
    handler: "测试人",
    nodeStayHours: 10,
    slaHours: 24,
    ...overrides,
  });

  // 合法输入矩阵：覆盖三档等级、0.8 边界、恰好超时、冷却各分支、汇总
  const validCases = [
    DEMO,
    [base({})],
    [base({ nodeStayHours: 19.2 })], // 恰好 0.8×SLA → 黄
    [base({ nodeStayHours: 19.19 })], // 略低于 0.8×SLA → 绿
    [base({ nodeStayHours: 24 })], // 恰好 SLA → 红，超时 0
    [base({ nodeStayHours: 23.999 })], // 略低于 SLA → 黄
    [base({ nodeStayHours: 30, lastUrgedHoursAgo: 3.99 })], // 冷却抑制，剩 0.01
    [base({ nodeStayHours: 30, lastUrgedHoursAgo: 4 })], // 恰 4 小时 → 不抑制
    [base({ nodeStayHours: 30, lastUrgedHoursAgo: 0 })], // 冷却，剩 4
    [base({ nodeStayHours: 8, lastUrgedHoursAgo: 1 })], // 绿 + 冷却覆盖
    [
      base({ processId: "A1", nodeStayHours: 30 }),
      base({ processId: "A2", nodeStayHours: 20 }),
      base({ processId: "A3", nodeStayHours: 8 }),
      base({ processId: "A4", nodeStayHours: 30, lastUrgedHoursAgo: 1 }),
      base({ processId: "A5", nodeStayHours: 20, lastUrgedHoursAgo: 2 }),
    ],
  ];
  for (const input of validCases) {
    const runtimeResult = await tool.execute({ processes: input }, {});
    const libResult = analyzeUrgeRisks(input);
    assert.deepEqual(
      JSON.parse(JSON.stringify(runtimeResult)),
      JSON.parse(JSON.stringify(libResult)),
      `execute 结果与 lib 一致 (${JSON.stringify(input)})`,
    );
  }

  // 非法输入矩阵：错误消息必须与 lib 一致
  const invalidCases = [
    [],
    "not-an-array",
    [42],
    [{ processId: "P1" }],
    [base({ handler: "" })],
    [base({ nodeStayHours: -1 })],
    [base({ slaHours: 0 })],
    [base({ slaHours: -5 })],
    [base({ lastUrgedHoursAgo: -0.5 })],
    [base({ nodeStayHours: "30" })],
    [base({ nodeStayHours: Number.NaN })],
    [base({ nodeStayHours: Number.POSITIVE_INFINITY })],
    [base({ slaHours: "24" })],
    [base({ processId: "  " })],
    [base({ nodeStayHours: -1, slaHours: 0 })],
  ];
  for (const input of invalidCases) {
    const libError = (() => {
      try {
        analyzeUrgeRisks(input);
        return null;
      } catch (error) {
        return error.message;
      }
    })();
    assert.ok(libError, `lib 应抛错 (${JSON.stringify(input)})`);
    await assert.rejects(() => tool.execute({ processes: input }, {}), (error) => {
      assert.equal(error.message, libError, `错误消息一致 (${JSON.stringify(input)})`);
      return true;
    });
  }

  // render 输出与 lib 结果一致
  const demoResult = await tool.execute({ processes: DEMO }, {});
  const blocks = tool.output.render({ processes: DEMO }, demoResult);
  assert.ok(Array.isArray(blocks) && blocks[0].type === "text");
  assert.match(blocks[0].text, /🔴 超时/);
  assert.match(blocks[0].text, /🟡 临期/);
  assert.match(blocks[0].text, /🟢 正常/);
  assert.match(blocks[0].text, /冷却抑制 1/);
});

test("内联逻辑（剥离 export 后）与 lib 在错误路径上也一致", () => {
  const libSource = readFileSync(join(root, "lib", "index.js"), "utf8");
  const stripped = libSource.replace(/^export\s+/gm, "");
  const sandbox = { console };
  vm.createContext(sandbox);
  const exportsHolder = {};
  vm.runInContext(
    `${stripped}\n; this.__exports = { validateProcesses, classifyProcess, analyzeUrgeRisks };`,
    sandbox,
  );
  const inlined = sandbox.__exports;

  const cases = [
    DEMO,
    [],
    "not-an-array",
    [{ processId: "P1" }],
    [{ processId: "P1", processName: "n", currentNode: "c", handler: "h", nodeStayHours: -1, slaHours: 24 }],
    [{ processId: "P1", processName: "n", currentNode: "c", handler: "h", nodeStayHours: 10, slaHours: 0 }],
    [{ processId: "P1", processName: "n", currentNode: "c", handler: "h", nodeStayHours: 10, slaHours: 24, lastUrgedHoursAgo: -2 }],
    [42],
  ];
  for (const input of cases) {
    // 注意：VM 隔离域数组的原型与宿主不同，deepStrictEqual 会因原型不匹配失败，
    // 因此先做 JSON 归一化再比较内容。
    assert.deepEqual(
      JSON.parse(JSON.stringify(inlined.validateProcesses(input))),
      JSON.parse(JSON.stringify(validateProcesses(input))),
      `validateProcesses(${JSON.stringify(input)})`,
    );
    if (Array.isArray(input) && input.length > 0 && typeof input[0] === "object") {
      const libError = (() => {
        try {
          analyzeUrgeRisks(input);
          return null;
        } catch (error) {
          return error.message;
        }
      })();
      const vmError = (() => {
        try {
          inlined.analyzeUrgeRisks(input);
          return null;
        } catch (error) {
          return error.message;
        }
      })();
      assert.equal(vmError, libError, `analyzeUrgeRisks 错误消息一致 (${JSON.stringify(input)})`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 以下为 Client half 测试：runtime-client-body.raw.js（code.client）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造一个已结算的工具结果 block（形状参照 ui-conversation 的 tool-result 投影）。 */
function settledBlock(overrides) {
  return {
    kind: "tool-result",
    callId: "call-1",
    call: { name: "analyze_urge_risks", argsRaw: JSON.stringify({ processes: DEMO }) },
    content: [{ type: "text", text: "催办风险分析结果（共 4 条）…" }],
    isError: false,
    meta: analyzeUrgeRisks(DEMO),
    callView: null,
    resultView: null,
    subCalls: [],
    ...overrides,
  };
}

/** 在 vm 中执行 code.client，注册 toolview，返回 { plugin, registered, component }。 */
function loadClientBody(clientSource) {
  const registered = {};
  const fakeCtx = {
    slots: {
      inject(key, callback) {
        registered.injectKey = key;
        const disposer = callback();
        registered.disposer = disposer;
        return disposer;
      },
      register(options, component) {
        registered.options = options;
        registered.component = component;
        return () => {};
      },
    },
  };
  const sandbox = { React, console };
  vm.createContext(sandbox);
  return {
    pluginPromise: vm.runInContext(`(async () => {\n${clientSource}\n})()`, sandbox),
    fakeCtx,
    registered,
  };
}

test("code.client：注册 tool.call.toolview 的 analyze_urge_risks key", async () => {
  const clientSource = readFileSync(join(root, "plugin", "runtime-client-body.raw.js"), "utf8");
  const { pluginPromise, fakeCtx, registered } = loadClientBody(clientSource);
  const plugin = await pluginPromise;
  assert.equal(typeof plugin, "object");
  assert.equal(plugin.name, "urge-risk-toolview");
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.inject)), ["slots"]);
  assert.equal(typeof plugin.apply, "function");
  plugin.apply(fakeCtx);
  assert.equal(registered.injectKey, "tool.call.toolview");
  assert.deepEqual(
    JSON.parse(JSON.stringify(registered.options)),
    { name: "tool.call.toolview", key: "analyze_urge_risks" },
  );
  assert.equal(typeof registered.component, "function");
});

test("code.client：渲染汇总卡与四行风险列表，P004 双状态分离", async () => {
  const clientSource = readFileSync(join(root, "plugin", "runtime-client-body.raw.js"), "utf8");
  const { pluginPromise, fakeCtx, registered } = loadClientBody(clientSource);
  const plugin = await pluginPromise;
  plugin.apply(fakeCtx);

  const html = renderToStaticMarkup(
    React.createElement(registered.component, {
      callId: "call-1",
      toolName: "analyze_urge_risks",
      block: settledBlock(),
      openFile: () => {},
      cwd: undefined,
      inspect: undefined,
    }),
  );

  // 汇总卡：标题 + 6 格
  assert.match(html, /催办风险灯/);
  for (const label of ["流程总数", "红色", "黄色", "绿色", "应催办", "冷却抑制"]) {
    assert.ok(html.includes(label), `汇总卡应包含「${label}」`);
  }

  // 行：流程名称、节点、处理人、停留、SLA、风险徽章、突出指标、动作
  assert.ok(html.includes("员工证明审批"));
  assert.ok(html.includes("部门负责人审批"));
  assert.ok(html.includes("张三"));
  assert.ok(html.includes("停留 30 小时"));
  assert.ok(html.includes("SLA 24 小时"));
  assert.ok(html.includes("超时 6 小时")); // P001 突出超时小时数
  assert.ok(html.includes("提前提醒")); // P002 动作
  assert.ok(html.includes("剩余 4 小时")); // P002 突出剩余小时数
  assert.ok(html.includes("剩余 16 小时")); // P003 弱提示

  // P004 双状态：风险等级徽章仍为 🔴 超时 + 本次操作冷却抑制（可再催 2 小时后）
  assert.ok(html.includes("🔴 超时"));
  assert.ok(html.includes("超时 12 小时"));
  assert.ok(html.includes("暂缓催办 · 2 小时后可再催办")); // 冷却中显示“暂缓催办”与可再催时间
});

test("code.client：运行中 / 错误 / meta 缺失均走降级展示", async () => {
  const clientSource = readFileSync(join(root, "plugin", "runtime-client-body.raw.js"), "utf8");
  const { pluginPromise, fakeCtx, registered } = loadClientBody(clientSource);
  const plugin = await pluginPromise;
  plugin.apply(fakeCtx);
  const render = (block) =>
    renderToStaticMarkup(
      React.createElement(registered.component, { callId: "c", toolName: "analyze_urge_risks", block, openFile: () => {} }),
    );

  // 运行中（无 kind）→ 分析中…
  const runningHtml = render({ callId: "c", name: "analyze_urge_risks", argsRaw: "{}" });
  assert.match(runningHtml, /分析中…/);

  // 出错（已结算）→ 降级展示错误文本内容
  const errorHtml = render(
    settledBlock({ isError: true, content: [{ type: "text", text: "analyze_urge_risks 执行出错：参数校验失败" }] }),
  );
  assert.ok(errorHtml.includes("参数校验失败"));

  // meta 缺失 → 降级为 render 文本
  const noMetaHtml = render(settledBlock({ meta: null }));
  assert.ok(noMetaHtml.includes("催办风险分析结果（共 4 条）…"));
});

test("code.client：内联展示映射与 plugin/display-model.js 逐分支等价", async () => {
  const clientSource = readFileSync(join(root, "plugin", "runtime-client-body.raw.js"), "utf8");
  // 在最终 return 之前注入导出，取到沙箱内的展示函数
  const exposed = clientSource.replace(
    /return UrgeRiskToolviewPlugin;/,
    "this.__display = { round1, parseArgsProcesses, deriveStaySla, buildDisplayModel };\nreturn UrgeRiskToolviewPlugin;",
  );
  const sandbox = { React, console };
  vm.createContext(sandbox);
  await vm.runInContext(`(async () => {\n${exposed}\n})()`, sandbox);
  const inlined = sandbox.__display;
  assert.ok(inlined && typeof inlined.buildDisplayModel === "function");

  const normalize = (value) => JSON.parse(JSON.stringify(value));
  const result = analyzeUrgeRisks(DEMO);
  const cases = [
    [result, DEMO],
    [result, null],
    [result, DEMO.slice(0, 2)],
    [result, []],
  ];
  for (const [res, processes] of cases) {
    assert.deepEqual(
      normalize(inlined.buildDisplayModel(res, processes)),
      normalize(buildDisplayModel(res, processes)),
      `buildDisplayModel(${JSON.stringify(processes)?.slice(0, 60)})`,
    );
  }
  for (const raw of [JSON.stringify({ processes: DEMO }), "{}", "", "bad", null, undefined]) {
    assert.deepEqual(normalize(inlined.parseArgsProcesses(raw)), normalize(parseArgsProcesses(raw)));
  }
  const item = result.items[3]; // P004
  assert.deepEqual(normalize(inlined.deriveStaySla(item)), normalize(deriveStaySla(item)));
  assert.deepEqual(normalize(inlined.deriveStaySla({ progressPercent: 100, overdueHours: 0, remainingHours: 0 })), normalize(deriveStaySla({ progressPercent: 100, overdueHours: 0, remainingHours: 0 })));
});

// ─────────────────────────────────────────────────────────────────────────────
// 以下为持久化 Client 模块（dist/client.js）测试：VM 装载、SSR、jsdom 集成、parity
// ─────────────────────────────────────────────────────────────────────────────
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  createWidgetState,
  applyResult,
  applyFailure,
  shouldHighlight as moduleShouldHighlight,
  collapsedModel as moduleCollapsedModel,
  expandedModel as moduleExpandedModel,
} from "../plugin/widget-model.js";
import {
  buildDisplayModel as moduleBuildDisplayModel,
  parseArgsProcesses as moduleParseArgsProcesses,
  deriveStaySla as moduleDeriveStaySla,
} from "../plugin/display-model.js";

/** 在 VM 中装载 dist/client.js，返回 { plugin, registered }。 */
function loadClientBundle() {
  const source = readFileSync(join(root, "dist", "client.js"), "utf8");
  let handoff = null;
  const registered = { toolview: null, widget: null };
  const sandbox = {
    console,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    window: {
      __ModuleLoader__: {
        load(h) {
          handoff = h;
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.ok(handoff, "bundle 必须调用 __ModuleLoader__.load");
  assert.equal(handoff.id, "dsh-urge-risk-light", "bundle id 必须等于包名（graph id = 行名）");
  const plugin = handoff.factory((spec) => {
    if (spec === "react") return React;
    throw new Error(`unexpected require("${spec}")`);
  });
  const fakeCtx = {
    slots: {
      inject(key, callback) {
        return callback();
      },
      register(options, component) {
        if (options.name === "tool.call.toolview") registered.toolview = component;
        if (options.name === "shell.overlay") registered.widget = component;
        return () => {};
      },
    },
  };
  plugin.apply(fakeCtx);
  return { plugin, registered };
}

function widgetBlock(overrides) {
  return {
    kind: "tool-result",
    callId: "call-w1",
    seq: 101,
    time: Date.now(),
    call: { name: "analyze_urge_risks", argsRaw: JSON.stringify({ processes: DEMO }) },
    content: [],
    isError: false,
    meta: analyzeUrgeRisks(DEMO),
    ...overrides,
  };
}

test("持久 bundle：注册 id=urge-risk-light，插件注册卡片与悬浮组件两个槽位", () => {
  const { plugin, registered } = loadClientBundle();
  assert.equal(typeof plugin, "object");
  assert.equal(plugin.name, "dsh-urge-risk-light-ui");
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.inject)), ["slots"]);
  assert.equal(typeof plugin.apply, "function");
  assert.equal(typeof registered.toolview, "function", "应注册 tool.call.toolview 组件");
  assert.equal(typeof registered.widget, "function", "应注册 shell.overlay 组件");
  assert.ok(plugin.__test && typeof plugin.__test.feed === "function", "测试缝应暴露 feed");
});

test("持久 bundle：悬浮组件 SSR —— 空态「尚未分析」、有结果显示计数", () => {
  const { plugin, registered } = loadClientBundle();
  // 空态
  let html = renderToStaticMarkup(React.createElement(registered.widget, {}));
  assert.ok(html.includes("催办风险灯"));
  assert.ok(html.includes("尚未分析"));
  // 投递演示结果
  act(() => {
    plugin.__test.setState(applyResult(plugin.__test.getSnapshot(), analyzeUrgeRisks(DEMO)));
  });
  html = renderToStaticMarkup(React.createElement(registered.widget, {}));
  assert.ok(html.includes("🔴2 🟡1 🟢1"));
  assert.ok(html.includes("需催办 2"));
});

test("持久 bundle：jsdom 集成 —— 收起/展开、store 投递、失败保留上次成功、历史不投递", () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    pretendToBeVisual: true,
  });
  const prev = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { plugin, registered } = loadClientBundle();
  const container = document.getElementById("root");
  // 模拟真实应用：悬浮组件与结果卡片同树共存（卡片随 block props 更新）
  const renderAll = (toolviewBlock) => {
    act(() => {
      root.render(
        React.createElement(React.Fragment, null, [
          React.createElement(registered.widget, { key: "w" }),
          toolviewBlock === null
            ? null
            : React.createElement(registered.toolview, {
                key: "t",
                callId: toolviewBlock.callId,
                toolName: "analyze_urge_risks",
                block: toolviewBlock,
                openFile: () => {},
              }),
        ]),
      );
    });
  };
  let root;
  try {
    act(() => {
      root = createRoot(container);
    });
    renderAll(null);
    const text = () => container.textContent;
    // 空态收起
    assert.ok(text().includes("尚未分析"), "初始应显示尚未分析");

    // 1) 卡片渲染新结果 → 悬浮组件自动更新为计数
    renderAll(widgetBlock());
    assert.ok(text().includes("🔴2 🟡1 🟢1"), "调用成功应更新悬浮组件");
    assert.ok(text().includes("需催办 2"));

    // 2) 点击展开 → 六项汇总 + 流程行 + P004 双状态
    act(() => {
      container.querySelector('[role="button"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.ok(text().includes("流程总数"));
    assert.ok(text().includes("红色"));
    assert.ok(text().includes("冷却抑制"));
    assert.ok(text().includes("离职手续审批"));
    assert.ok(text().includes("🔴 超时"), "P004 风险等级仍为红色");
    assert.ok(text().includes("暂缓催办 · 2 小时后可再催办"), "P004 本次操作显示暂缓催办");

    // 3) 点击头部收起
    act(() => {
      [...container.querySelectorAll("span")].find((d) => d.textContent === "点击收起").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    assert.ok(text().includes("需催办 2"), "收起后仍显示计数");

    // 4) 失败结果：保留上次成功结果 + 本次更新失败标记
    renderAll(widgetBlock({ callId: "c2", seq: 102, isError: true, content: [{ type: "text", text: "参数校验失败" }] }));
    assert.ok(text().includes("本次更新失败"), "失败应标记本次更新失败");
    assert.ok(text().includes("🔴2 🟡1 🟢1"), "失败保留上一次成功结果");
    assert.ok(text().includes("参数校验失败"), "结果卡片显示错误文本");

    // 5) 历史重放（time 早于页面启动）不投递，不改变状态
    const before = plugin.__test.getSnapshot();
    renderAll(widgetBlock({ callId: "c3", seq: 103, time: Date.now() - 100000 }));
    assert.equal(plugin.__test.getSnapshot(), before, "历史结果不得覆盖状态");
  } finally {
    if (root) act(() => root.unmount());
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test("持久 bundle：内联展示/状态逻辑与模块逐分支等价（parity）", () => {
  const { plugin } = loadClientBundle();
  const f = plugin.__test.fns;
  const normalize = (value) => JSON.parse(JSON.stringify(value));
  const result = analyzeUrgeRisks(DEMO);

  // display-model parity
  for (const [res, processes] of [
    [result, DEMO],
    [result, null],
    [result, DEMO.slice(0, 2)],
  ]) {
    assert.deepEqual(
      normalize(f.buildDisplayModel(res, processes)),
      normalize(moduleBuildDisplayModel(res, processes)),
    );
  }
  for (const raw of [JSON.stringify({ processes: DEMO }), "{}", "", "bad", null]) {
    assert.deepEqual(normalize(f.parseArgsProcesses(raw)), normalize(moduleParseArgsProcesses(raw)));
  }
  assert.deepEqual(normalize(f.deriveStaySla(result.items[3])), normalize(moduleDeriveStaySla(result.items[3])));

  // widget-model parity
  assert.deepEqual(normalize(f.collapsedModel(f.createWidgetState())), normalize(moduleCollapsedModel(createWidgetState())));
  const s1 = applyResult(createWidgetState(), result);
  assert.deepEqual(normalize(f.collapsedModel(s1)), normalize(moduleCollapsedModel(s1)));
  assert.deepEqual(normalize(f.expandedModel(s1)), normalize(moduleExpandedModel(s1)));
  const s2 = applyFailure(s1, 12345);
  assert.deepEqual(normalize(f.collapsedModel(s2)), normalize(moduleCollapsedModel(s2)));
  assert.equal(f.shouldHighlight(s1, s2), moduleShouldHighlight(s1, s2));
  assert.equal(f.shouldHighlight(s2, s1), moduleShouldHighlight(s2, s1));
  assert.equal(f.redUrgeCount(result), 1);
});
