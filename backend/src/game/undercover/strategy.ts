export type UndercoverStrategyKey =
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
  voteHistory: Array<{ roundNo: number; targetAgentId: string }>;
  speechHistory: Array<{ roundNo: number; text: string }>;
};

export const STRATEGY_SLOTS: UndercoverStrategyKey[] = [
  "aggressive_analyst",
  "steady_conservative",
  "social_blender",
  "chaos_disruptor",
  "adaptive_deceiver",
];

const DECODE_DEFAULTS: Record<UndercoverStrategyKey, DecodeConfig> = {
  aggressive_analyst: { temperature: 0.82, topP: 0.9, presencePenalty: 0.35, frequencyPenalty: 0.25 },
  steady_conservative: { temperature: 0.68, topP: 0.86, presencePenalty: 0.2, frequencyPenalty: 0.18 },
  social_blender: { temperature: 0.9, topP: 0.94, presencePenalty: 0.42, frequencyPenalty: 0.3 },
  chaos_disruptor: { temperature: 1.03, topP: 0.96, presencePenalty: 0.5, frequencyPenalty: 0.35 },
  adaptive_deceiver: { temperature: 0.88, topP: 0.92, presencePenalty: 0.36, frequencyPenalty: 0.28 },
};

const GUIDANCE: Record<UndercoverStrategyKey, string> = {
  aggressive_analyst:
    "You are high-pressure analyst. In each round, find contradictions and push concrete suspicion targets.",
  steady_conservative:
    "You are stable and risk-controlled. Speak concise, avoid overexposure, and vote with evidence.",
  social_blender:
    "You are socially adaptive. Blend into group tone while keeping subtle independent clues.",
  chaos_disruptor:
    "You are a disruptor. Introduce controlled uncertainty and force others to reveal positions.",
  adaptive_deceiver:
    "You are adaptive deceiver. If undercover prioritize survival and misdirection; if civilian prioritize detection.",
};

export function getStrategyGuidance(key: UndercoverStrategyKey) {
  return GUIDANCE[key];
}

export function getDefaultDecodeConfig(key: UndercoverStrategyKey): DecodeConfig {
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
      lastPhrases: Array.isArray(p.lastPhrases) ? p.lastPhrases.map(String).slice(-6) : [],
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
    speechHistory: [...memory.speechHistory.slice(-9), { roundNo, text }],
    lastPhrases: [...memory.lastPhrases.slice(-3), text],
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
    voteHistory: [...memory.voteHistory.slice(-9), { roundNo, targetAgentId }],
  };
}

export function looksTooSimilar(text: string, lastPhrases: string[]): boolean {
  const cur = text.trim();
  if (!cur) return true;
  const curHead = cur.slice(0, 10);
  for (const phrase of lastPhrases.slice(-2)) {
    const head = phrase.trim().slice(0, 10);
    if (head && head === curHead) return true;
  }
  return false;
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
