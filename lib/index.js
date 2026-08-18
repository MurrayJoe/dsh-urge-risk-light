/**
 * 催办风险灯（urge-risk-light）
 *
 * 根据流程节点停留时间（nodeStayHours）与节点处理时限（slaHours）的对比，
 * 批量判定每条流程的催办风险等级（红 / 黄 / 绿），输出判断依据与处理建议。
 *
 * 设计约束：
 * - 只做确定性规则计算：不连接真实流程系统、不发送真实催办消息；
 * - 相同输入在任何时刻、任何环境都产生完全相同的输出；
 * - 模型负责理解任务与组织语言，插件负责执行规则。
 *
 * 判断规则：
 * 1. nodeStayHours < slaHours × 0.8        → green  （正常，暂不处理）
 * 2. slaHours × 0.8 ≤ nodeStayHours < sla  → yellow（临期，提前提醒）
 * 3. nodeStayHours ≥ slaHours              → red    （超时，立即催办）
 * 4. lastUrgedHoursAgo 存在且 < 4          → 保留原风险等级，shouldUrge 改为
 *    false，suppressedByCooldown = true，suggestedAction = 暂缓重复催办，
 *    并给出距允许再次催办的剩余小时数。
 */
/** 黄色预警阈值：停留时间达到 SLA 时限的 80% 即进入「临期」。 */
export const YELLOW_THRESHOLD = 0.8;
/** 催办冷却期（小时）：距上次催办不足该时长时，暂缓重复催办。 */
export const URGE_COOLDOWN_HOURS = 4;
/** 参数校验失败时抛出的结构化错误。 */
export class UrgeRiskValidationError extends Error {
    code = "INVALID_ARGUMENTS";
    issues;
    constructor(issues) {
        super(`analyze_urge_risks 参数校验失败：${issues.join("；")}`);
        this.name = "UrgeRiskValidationError";
        this.issues = issues;
    }
}
/** 保留一位小数（四舍五入）。 */
function round1(value) {
    return Math.round(value * 10) / 10;
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
/**
 * 校验批量分析输入，返回人类可读的错误列表；空数组表示校验通过。
 * 覆盖：非数组、空数组、缺失必填字段、字段类型错误、
 * nodeStayHours 为负、slaHours 非正、lastUrgedHoursAgo 为负等。
 */
export function validateProcesses(input) {
    if (!Array.isArray(input)) {
        return ["processes 必须是数组"];
    }
    if (input.length === 0) {
        return ["processes 为空数组，没有可分析的流程"];
    }
    const errors = [];
    input.forEach((raw, index) => {
        if (!isPlainObject(raw)) {
            errors.push(`第 ${index + 1} 条流程必须是对象`);
            return;
        }
        const pid = raw.processId;
        const suffix = typeof pid === "string" && pid.trim().length > 0 ? `(${pid})` : "";
        const label = `第 ${index + 1} 条流程${suffix}`;
        if (!isNonEmptyString(raw.processId)) {
            errors.push(`${label}：processId 必填且为非空字符串`);
        }
        if (!isNonEmptyString(raw.processName)) {
            errors.push(`${label}：processName 必填且为非空字符串`);
        }
        if (!isNonEmptyString(raw.currentNode)) {
            errors.push(`${label}：currentNode 必填且为非空字符串`);
        }
        if (!isNonEmptyString(raw.handler)) {
            errors.push(`${label}：handler 必填且为非空字符串`);
        }
        const stay = raw.nodeStayHours;
        if (!isFiniteNumber(stay)) {
            errors.push(`${label}：nodeStayHours 必填且为数字`);
        }
        else if (stay < 0) {
            errors.push(`${label}：nodeStayHours 不能为负数（得到 ${stay}）`);
        }
        const sla = raw.slaHours;
        if (!isFiniteNumber(sla)) {
            errors.push(`${label}：slaHours 必填且为数字`);
        }
        else if (sla <= 0) {
            errors.push(`${label}：slaHours 必须为正数（得到 ${sla}）`);
        }
        if (raw.lastUrgedHoursAgo !== undefined) {
            const urged = raw.lastUrgedHoursAgo;
            if (!isFiniteNumber(urged)) {
                errors.push(`${label}：lastUrgedHoursAgo 必须为数字`);
            }
            else if (urged < 0) {
                errors.push(`${label}：lastUrgedHoursAgo 不能为负数（得到 ${urged}）`);
            }
        }
    });
    return errors;
}
/**
 * 对单条流程做确定性风险判定。
 * @param input 已通过校验的流程输入。
 */
export function classifyProcess(input) {
    const { processId, processName, currentNode, handler, nodeStayHours, slaHours } = input;
    const lastUrgedHoursAgo = input.lastUrgedHoursAgo;
    const progressPercent = round1((nodeStayHours / slaHours) * 100);
    const thresholdHours = slaHours * YELLOW_THRESHOLD;
    const overdue = nodeStayHours >= slaHours;
    let riskLevel;
    let riskLabel;
    let suggestedAction;
    let reason;
    if (nodeStayHours < thresholdHours) {
        riskLevel = "green";
        riskLabel = "正常";
        suggestedAction = "暂不处理";
        reason =
            `节点已停留 ${round1(nodeStayHours)} 小时，SLA 时限 ${round1(slaHours)} 小时` +
                `（进度 ${progressPercent}%），未达到 SLA 的 80% 阈值（${round1(thresholdHours)} 小时），判定为正常`;
    }
    else if (!overdue) {
        riskLevel = "yellow";
        riskLabel = "临期";
        suggestedAction = "提前提醒";
        reason =
            `节点已停留 ${round1(nodeStayHours)} 小时，SLA 时限 ${round1(slaHours)} 小时` +
                `（进度 ${progressPercent}%），已达到 SLA 的 80% 阈值（${round1(thresholdHours)} 小时）但尚未超时，判定为临期`;
    }
    else {
        riskLevel = "red";
        riskLabel = "超时";
        suggestedAction = "立即催办";
        reason =
            `节点已停留 ${round1(nodeStayHours)} 小时，SLA 时限 ${round1(slaHours)} 小时` +
                `（进度 ${progressPercent}%），已达到 SLA 时限，判定为超时`;
    }
    let shouldUrge = riskLevel !== "green";
    let suppressedByCooldown = false;
    let cooldownRemainingHours = 0;
    if (lastUrgedHoursAgo !== undefined && lastUrgedHoursAgo < URGE_COOLDOWN_HOURS) {
        suppressedByCooldown = true;
        shouldUrge = false;
        cooldownRemainingHours = URGE_COOLDOWN_HOURS - lastUrgedHoursAgo;
        suggestedAction = "暂缓重复催办";
        reason +=
            `；距上次催办 ${round1(lastUrgedHoursAgo)} 小时，处于 ${URGE_COOLDOWN_HOURS} 小时冷却期内，` +
                `暂缓重复催办（${cooldownRemainingHours} 小时后可再次催办）`;
    }
    return {
        processId,
        processName,
        currentNode,
        handler,
        riskLevel,
        riskLabel,
        progressPercent,
        remainingHours: overdue ? 0 : round1(slaHours - nodeStayHours),
        overdueHours: overdue ? round1(nodeStayHours - slaHours) : 0,
        shouldUrge,
        suppressedByCooldown,
        cooldownRemainingHours,
        reason,
        suggestedAction,
    };
}
/**
 * 批量分析催办风险：先严格校验参数，失败时抛出 {@link UrgeRiskValidationError}；
 * 通过后逐条判定并汇总。输入顺序即输出顺序，结果完全确定、可重复。
 */
export function analyzeUrgeRisks(input) {
    const issues = validateProcesses(input);
    if (issues.length > 0) {
        throw new UrgeRiskValidationError(issues);
    }
    const processes = input;
    const items = processes.map((item) => classifyProcess(item));
    const summary = {
        total: items.length,
        redCount: items.filter((item) => item.riskLevel === "red").length,
        yellowCount: items.filter((item) => item.riskLevel === "yellow").length,
        greenCount: items.filter((item) => item.riskLevel === "green").length,
        shouldUrgeCount: items.filter((item) => item.shouldUrge).length,
        suppressedCount: items.filter((item) => item.suppressedByCooldown).length,
    };
    return { summary, items };
}
