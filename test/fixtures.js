/** 演示数据与预期结果（与需求文档一致）。 */
export const DEMO = [
  {
    processId: "P001",
    processName: "员工证明审批",
    currentNode: "部门负责人审批",
    handler: "张三",
    nodeStayHours: 30,
    slaHours: 24,
    lastUrgedHoursAgo: 12,
  },
  {
    processId: "P002",
    processName: "入职材料审核",
    currentNode: "材料复核",
    handler: "李四",
    nodeStayHours: 20,
    slaHours: 24,
  },
  {
    processId: "P003",
    processName: "考勤异常申诉",
    currentNode: "HR审核",
    handler: "王五",
    nodeStayHours: 8,
    slaHours: 24,
  },
  {
    processId: "P004",
    processName: "离职手续审批",
    currentNode: "资产确认",
    handler: "赵六",
    nodeStayHours: 36,
    slaHours: 24,
    lastUrgedHoursAgo: 2,
  },
];

/** 每条流程的预期判定（需求文档「预期结果」一节）。 */
export const EXPECTED = {
  P001: { riskLevel: "red", riskLabel: "超时", progressPercent: 125, overdueHours: 6, shouldUrge: true, suppressedByCooldown: false, suggestedAction: "立即催办" },
  P002: { riskLevel: "yellow", riskLabel: "临期", progressPercent: 83.3, remainingHours: 4, shouldUrge: true, suppressedByCooldown: false, suggestedAction: "提前提醒" },
  P003: { riskLevel: "green", riskLabel: "正常", progressPercent: 33.3, remainingHours: 16, shouldUrge: false, suppressedByCooldown: false, suggestedAction: "暂不处理" },
  P004: { riskLevel: "red", riskLabel: "超时", progressPercent: 150, overdueHours: 12, shouldUrge: false, suppressedByCooldown: true, cooldownRemainingHours: 2, suggestedAction: "暂缓重复催办" },
};

export const EXPECTED_SUMMARY = {
  total: 4,
  redCount: 2,
  yellowCount: 1,
  greenCount: 1,
  shouldUrgeCount: 2,
  suppressedCount: 1,
};
