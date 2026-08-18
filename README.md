# 催办风险灯（urge-risk-light）

根据流程节点停留时间批量判定催办风险的 DeepSeek Harness 工具插件，提供模型可见工具
**`analyze_urge_risks`**。

- **只做确定性规则计算**：不连接真实流程系统、不发送真实催办消息，纯内部演示用途；
- **规则确定、可重复**：相同输入在任何时刻、任何环境产生完全相同的输出；
- **模型负责理解任务与组织语言，插件负责执行规则**：所有边界判断、舍入、冷却计算都在插件内完成。

## 判断规则

| 条件 | riskLevel | riskLabel | shouldUrge | suggestedAction |
| --- | --- | --- | --- | --- |
| `nodeStayHours < slaHours × 0.8` | `green` | 正常 | `false` | 暂不处理 |
| `slaHours × 0.8 ≤ nodeStayHours < slaHours` | `yellow` | 临期 | `true` | 提前提醒 |
| `nodeStayHours ≥ slaHours` | `red` | 超时 | `true` | 立即催办 |
| `lastUrgedHoursAgo` 存在且 `< 4`（冷却覆盖） | 保留原等级 | 保留原标签 | 改为 `false` | 暂缓重复催办 |

冷却覆盖规则：`suppressedByCooldown = true`，并返回距允许再次催办的剩余小时数
（`cooldownRemainingHours = 4 - lastUrgedHoursAgo`）。

## 工具输入（`processes` 数组，必填非空）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `processId` | string | 是 | 流程编号（非空字符串） |
| `processName` | string | 是 | 流程名称（非空字符串） |
| `currentNode` | string | 是 | 当前节点（非空字符串） |
| `handler` | string | 是 | 当前处理人（非空字符串） |
| `nodeStayHours` | number | 是 | 节点已停留小时数（非负数字） |
| `slaHours` | number | 是 | 节点处理时限小时数（正数） |
| `lastUrgedHoursAgo` | number | 否 | 距上次催办小时数（非负数字；从未催办时不传） |

参数非法（非数组、空数组、缺失必填字段、负数、`slaHours` 非正等）时抛出清晰错误：
`analyze_urge_risks 参数校验失败：<逐条原因，用；分隔>`。

## 工具输出

```jsonc
{
  "summary": { "total": 4, "redCount": 2, "yellowCount": 1, "greenCount": 1, "shouldUrgeCount": 2, "suppressedCount": 1 },
  "items": [
    {
      "processId": "P001",
      "processName": "员工证明审批",
      "currentNode": "部门负责人审批",
      "handler": "张三",
      "riskLevel": "red",
      "riskLabel": "超时",
      "progressPercent": 125,        // SLA 消耗进度，保留一位小数；超时后可能超过 100
      "remainingHours": 0,           // 未超时 = SLA - 已停留；已超时 = 0
      "overdueHours": 6,             // 未超时 = 0；已超时 = 已停留 - SLA
      "shouldUrge": true,
      "suppressedByCooldown": false,
      "cooldownRemainingHours": 0,   // 冷却中 = 4 - lastUrgedHoursAgo；否则 0
      "reason": "节点已停留 30 小时，SLA 时限 24 小时（进度 125%），已达到 SLA 时限，判定为超时",
      "suggestedAction": "立即催办"
    }
    // ...
  ]
}
```

## 目录结构

```
urge-risk-light/
├── src/index.ts            # 规范实现（TypeScript）：类型、校验、确定性规则、汇总
├── lib/index.js            # tsc 编译产物（单元测试直接覆盖的对象）
├── lib/index.d.ts          # 类型声明
├── plugin/
│   ├── tool-definition.js  # 工具名/描述/参数 Schema/输出 Schema/render（共享单一来源）
│   ├── display-model.js    # 展示映射纯函数：结构化结果 → 汇总卡/风险行展示模型
│   ├── widget-model.js     # 悬浮组件状态模型纯函数（成功/失败/高亮/收起展开文案）
│   ├── plugin.js           # 可安装的 Cordis 插件入口（defineTool + ctx.tools.register）
│   ├── host-body.js        # 自动生成：从 lib/index.js 内联逻辑的动态宿主代码（供参考）
│   ├── runtime-host-body.raw.js  # 实际提交给 cordis_define 的宿主代码（parity 测试覆盖）
│   └── runtime-client-body.raw.js # 实际提交给 cordis_define 的客户端代码（toolview 卡片）
├── dist/client.js          # 持久化 Client 模块：结果卡片 + 右下角悬浮组件（classic script）
├── scripts/build-host-body.mjs   # 生成 host-body.js
├── test/
│   ├── fixtures.js         # 演示数据与预期结果
│   ├── urge-risks.test.js  # 单元测试（边界、冷却、错误、汇总、确定性）
│   ├── display-model.test.js # 展示映射测试（汇总卡、行 tone、P004 双状态、派生）
│   ├── widget-model.test.js # 悬浮状态模型测试（成功/失败保留/高亮/文案）
│   └── dynamic-host.test.js# 动态宿主 VM 测试 + Client 渲染测试 + 持久 bundle 测试（jsdom 集成 + parity）
└── README.md
```

## 开发与测试

```bash
npm install          # 安装 typescript 与 @deepseek-ai/dsh-tools（devDependencies）
npm run typecheck    # tsc --noEmit
npm run build        # tsc 编译 + 生成 host-body.js
npm test             # node --test（34 项测试）
```

测试覆盖：

