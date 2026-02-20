export type BlueprintCaseId =
  | "debate"
  | "paper"
  | "code_review"
  | "product_design";

export type BlueprintRoleSpec = {
  role: string;
  guidance: string;
  nameZh: string;
  nameEn: string;
};

export type BlueprintPreviewNode = {
  id: string;
  role: string;
  labelZh: string;
  labelEn: string;
  x: number;
  y: number;
  kind: "human" | "assistant" | "worker";
};

export type BlueprintCase = {
  id: BlueprintCaseId;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  topicPromptZh: string;
  topicPromptEn: string;
  goalTemplateZh: string;
  goalTemplateEn: string;
  roles: BlueprintRoleSpec[];
  previewNodes: BlueprintPreviewNode[];
  previewEdges: Array<{ from: string; to: string; type: "command" | "collab" | "review" }>;
};

export const BLUEPRINT_CASES: BlueprintCase[] = [
  {
    id: "debate",
    nameZh: "辩论工坊",
    nameEn: "Debate Arena",
    descriptionZh: "正反辩手 + 主持人，用于观点对抗与裁决。",
    descriptionEn: "Pro/con debaters plus moderator for structured argument and verdict.",
    topicPromptZh: "本局辩论主题是什么？请用一句话告诉我。",
    topicPromptEn: "What is the debate topic? Please provide it in one sentence.",
    goalTemplateZh:
      "围绕主题「{{topic}}」组织 3 轮辩论：每轮正方先发言、反方回应、主持人总结。第 3 轮后给出胜负与理由，并明确输出“最终总结”四个字作为收尾信号。",
    goalTemplateEn:
      "Run a 3-round debate on '{{topic}}': pro speaks first, con responds, moderator summarizes each round, then give final verdict and include the exact phrase 'final summary' at the end.",
    roles: [
      {
        role: "proponent",
        nameZh: "正方辩手",
        nameEn: "Pro Debater",
        guidance:
          "You are the pro side. Build structured arguments and challenge weak assumptions.",
      },
      {
        role: "opponent",
        nameZh: "反方辩手",
        nameEn: "Con Debater",
        guidance:
          "You are the con side. Attack logical gaps and force trade-off analysis.",
      },
      {
        role: "moderator",
        nameZh: "主持人",
        nameEn: "Moderator",
        guidance:
          "You are the moderator. Keep turns orderly and produce concise round summaries.",
      },
    ],
    previewNodes: [
      { id: "human", role: "human", labelZh: "你", labelEn: "You", x: 15, y: 52, kind: "human" },
      { id: "assistant", role: "assistant", labelZh: "助手", labelEn: "Assistant", x: 37, y: 20, kind: "assistant" },
      { id: "proponent", role: "proponent", labelZh: "正方", labelEn: "Pro", x: 66, y: 26, kind: "worker" },
      { id: "opponent", role: "opponent", labelZh: "反方", labelEn: "Con", x: 66, y: 52, kind: "worker" },
      { id: "moderator", role: "moderator", labelZh: "主持", labelEn: "Host", x: 66, y: 78, kind: "worker" },
    ],
    previewEdges: [
      { from: "human", to: "assistant", type: "command" },
      { from: "assistant", to: "proponent", type: "command" },
      { from: "assistant", to: "opponent", type: "command" },
      { from: "assistant", to: "moderator", type: "command" },
      { from: "proponent", to: "opponent", type: "collab" },
      { from: "opponent", to: "moderator", type: "review" },
    ],
  },
  {
    id: "paper",
    nameZh: "论文流水线",
    nameEn: "Paper Factory",
    descriptionZh: "研究、方法、写作、审稿四角色协作产出论文草稿。",
    descriptionEn: "Research, method, writing, and review roles for paper drafting.",
    topicPromptZh: "本次论文的题目或研究主题是什么？",
    topicPromptEn: "What is the paper topic or research question?",
    goalTemplateZh:
      "围绕主题「{{topic}}」完成论文草稿：先给大纲，再写正文，最后审稿人给出 5 条可执行修改建议。",
    goalTemplateEn:
      "For topic '{{topic}}', produce outline then draft, then reviewer outputs 5 actionable revisions.",
    roles: [
      {
        role: "researcher",
        nameZh: "研究员",
        nameEn: "Researcher",
        guidance:
          "You are a researcher. Clarify scope, assumptions, and evidence requirements.",
      },
      {
        role: "methodologist",
        nameZh: "方法学专家",
        nameEn: "Methodologist",
        guidance:
          "You are a method specialist. Design method and evaluation rigorously.",
      },
      {
        role: "writer",
        nameZh: "写作者",
        nameEn: "Writer",
        guidance:
          "You are the writer. Produce coherent sections with clear transitions.",
      },
      {
        role: "reviewer",
        nameZh: "审稿人",
        nameEn: "Reviewer",
        guidance:
          "You are the reviewer. Focus on risks, unsupported claims, and revision priorities.",
      },
    ],
    previewNodes: [
      { id: "human", role: "human", labelZh: "你", labelEn: "You", x: 14, y: 52, kind: "human" },
      { id: "assistant", role: "assistant", labelZh: "助手", labelEn: "Assistant", x: 35, y: 20, kind: "assistant" },
      { id: "researcher", role: "researcher", labelZh: "研究", labelEn: "Research", x: 64, y: 20, kind: "worker" },
      { id: "methodologist", role: "methodologist", labelZh: "方法", labelEn: "Method", x: 64, y: 40, kind: "worker" },
      { id: "writer", role: "writer", labelZh: "写作", labelEn: "Writer", x: 64, y: 60, kind: "worker" },
      { id: "reviewer", role: "reviewer", labelZh: "审稿", labelEn: "Review", x: 64, y: 80, kind: "worker" },
    ],
    previewEdges: [
      { from: "human", to: "assistant", type: "command" },
      { from: "assistant", to: "researcher", type: "command" },
      { from: "assistant", to: "methodologist", type: "command" },
      { from: "researcher", to: "writer", type: "collab" },
      { from: "methodologist", to: "writer", type: "collab" },
      { from: "writer", to: "reviewer", type: "review" },
    ],
  },
  {
    id: "code_review",
    nameZh: "代码评审小队",
    nameEn: "Code Review Squad",
    descriptionZh: "架构、安全、测试、实现联合评审，聚焦风险与修复闭环。",
    descriptionEn: "Architect, security, QA, implementer for risk-focused code review.",
    topicPromptZh: "请给出本次代码评审主题（模块/需求/问题点）。",
    topicPromptEn: "Provide the code-review target (module/feature/issue).",
    goalTemplateZh:
      "针对「{{topic}}」执行评审：先列高风险问题，再给修复建议和测试清单，最后输出执行计划。",
    goalTemplateEn:
      "Review '{{topic}}': list high-severity findings, fixes, test checklist, and execution plan.",
    roles: [
      {
        role: "architect",
        nameZh: "架构师",
        nameEn: "Architect",
        guidance:
          "You are the architect. Detect design flaws and long-term maintainability risks.",
      },
      {
        role: "security_reviewer",
        nameZh: "安全审查",
        nameEn: "Security Reviewer",
        guidance:
          "You are the security reviewer. Prioritize exploitability and abuse scenarios.",
      },
      {
        role: "qa_engineer",
        nameZh: "测试工程师",
        nameEn: "QA Engineer",
        guidance:
          "You are QA. Turn findings into reproducible test plans and edge cases.",
      },
      {
        role: "implementer",
        nameZh: "实现工程师",
        nameEn: "Implementer",
        guidance:
          "You are implementer. Translate review output into concrete patch strategy.",
      },
    ],
    previewNodes: [
      { id: "human", role: "human", labelZh: "你", labelEn: "You", x: 14, y: 52, kind: "human" },
      { id: "assistant", role: "assistant", labelZh: "助手", labelEn: "Assistant", x: 35, y: 20, kind: "assistant" },
      { id: "architect", role: "architect", labelZh: "架构", labelEn: "Arch", x: 64, y: 20, kind: "worker" },
      { id: "security_reviewer", role: "security_reviewer", labelZh: "安全", labelEn: "Sec", x: 64, y: 40, kind: "worker" },
      { id: "qa_engineer", role: "qa_engineer", labelZh: "测试", labelEn: "QA", x: 64, y: 60, kind: "worker" },
      { id: "implementer", role: "implementer", labelZh: "实现", labelEn: "Impl", x: 64, y: 80, kind: "worker" },
    ],
    previewEdges: [
      { from: "human", to: "assistant", type: "command" },
      { from: "assistant", to: "architect", type: "command" },
      { from: "assistant", to: "security_reviewer", type: "command" },
      { from: "architect", to: "qa_engineer", type: "review" },
      { from: "security_reviewer", to: "implementer", type: "review" },
      { from: "qa_engineer", to: "implementer", type: "collab" },
    ],
  },
  {
    id: "product_design",
    nameZh: "产品设计实验室",
    nameEn: "Product Design Studio",
    descriptionZh: "PM、用户研究、交互设计、增长协作形成产品方案。",
    descriptionEn: "PM, user research, UX, growth collaboration for product strategy.",
    topicPromptZh: "请描述本次产品设计主题（目标用户 + 核心问题）。",
    topicPromptEn: "Describe the product-design topic (target user + core problem).",
    goalTemplateZh:
      "围绕「{{topic}}」输出产品方案：问题定义、核心流程、原型建议、上线指标与实验计划。",
    goalTemplateEn:
      "For '{{topic}}', output product plan: problem framing, core flow, prototype notes, metrics, experiments.",
    roles: [
      {
        role: "product_manager",
        nameZh: "产品经理",
        nameEn: "Product Manager",
        guidance:
          "You are PM. Define user problem, success metrics, and roadmap priorities.",
      },
      {
        role: "user_researcher",
        nameZh: "用户研究员",
        nameEn: "User Researcher",
        guidance:
          "You are user researcher. Surface personas, jobs-to-be-done, and constraints.",
      },
      {
        role: "ux_designer",
        nameZh: "交互设计师",
        nameEn: "UX Designer",
        guidance:
          "You are UX designer. Provide information architecture and interaction rationale.",
      },
      {
        role: "growth_strategist",
        nameZh: "增长策略师",
        nameEn: "Growth Strategist",
        guidance:
          "You are growth strategist. Propose adoption loops and measurable experiments.",
      },
    ],
    previewNodes: [
      { id: "human", role: "human", labelZh: "你", labelEn: "You", x: 14, y: 52, kind: "human" },
      { id: "assistant", role: "assistant", labelZh: "助手", labelEn: "Assistant", x: 35, y: 20, kind: "assistant" },
      { id: "product_manager", role: "product_manager", labelZh: "产品", labelEn: "PM", x: 64, y: 20, kind: "worker" },
      { id: "user_researcher", role: "user_researcher", labelZh: "研究", labelEn: "Research", x: 64, y: 40, kind: "worker" },
      { id: "ux_designer", role: "ux_designer", labelZh: "设计", labelEn: "Design", x: 64, y: 60, kind: "worker" },
      { id: "growth_strategist", role: "growth_strategist", labelZh: "增长", labelEn: "Growth", x: 64, y: 80, kind: "worker" },
    ],
    previewEdges: [
      { from: "human", to: "assistant", type: "command" },
      { from: "assistant", to: "product_manager", type: "command" },
      { from: "assistant", to: "user_researcher", type: "command" },
      { from: "product_manager", to: "ux_designer", type: "collab" },
      { from: "user_researcher", to: "ux_designer", type: "collab" },
      { from: "ux_designer", to: "growth_strategist", type: "review" },
    ],
  },
];

export function getBlueprintCase(id: string | null | undefined): BlueprintCase | null {
  if (!id) return null;
  return BLUEPRINT_CASES.find((c) => c.id === id) ?? null;
}
