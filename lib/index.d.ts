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
export declare const YELLOW_THRESHOLD = 0.8;
/** 催办冷却期（小时）：距上次催办不足该时长时，暂缓重复催办。 */
export declare const URGE_COOLDOWN_HOURS = 4;
/** 催办风险等级。 */
export type UrgeRiskLevel = "green" | "yellow" | "red";
/** 单条流程输入。 */
export interface ProcessInput {
    /** 流程编号（必填，非空字符串）。 */
    processId: string;
    /** 流程名称（必填，非空字符串）。 */
    processName: string;
    /** 当前节点（必填，非空字符串）。 */
    currentNode: string;
    /** 当前处理人（必填，非空字符串）。 */
    handler: string;
    /** 节点已停留小时数（必填，非负数字）。 */
    nodeStayHours: number;
    /** 节点处理时限小时数（必填，正数）。 */
    slaHours: number;
    /** 距上次催办的小时数（可选，非负数字；从未催办时不传）。 */
    lastUrgedHoursAgo?: number;
}
/** 单条流程的风险分析结果。 */
export interface RiskItem {
    processId: string;
    processName: string;
    currentNode: string;
    handler: string;
    riskLevel: UrgeRiskLevel;
    riskLabel: string;
    /** SLA 消耗进度（%），保留一位小数；超时后可能超过 100。 */
    progressPercent: number;
    /** 距 SLA 时限的剩余小时数；已超时为 0。 */
    remainingHours: number;
    /** 超出 SLA 时限的小时数；未超时为 0。 */
    overdueHours: number;
    shouldUrge: boolean;
    /** 是否被 4 小时催办冷却期抑制。 */
    suppressedByCooldown: boolean;
    /** 距允许再次催办的剩余小时数；无冷却抑制时为 0。 */
    cooldownRemainingHours: number;
    /** 判断依据：实际停留时间、时限与规则判定说明。 */
    reason: string;
    suggestedAction: string;
}
/** 批量分析的汇总统计。 */
export interface UrgeRiskSummary {
    total: number;
    redCount: number;
    yellowCount: number;
    greenCount: number;
    shouldUrgeCount: number;
    suppressedCount: number;
}
/** 批量分析结果。 */
export interface AnalyzeResult {
    summary: UrgeRiskSummary;
    items: RiskItem[];
}
/** 参数校验失败时抛出的结构化错误。 */
export declare class UrgeRiskValidationError extends Error {
    readonly code = "INVALID_ARGUMENTS";
    readonly issues: string[];
    constructor(issues: string[]);
}
/**
 * 校验批量分析输入，返回人类可读的错误列表；空数组表示校验通过。
 * 覆盖：非数组、空数组、缺失必填字段、字段类型错误、
 * nodeStayHours 为负、slaHours 非正、lastUrgedHoursAgo 为负等。
 */
export declare function validateProcesses(input: unknown): string[];
/**
 * 对单条流程做确定性风险判定。
 * @param input 已通过校验的流程输入。
 */
export declare function classifyProcess(input: ProcessInput): RiskItem;
/**
 * 批量分析催办风险：先严格校验参数，失败时抛出 {@link UrgeRiskValidationError}；
 * 通过后逐条判定并汇总。输入顺序即输出顺序，结果完全确定、可重复。
 */
export declare function analyzeUrgeRisks(input: unknown): AnalyzeResult;
