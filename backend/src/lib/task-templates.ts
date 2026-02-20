export type TaskTemplateId = "debate" | "paper" | "code_review";

export type TaskTemplate = {
  id: TaskTemplateId;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  defaultGoal: string;
  suggestedDurationMin: number;
  defaultMaxTurns: number;
  defaultMaxTokenDelta: number;
  promptScaffold: {
    outputFormat: string;
    guardrails: string[];
  };
};

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "debate",
    nameZh: "辩论模式",
    nameEn: "Debate Mode",
    descriptionZh: "让多智能体围绕一个议题进行正反辩论并给出裁决。",
    descriptionEn: "Run multi-agent pro/con debate and provide a final verdict.",
    defaultGoal: "组织正反双方围绕议题进行多轮辩论，最终给出胜负与理由。",
    suggestedDurationMin: 5,
    defaultMaxTurns: 24,
    defaultMaxTokenDelta: 18000,
    promptScaffold: {
      outputFormat: "观点 -> 证据 -> 反驳 -> 结论 -> 胜负判断",
      guardrails: ["避免空话", "必须引用对方观点回应", "最终输出明确胜负"],
    },
  },
  {
    id: "paper",
    nameZh: "论文模式",
    nameEn: "Paper Mode",
    descriptionZh: "从题目澄清到大纲与正文草稿，输出结构化学术文本。",
    descriptionEn: "From topic clarification to outline and draft in academic structure.",
    defaultGoal: "围绕主题完成论文草稿，包括摘要、引言、方法、结果、结论。",
    suggestedDurationMin: 8,
    defaultMaxTurns: 32,
    defaultMaxTokenDelta: 22000,
    promptScaffold: {
      outputFormat: "摘要/引言/方法/结果/讨论/结论/参考建议",
      guardrails: ["结构完整", "论证连贯", "避免虚构参考文献编号"],
    },
  },
  {
    id: "code_review",
    nameZh: "代码评审模式",
    nameEn: "Code Review Mode",
    descriptionZh: "按严重级别输出问题清单，并附带修复建议与测试建议。",
    descriptionEn: "Produce severity-ranked findings with fixes and test suggestions.",
    defaultGoal: "对当前代码改动进行严格评审，输出高/中/低风险问题与修复建议。",
    suggestedDurationMin: 6,
    defaultMaxTurns: 20,
    defaultMaxTokenDelta: 16000,
    promptScaffold: {
      outputFormat: "Findings(High->Low) -> Open Questions -> Suggested Tests",
      guardrails: ["必须给出文件定位", "优先行为回归风险", "避免泛泛建议"],
    },
  },
];

export function getTaskTemplate(templateId: string | null | undefined): TaskTemplate | null {
  if (!templateId) return null;
  return TASK_TEMPLATES.find((t) => t.id === templateId) ?? null;
}

export function buildTemplateGoal(template: TaskTemplate, topic: string) {
  const cleanTopic = topic.trim();
  const title = cleanTopic ? `主题：${cleanTopic}` : "主题：由用户输入为准";
  const guardrails = template.promptScaffold.guardrails.map((x) => `- ${x}`).join("\n");
  return `${template.defaultGoal}\n${title}\n输出格式：${template.promptScaffold.outputFormat}\n约束：\n${guardrails}`;
}

