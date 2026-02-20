export type WerewolfStrategyKey =
  | "aggressive_analyst"
  | "steady_conservative"
  | "social_blender"
  | "chaos_disruptor"
  | "adaptive_deceiver";

export type DecodeConfig = {
  temperature: number;
  topP: number;
  presencePenalty: number;
  frequencyPenalty: number;
};

export type PlayerMemory = {
  suspectMap: Record<string, number>;
  focusTargets: string[];
  selfRisk: number;
  lastPhrases: string[];
  speechSkipsUsed: number;
  voteHistory: Array<{ roundNo: number; targetAgentId: string }>;
  speechHistory: Array<{ roundNo: number; text: string }>;
};

export const STRATEGY_SLOTS: WerewolfStrategyKey[] = [
  "aggressive_analyst",
  "steady_conservative",
  "social_blender",
  "chaos_disruptor",
  "adaptive_deceiver",
];

const DECODE_DEFAULTS: Record<WerewolfStrategyKey, DecodeConfig> = {
  aggressive_analyst: { temperature: 0.84, topP: 0.9, presencePenalty: 0.35, frequencyPenalty: 0.24 },
  steady_conservative: { temperature: 0.7, topP: 0.86, presencePenalty: 0.2, frequencyPenalty: 0.18 },
  social_blender: { temperature: 0.92, topP: 0.94, presencePenalty: 0.42, frequencyPenalty: 0.3 },
  chaos_disruptor: { temperature: 1.02, topP: 0.96, presencePenalty: 0.5, frequencyPenalty: 0.35 },
  adaptive_deceiver: { temperature: 0.9, topP: 0.92, presencePenalty: 0.36, frequencyPenalty: 0.28 },
};

const GUIDANCE: Record<WerewolfStrategyKey, string> = {
  aggressive_analyst: "You pressure-test statements and push concrete suspicions.",
  steady_conservative: "You prioritize stable logic and avoid overexposure.",
  social_blender: "You blend with the room while keeping subtle independent reads.",
  chaos_disruptor: "You create controlled uncertainty and force reactions.",
  adaptive_deceiver: "You adapt to survive while maximizing faction win rate.",
};

export function getStrategyGuidance(key: WerewolfStrategyKey) {
  return GUIDANCE[key];
}

export function getStrategyPersonaRules(key: WerewolfStrategyKey) {
  const rules: Record<WerewolfStrategyKey, { style: string; structure: string; bannedPhrases: string[] }> = {
    aggressive_analyst: {
      style: "语气锋利、结论先行，必须指出一条可核验矛盾",
      structure: "先给怀疑对象，再给证据片段",
      bannedPhrases: ["先看看", "再观察", "我也不确定", "描述偏空泛"],
    },
    steady_conservative: {
      style: "语气克制、逻辑稳定，不追求最激进结论",
      structure: "先复盘公开信息，再给当前倾向",
      bannedPhrases: ["我觉得都差不多", "随便投", "先投这一位", "感觉像"],
    },
    social_blender: {
      style: "语气亲和，先接住他人观点，再补充独立判断",
      structure: "先共识后分歧",
      bannedPhrases: ["和前面一样", "同上", "我没补充", "描述偏空泛"],
    },
    chaos_disruptor: {
      style: "制造受控不确定性，主动抛出反例但不胡言乱语",
      structure: "先挑战主流结论，再给替代解释",
      bannedPhrases: ["我完全同意", "没意见", "先观察一轮", "描述偏空泛"],
    },
    adaptive_deceiver: {
      style: "根据局势调整力度，发言要像真人博弈",
      structure: "先低风险立场，再留一个可转向锚点",
      bannedPhrases: ["先投这一位", "描述偏空泛", "与前面一致", "没什么可说"],
    },
  };
  return rules[key];
}

export function getDefaultDecodeConfig(key: WerewolfStrategyKey): DecodeConfig {
  return { ...DECODE_DEFAULTS[key] };
}

export function scheduleDecodeConfig(base: DecodeConfig, roundNo: number, phase: string): DecodeConfig {
  const out = { ...base };
  if (roundNo >= 3) out.temperature = Math.min(1.08, out.temperature + 0.06);
  if (phase.includes("tiebreak")) out.topP = Math.min(0.98, out.topP + 0.02);
  return out;
}

export function createInitialMemory(playerIds: string[]): PlayerMemory {
  const suspectMap: Record<string, number> = {};
  for (const id of playerIds) suspectMap[id] = 0.35;
  return {
    suspectMap,
    focusTargets: [],
    selfRisk: 0.4,
    lastPhrases: [],
    speechSkipsUsed: 0,
    voteHistory: [],
    speechHistory: [],
  };
}

export function parseMemory(raw: string | null | undefined): PlayerMemory {
  if (!raw) return createInitialMemory([]);
  try {
    const p = JSON.parse(raw) as Partial<PlayerMemory>;
    return {
      suspectMap: typeof p.suspectMap === "object" && p.suspectMap ? (p.suspectMap as Record<string, number>) : {},
      focusTargets: Array.isArray(p.focusTargets) ? p.focusTargets.map(String) : [],
      selfRisk: typeof p.selfRisk === "number" ? p.selfRisk : 0.4,
      lastPhrases: Array.isArray(p.lastPhrases) ? p.lastPhrases.map(String).slice(-8) : [],
      speechSkipsUsed: typeof (p as any).speechSkipsUsed === "number" ? Number((p as any).speechSkipsUsed) : 0,
      voteHistory: Array.isArray(p.voteHistory)
        ? p.voteHistory.map((x: any) => ({ roundNo: Number(x.roundNo ?? 0), targetAgentId: String(x.targetAgentId ?? "") }))
        : [],
      speechHistory: Array.isArray(p.speechHistory)
        ? p.speechHistory.map((x: any) => ({ roundNo: Number(x.roundNo ?? 0), text: String(x.text ?? "") }))
        : [],
    };
  } catch {
    return createInitialMemory([]);
  }
}

export function rememberSpeech(memory: PlayerMemory, roundNo: number, text: string): PlayerMemory {
  return {
    ...memory,
    speechHistory: [...memory.speechHistory.slice(-10), { roundNo, text }],
    lastPhrases: [...memory.lastPhrases.slice(-5), text],
  };
}

export function rememberVote(memory: PlayerMemory, roundNo: number, targetAgentId: string): PlayerMemory {
  const next = { ...memory.suspectMap };
  next[targetAgentId] = Math.min(1, (next[targetAgentId] ?? 0.35) + 0.12);
  const focusTargets = Object.entries(next)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map((x) => x[0]);
  return {
    ...memory,
    suspectMap: next,
    focusTargets,
    voteHistory: [...memory.voteHistory.slice(-10), { roundNo, targetAgentId }],
  };
}

export function rememberSpeechSkip(memory: PlayerMemory): PlayerMemory {
  return {
    ...memory,
    speechSkipsUsed: (memory.speechSkipsUsed ?? 0) + 1,
  };
}

function normalizeForSimilarity(input: string) {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function trigrams(input: string) {
  const s = normalizeForSimilarity(input);
  if (s.length <= 3) return new Set([s]);
  const set = new Set<string>();
  for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
  return set;
}

export function jaccardSimilarity(a: string, b: string) {
  const aa = trigrams(a);
  const bb = trigrams(b);
  if (aa.size === 0 && bb.size === 0) return 1;
  let inter = 0;
  for (const t of aa) if (bb.has(t)) inter += 1;
  const union = aa.size + bb.size - inter;
  return union <= 0 ? 0 : inter / union;
}