- 三档等级与 0.8 边界（恰好等于 / 略低于 / 恰好等于 SLA）；
- `progressPercent` 保留一位小数；`remainingHours` / `overdueHours` 互斥为 0；
- 4 小时冷却：`3.99`（抑制）、`4`（不抑制）、`0`（剩余 4 小时）、未传（不抑制）；
- 错误路径：非数组、空数组、缺失字段、负数、`slaHours` 为 0/负、`NaN`/`Infinity`、非对象元素、多条错误合并；
- 动态宿主 parity：提交给运行时的宿主代码与 `lib/index.js` 在全部合法/非法用例上逐分支等价；
- Schema 通过官方 `@deepseek-ai/dsh-tools` 编译器与校验器（`parameterSchemaSpecToJsonSchema` /
  `valueSchemaSpecToJsonSchema` / `validateJsonSchemaValue` / `defineTool`）。

## 安装

### 方式一：当前会话动态插件（试验用，重启后失效）

```text
cordis_define（code.host = plugin/runtime-host-body.raw.js 的内容）
cordis_run   → 工具立即出现在当前 Agent 的工具目录
```

### 方式二：持久安装（宿主组合行，重启后仍生效）

1. 把本项目链接到 profile 共享存储，使 loader 可解析包名：
   `ln -s <本项目绝对路径> "$HOME/.dsh/profiles/node_modules/urge-risk-light"`
2. 在 `$HOME/.dsh/profiles/desktop/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: tool-urge-risk-light
         name: 'urge-risk-light/plugin'
   ```

3. 重启 DSH 进程后，`analyze_urge_risks` 对所有会话可见。

> 持久行同时提供 Host（工具本体）与持久化 Client 模块（结果卡片 + 悬浮组件），
> 重启 DSH 后自动加载：包名 `urge-risk-light` 声明 `dsh.client` 与
> `exports["./client"]`（dist/client.js），web 运行时经 `__ModuleLoader__`
> 装载并注册 `tool.call.toolview` 与 `shell.overlay` 两个官方槽位。

> 卸载：删除 patch 行与符号链接即可；`plugin/plugin.js` 的 `apply` 返回注册 disposer，
> 插件停用/移除时工具自动撤销。

## 调用示例

模型侧一句话即可触发（Agent 会自行组织 `processes` 参数并调用工具）：

```text
用催办风险灯分析这几条流程：P001 员工证明审批（部门负责人审批/张三）已停留 30 小时、时限 24 小时、12 小时前催办过；
P002 入职材料审核（材料复核/李四）停留 20 小时、时限 24 小时；P003 考勤异常申诉（HR审核/王五）停留 8 小时、时限 24 小时；
P004 离职手续审批（资产确认/赵六）停留 36 小时、时限 24 小时、2 小时前催办过。
```

预期：P001 🔴 立即催办；P002 🟡 提前提醒；P003 🟢 暂不处理；P004 🔴 但冷却中，暂缓重复催办。

## 可视化展示机制

- **工具本体零改动**：`analyze_urge_risks` 的输入、确定性规则、结构化输出与 Schema 完全不变；
- **Client 渲染**：动态插件的 Client half 注册官方 `tool.call.toolview` 槽位
  （keyed，按工具名分发，key 域开放）的 `analyze_urge_risks` key，用
  `React.createElement` 渲染「催办风险灯」汇总卡（流程总数/红/黄/绿/应催办/冷却抑制 6 格）
  与红黄绿风险列表；数据来自 `block.meta`（presentationMeta 透出的结构化结果）与
  `block.call.argsRaw`（原始入参中的停留/SLA），不触碰结构化输出；
- **P004 双状态**：风险等级徽章（🔴 超时）与「本次操作」chip（暂缓催办 · X 小时后可再催办）
  是两个独立视觉元素，风险等级与是否催办不混为一谈；
- **降级链**：客户端未激活/出错时回退到 render 的 Markdown 表格（红黄绿 emoji，风险等级与
  本次操作分列）；模型始终读取结构化 JSON，调用方式不变；
- **展示映射可测**：`plugin/display-model.js` 为纯函数（无 React），客户端内联同一份逻辑，
  parity 测试逐分支验证等价；`test/display-model.test.js` 覆盖映射规则。

## 右下角悬浮组件（shell.overlay）

页面右下角常驻一个克制的「催办风险灯」状态条，展示 analyze_urge_risks
**最近一次调用的结构化结果**（不在客户端重新计算业务规则）：

- **收起态**：插件名 + `🔴2 🟡1 🟢1` + `需催办 2`；无分析结果时显示「尚未分析」；
  调用失败时保留上次成功计数并显示「本次更新失败」小标签；
- **展开态**：六项汇总（流程总数/红/黄/绿/应催办/冷却抑制）+ 流程行
  （流程名称、🔴/🟡/🟢 风险徽章、超时或剩余时间、本次操作）；P004 等冷却流程
  同时显示「🔴 超时」与「暂缓催办 · X 小时后可再催办」两个独立视觉元素；
  点击头部收起；面板不遮挡对话（右下角、可滚动、点击外层不拦截）；
- **更新机制**：结果卡片（tool.call.toolview）在「新结果」到达时把
  `block.meta`（presentationMeta 透出的结构化输出）原样写入模块级共享 store，
  悬浮组件订阅 store 渲染；仅投递页面加载后（`block.time >= bootTime`）的结果，
  历史重放不触发；失败保留上次成功并标记；无轮询、无网络请求；
- **高亮**：新结果中「需催办的红色流程数」增加时，状态条一次性轻微高亮
  （box-shadow 过渡，1.8s 后恢复，不持续闪烁）；
- **不持久化**：store 为内存态，重启后回到「尚未分析」，新会话首次调用后恢复。

## 发布说明

当前为私有演示插件（`package.json` 标记 `private: true`）。未经确认不会发布到 npm 或 GitHub。
