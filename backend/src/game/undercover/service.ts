import { getSql } from "@/db/client";
import { WORD_PAIRS, pickWordPair } from "@/game/undercover/wordbank";
import { chatJsonByAgent } from "@/lib/llm-client";
import { store } from "@/lib/storage";
import { getUpstashRealtime } from "@/runtime/upstash-realtime";

import {
  createInitialMemory,
  getDefaultDecodeConfig,
  getStrategyGuidance,
  jaccardSimilarity,
  looksTooSimilar,
  parseMemory,
  rememberSpeech,
  rememberVote,
  scheduleDecodeConfig,
  STRATEGY_SLOTS,
  type DecodeConfig,
  type PlayerMemory,
  type UndercoverStrategyKey,
} from "./strategy";
import type { UndercoverGame, UndercoverPhase, UndercoverPlayer, UndercoverRole, UndercoverState } from "./types";

const PLAYER_COUNT = 6;
const AI_COUNT = 5;
const AI_SPEAK_DELAY_MS = Number(process.env.UNDERCOVER_AI_SPEAK_DELAY_MS ?? 1800);
const AI_VOTE_DELAY_MS = Number(process.env.UNDERCOVER_AI_VOTE_DELAY_MS ?? 1400);
const PHASE_DELAY_MS = Number(process.env.UNDERCOVER_PHASE_DELAY_MS ?? 900);
const SPEECH_STREAM_CHUNK_MS = Number(process.env.UNDERCOVER_SPEECH_CHUNK_DELAY_MS ?? 120);
const LLM_RETRY = Number(process.env.UNDERCOVER_LLM_RETRY ?? 2);
const SPEECH_SIMILARITY_THRESHOLD = Number(process.env.UNDERCOVER_SPEECH_SIMILARITY_THRESHOLD ?? 0.4);
const VOTE_REASON_SIMILARITY_THRESHOLD = Number(process.env.UNDERCOVER_VOTE_REASON_SIMILARITY_THRESHOLD ?? 0.45);

const CLUE_DIMENSIONS = ["使用场景", "时间频率", "体验感受", "人群关系", "动作方式", "环境条件", "成本便利", "情绪联想"] as const;

function nowIso() {
  return new Date().toISOString();
}

function uid() {
  return crypto.randomUUID();
}

function sample<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)]!;
}

async function sleep(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupGameEphemeralAgents(input: { workspaceId: string; gameId: string }) {
  const players = await listPlayers(input.gameId);
  const ephemeralIds = players.filter((p) => !p.isHuman).map((p) => p.agentId);
  if (ephemeralIds.length === 0) return;
  await store.softDeleteAgentsByIds({ workspaceId: input.workspaceId, agentIds: ephemeralIds });
  await store.softDeleteOrphanGroups({ workspaceId: input.workspaceId });
}

function parseState(raw: string): UndercoverState {
  try {
    const parsed = JSON.parse(raw) as Partial<UndercoverState>;
    return {
      turnOrder: Array.isArray(parsed.turnOrder) ? parsed.turnOrder : [],
      turnIndex: typeof parsed.turnIndex === "number" ? parsed.turnIndex : 0,
      votersPending: Array.isArray(parsed.votersPending) ? parsed.votersPending : [],
      tieCandidates: Array.isArray(parsed.tieCandidates) ? parsed.tieCandidates : [],
    };
  } catch {
    return { turnOrder: [], turnIndex: 0, votersPending: [], tieCandidates: [] };
  }
}

function toIso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return nowIso();
}

function parseDecode(raw: string | null, fallback: DecodeConfig): DecodeConfig {
  if (!raw) return { ...fallback };
  try {
    const parsed = JSON.parse(raw) as Partial<DecodeConfig>;
    return {
      temperature: typeof parsed.temperature === "number" ? parsed.temperature : fallback.temperature,
      topP: typeof parsed.topP === "number" ? parsed.topP : fallback.topP,
      presencePenalty: typeof parsed.presencePenalty === "number" ? parsed.presencePenalty : fallback.presencePenalty,
      frequencyPenalty: typeof parsed.frequencyPenalty === "number" ? parsed.frequencyPenalty : fallback.frequencyPenalty,
    };
  } catch {
    return { ...fallback };
  }
}

function aliveOrder(players: UndercoverPlayer[]) {
  return players
    .filter((p) => p.alive)
    .sort((a, b) => a.seatNo - b.seatNo)
    .map((p) => p.agentId);
}

function escapeJsonBlock(raw: string) {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // continue
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function containsForbiddenWord(text: string, forbidden: string[]) {
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  for (const word of forbidden) {
    const w = String(word ?? "").replace(/\s+/g, "").toLowerCase();
    if (w && normalized.includes(w)) return true;
  }
  return false;
}

function containsMetaLeak(text: string) {
  const patterns = [/我拿到的词/, /我的词是/, /答案是/, /卧底词/, /平民词/, /secret/i, /keyword/i];
  return patterns.some((p) => p.test(text));
}

function looksLikeInternalReasoning(text: string) {
  const patterns = [
    /玩家/,
    /卧底/,
    /平民/,
    /建议/,
    /怀疑/,
    /误导/,
    /试探/,
    /分歧/,
    /投票/,
    /一号/,
    /二号/,
    /三号/,
    /四号/,
    /五号/,
    /六号/,
    /1号/,
    /2号/,
    /3号/,
    /4号/,
    /5号/,
    /6号/,
  ];
  return patterns.some((p) => p.test(text));
}

function sanitizeSpeech(text: string) {
  return text
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, "\"")
    .trim();
}

function getWordPairByGame(game: UndercoverGame) {
  return WORD_PAIRS.find((p) => p.civilian === game.civilianWord && p.undercover === game.undercoverWord) ?? null;
}

function normalizeSpeechForCompare(text: string) {
  return text
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?;；:：'"“”‘’（）()【】\[\]-]/g, "")
    .toLowerCase()
    .trim();
}

function isDuplicateSpeech(candidate: string, history: string[]) {
  const c = normalizeSpeechForCompare(candidate);
  if (!c) return true;
  for (const h of history) {
    const x = normalizeSpeechForCompare(h);
    if (!x) continue;
    if (c === x) return true;
    if (c.length > 8 && x.length > 8 && (c.includes(x) || x.includes(c))) return true;
  }
  return false;
}

function extractCjkPhrases(text: string) {
  const hit = text.match(/[\u4e00-\u9fa5]{2,6}/g) ?? [];
  return hit.map((x) => x.trim()).filter(Boolean);
}

function buildFrequentPhrases(texts: string[], minCount = 2, limit = 10) {
  const counter = new Map<string, number>();
  for (const text of texts) {
    for (const phrase of extractCjkPhrases(text)) {
      if (phrase.length < 2) continue;
      counter.set(phrase, (counter.get(phrase) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .filter((x) => x[1] >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map((x) => x[0]);
}

function overlapsFrequentPhrases(candidate: string, frequent: string[], maxAllowedHits = 1) {
  const hit = frequent.filter((x) => x.length >= 2 && candidate.includes(x));
  return { hit, tooMany: hit.length > maxAllowedHits };
}

function chooseClueDimension(agentId: string, roundNo: number) {
  const idx = Math.floor(hashUnit(`${agentId}:${roundNo}:dim`) * CLUE_DIMENSIONS.length) % CLUE_DIMENSIONS.length;
  return CLUE_DIMENSIONS[idx]!;
}

function pickNonDuplicateCandidate(candidates: string[], history: string[]) {
  for (const c of candidates) {
    if (!isDuplicateSpeech(c, history)) return c;
  }
  return candidates[0] ?? "线索更偏向实际使用感受。";
}

function buildSpeechFallback(input: {
  topic: string;
  dimension: string;
  role: UndercoverRole;
  roundNo: number;
  agentId: string;
  history: string[];
}) {
  const style = input.role === "undercover" ? "我更关注" : "我会优先看";
  const candidates = [
    `${style}${input.dimension}，在「${input.topic}」这个方向上差异很明显。`,
    `从${input.dimension}入手，比只看表面更容易分辨这个「${input.topic}」线索。`,
    `我这轮给${input.dimension}线索：它在「${input.topic}」里属于高频但易混淆的类型。`,
    `围绕${input.dimension}观察，会发现「${input.topic}」里的关键差别。`,
  ];
  const start = Math.floor(hashUnit(`${input.agentId}:${input.roundNo}:speech_fallback`) * candidates.length) % candidates.length;
  const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
  return pickNonDuplicateCandidate(ordered, input.history);
}

function buildVoteFallbackReason(input: {
  voterId: string;
  targetId: string;
  roundNo: number;
  targetSpeech: string;
  recentReasons: string[];
}) {
  const hint = input.targetSpeech ? sanitizeSpeech(input.targetSpeech).slice(0, 10) : "";
  const seed = `${input.voterId}:${input.targetId}:${input.roundNo}:vote_fallback`;
  const patterns = [
    hint ? `其发言“${hint}...”与全场线索衔接偏弱。` : "其发言与全场线索衔接偏弱。",
    hint ? `其表述“${hint}...”信息密度偏低，暂列优先排查。` : "其表述信息密度偏低，暂列优先排查。",
    hint ? `其线索“${hint}...”与回合主流方向偏离较大。` : "其线索与回合主流方向偏离较大。",
    "其表达重复度较高，缺少新增辨识信息。",
  ];
  const start = Math.floor(hashUnit(seed) * patterns.length) % patterns.length;
  const ordered = [...patterns.slice(start), ...patterns.slice(0, start)];
  return pickNonDuplicateCandidate(ordered, input.recentReasons);
}

function hashUnit(input: string) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

function withAgentDecodeJitter(base: DecodeConfig, agentId: string) {
  const u = hashUnit(agentId);
  const t = (u - 0.5) * 0.12;
  const p = (u - 0.5) * 0.06;
  return {
    temperature: Math.max(0.62, Math.min(1.12, base.temperature + t)),
    topP: Math.max(0.8, Math.min(0.98, base.topP + p)),
    presencePenalty: base.presencePenalty,
    frequencyPenalty: base.frequencyPenalty,
  };
}

function chooseVoteTargetFallback(input: {
  selfId: string;
  role: UndercoverRole;
  alivePlayers: UndercoverPlayer[];
  isTiebreak: boolean;
  tieCandidates: string[];
}) {
  const candidates = input.isTiebreak
    ? input.tieCandidates.filter((id) => id !== input.selfId)
    : input.alivePlayers.filter((p) => p.agentId !== input.selfId).map((p) => p.agentId);
  if (candidates.length === 0) throw new Error("no vote candidates");
  if (input.role === "undercover") {
    const civilians = input.alivePlayers
      .filter((p) => p.role === "civilian" && p.agentId !== input.selfId)
      .map((p) => p.agentId)
      .filter((id) => candidates.includes(id));
    if (civilians.length > 0) return sample(civilians);
  }
  return sample(candidates);
}

async function emitEvent(gameId: string, eventType: string, data: Record<string, unknown>) {
  try {
    await getUpstashRealtime().channel(`undercover:${gameId}`).emit(eventType, data);
  } catch {
    // best effort
  }
}

async function appendRoundEvent(input: {
  gameId: string;
  roundNo: number;
  phase: UndercoverPhase;
  eventType: string;
  actorAgentId?: string | null;
  targetAgentId?: string | null;
  payload: Record<string, unknown>;
}) {
  const sql = getSql();
  await sql/* sql */ `
    insert into undercover_round_events (
      id, game_id, round_no, phase, event_type, actor_agent_id, target_agent_id, payload_json, created_at
    ) values (
      ${uid()},
      ${input.gameId},
      ${input.roundNo},
      ${input.phase},
      ${input.eventType},
      ${input.actorAgentId ?? null},
      ${input.targetAgentId ?? null},
      ${JSON.stringify(input.payload)},
      ${nowIso()}
    )
  `;

  await emitEvent(input.gameId, `ui.undercover.${input.eventType}`, {
    gameId: input.gameId,
    roundNo: input.roundNo,
    phase: input.phase,
    actorAgentId: input.actorAgentId ?? null,
    targetAgentId: input.targetAgentId ?? null,
    payload: input.payload,
    at: Date.now(),
  });
}

async function emitGmNotice(input: {
  gameId: string;
  roundNo: number;
  phase: UndercoverPhase;
  message: string;
  level?: "info" | "warn";
  code?: string;
}) {
  await appendRoundEvent({
    gameId: input.gameId,
    roundNo: input.roundNo,
    phase: input.phase,
    eventType: "gm_notice",
    payload: {
      message: input.message,
      level: input.level ?? "info",
      code: input.code ?? null,
    },
  });
}

async function streamSpeechDelta(input: {
  gameId: string;
  roundNo: number;
  phase: UndercoverPhase;
  actorAgentId: string;
  text: string;
}) {
  const size = 6;
  let acc = "";
  for (let i = 0; i < input.text.length; i += size) {
    acc += input.text.slice(i, i + size);
    await emitEvent(input.gameId, "ui.undercover.speech_delta", {
      gameId: input.gameId,
      roundNo: input.roundNo,
      phase: input.phase,
      actorAgentId: input.actorAgentId,
      text: acc,
      done: false,
      at: Date.now(),
    });
    await sleep(SPEECH_STREAM_CHUNK_MS);
  }
  await emitEvent(input.gameId, "ui.undercover.speech_delta", {
    gameId: input.gameId,
    roundNo: input.roundNo,
    phase: input.phase,
    actorAgentId: input.actorAgentId,
    text: input.text,
    done: true,
    at: Date.now(),
  });
}

async function loadGame(gameId: string): Promise<UndercoverGame> {
  const sql = getSql();
  const rows = await sql/* sql */ `
    select *
    from undercover_games
    where id = ${gameId}
    limit 1
  `;
  if (!rows[0]) throw new Error("game not found");
  const row = rows[0] as Record<string, unknown>;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    status: row.status as UndercoverGame["status"],
    phase: row.phase as UndercoverGame["phase"],
    roundNo: Number(row.round_no),
    civilianWord: String(row.civilian_word),
    undercoverWord: String(row.undercover_word),
    humanAgentId: String(row.human_agent_id),
    groupId: String(row.group_id),
    currentTurnPlayerId: row.current_turn_player_id ? String(row.current_turn_player_id) : null,
    winnerSide: (row.winner_side ?? null) as UndercoverGame["winnerSide"],
    isTiebreak: Boolean(row.is_tiebreak),
    state: parseState(String(row.state_json)),
    startedAt: toIso(row.started_at),
    endedAt: row.ended_at ? toIso(row.ended_at) : null,
    createdAt: toIso(row.created_at),
  };
}

async function saveGame(game: UndercoverGame) {
  const sql = getSql();
  await sql/* sql */ `
    update undercover_games
    set
      status = ${game.status},
      phase = ${game.phase},
      round_no = ${game.roundNo},
      current_turn_player_id = ${game.currentTurnPlayerId},
      winner_side = ${game.winnerSide},
      is_tiebreak = ${game.isTiebreak},
      state_json = ${JSON.stringify(game.state)},
      ended_at = ${game.endedAt}
    where id = ${game.id}
  `;
}

async function listPlayers(gameId: string): Promise<UndercoverPlayer[]> {
  const sql = getSql();
  const rows = await sql/* sql */ `
    select
      p.game_id,
      p.agent_id,
      p.is_human,
      p.role,
      p.alive,
      p.seat_no,
      p.strategy_key,
      p.decode_json,
      p.memory_json,
      p.emotion_state,
      a.role as role_name
    from undercover_players p
    join agents a on a.id = p.agent_id
    where p.game_id = ${gameId}
    order by p.seat_no asc
  `;
  return rows.map((row: any) => ({
    gameId: row.game_id,
    agentId: row.agent_id,
    isHuman: Boolean(row.is_human),
    role: row.role as UndercoverRole,
    alive: Boolean(row.alive),
    seatNo: Number(row.seat_no),
    roleName: String(row.role_name),
    strategyKey: row.strategy_key ? String(row.strategy_key) : null,
    decodeJson: row.decode_json ? String(row.decode_json) : null,
    memoryJson: row.memory_json ? String(row.memory_json) : null,
    emotionState: row.emotion_state ? String(row.emotion_state) : null,
  }));
}

async function setPlayerRuntimeState(input: {
  gameId: string;
  agentId: string;
  memory?: PlayerMemory;
  emotionState?: string | null;
}) {
  const sql = getSql();
  await sql/* sql */ `
    update undercover_players
    set
      memory_json = ${input.memory ? JSON.stringify(input.memory) : null},
      emotion_state = ${input.emotionState ?? null}
    where game_id = ${input.gameId}
      and agent_id = ${input.agentId}
  `;
}

async function emitEmotion(input: { gameId: string; agentId: string; emotion: string }) {
  await emitEvent(input.gameId, "ui.undercover.emotion_update", {
    gameId: input.gameId,
    agentId: input.agentId,
    emotion: input.emotion,
    at: Date.now(),
  });
}

async function insertVote(input: {
  gameId: string;
  roundNo: number;
  voterAgentId: string;
  targetAgentId: string;
  isTiebreak: boolean;
  reason: string;
}) {
  const sql = getSql();
  await sql/* sql */ `
    insert into undercover_votes (
      id, game_id, round_no, voter_agent_id, target_agent_id, is_tiebreak, reason, created_at
    ) values (
      ${uid()},
      ${input.gameId},
      ${input.roundNo},
      ${input.voterAgentId},
      ${input.targetAgentId},
      ${input.isTiebreak},
      ${input.reason},
      ${nowIso()}
    )
  `;
}

async function listVotes(gameId: string, roundNo: number, isTiebreak: boolean) {
  const sql = getSql();
  const rows = await sql/* sql */ `
    select voter_agent_id, target_agent_id, reason
    from undercover_votes
    where game_id = ${gameId}
      and round_no = ${roundNo}
      and is_tiebreak = ${isTiebreak}
  `;
  return rows.map((row: any) => ({
    voter_agent_id: String(row.voter_agent_id),
    target_agent_id: String(row.target_agent_id),
    reason: String(row.reason),
  }));
}

async function getRecentPublicSignals(gameId: string, limit: number) {
  const sql = getSql();
  const rows = await sql/* sql */ `
    select round_no, event_type, actor_agent_id, target_agent_id, payload_json
    from undercover_round_events
    where game_id = ${gameId}
    order by created_at desc
    limit ${limit}
  `;
  return rows
    .reverse()
    .map((row: any) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(row.payload_json ?? "{}"));
      } catch {
        payload = {};
      }
      return {
        roundNo: Number(row.round_no),
        eventType: String(row.event_type),
        actorAgentId: row.actor_agent_id ? String(row.actor_agent_id) : null,
        targetAgentId: row.target_agent_id ? String(row.target_agent_id) : null,
        payload,
      };
    })
    .slice(-14);
}

async function generateSpeechByLLM(input: {
  game: UndercoverGame;
  actor: UndercoverPlayer;
  players: UndercoverPlayer[];
}) {
  const strategy = (input.actor.strategyKey ?? "steady_conservative") as UndercoverStrategyKey;
  const baseDecode = parseDecode(input.actor.decodeJson, getDefaultDecodeConfig(strategy));
  const decode = withAgentDecodeJitter(
    scheduleDecodeConfig(baseDecode, input.game.roundNo, input.game.phase),
    input.actor.agentId
  );
  const memory = parseMemory(input.actor.memoryJson);
  const events = await getRecentPublicSignals(input.game.id, 24);
  const pair = getWordPairByGame(input.game);
  const privateHints =
    input.actor.role === "undercover" ? pair?.undercoverHints ?? [] : pair?.civilianHints ?? [];
  const privateHintFocus = privateHints.length
    ? privateHints[Math.floor(hashUnit(`${input.actor.agentId}:${input.game.roundNo}:hint`) * privateHints.length)]!
    : "通用线索";
  const strategyStyle: Record<UndercoverStrategyKey, string> = {
    aggressive_analyst: "风格偏进攻：指出矛盾、给出怀疑方向，语气干脆。",
    steady_conservative: "风格偏稳健：谨慎描述，不暴露过多细节。",
    social_blender: "风格偏社交：自然顺滑，但要保留个人锚点。",
    chaos_disruptor: "风格偏扰动：制造分歧，但不要乱说关键词。",
    adaptive_deceiver: "风格偏伪装：优先生存，表达看似合理。",
  };
  const alive = input.players.filter((p) => p.alive).map((p) => ({ id: p.agentId, role: p.roleName, seatNo: p.seatNo }));

  const systemPrompt =
    `你是卧底游戏玩家，策略位=${strategy}。\n` +
    `必须只用中文输出。\n` +
    `严禁直接说出你自己的词，严禁出现“我拿到的词/我的词是/答案是”等泄露句式。\n` +
    `发言阶段只允许给“词语线索气泡”，禁止评价其他玩家，禁止讨论投票与怀疑。\n` +
    `你必须避免复读自己的历史表达，也不要复用其他玩家已经出现过的高频词片段。\n` +
    `禁止使用过于直给的专业名词，优先给中等抽象度线索。\n` +
    `${strategyStyle[strategy]}\n` +
    `严格输出 JSON，不要输出任何多余文本。`;

  const recentSpeeches = events
    .filter((e) => e.eventType === "speech")
    .map((e) => String((e.payload as any)?.text ?? ""))
    .filter(Boolean)
    .slice(-6);
  const recentHumanSpeeches = events
    .filter((e) => e.eventType === "speech" && e.actorAgentId === input.game.humanAgentId)
    .map((e) => String((e.payload as any)?.text ?? ""))
    .filter(Boolean)
    .slice(-3);
  const frequentPublicPhrases = buildFrequentPhrases(recentSpeeches, 2, 12);
  const requiredDimension = chooseClueDimension(input.actor.agentId, input.game.roundNo);
  const userPrompt =
    `当前你是玩家 ${input.actor.agentId}（显示名=${input.actor.roleName}），阵营身份=${input.actor.role}。\n` +
    `你的私有线索标签（只作内部参考，不可原样复述）：${JSON.stringify(privateHintFocus)}\n` +
    `当前主题：${pair?.topic ?? "通用主题"}\n` +
    `回合=${input.game.roundNo}, 阶段=${input.game.phase}\n` +
    `本轮你必须优先使用的线索维度=${requiredDimension}\n` +
    `近期高频表达片段（禁止复用其中2个及以上）=${JSON.stringify(frequentPublicPhrases)}\n` +
    `存活玩家=${JSON.stringify(alive)}\n` +
    `公共记录=${JSON.stringify(events)}\n` +
    `人类玩家最近发言=${JSON.stringify(recentHumanSpeeches)}\n` +
    `你的怀疑度=${JSON.stringify(memory.suspectMap)}\n` +
    `你最近话术=${JSON.stringify(memory.lastPhrases.slice(-3))}\n` +
    `输出格式: {"speech":"只包含词语线索的1句中文，不要分析他人","intent_tags":["..."],"target_hint":"none","risk_level":0.0}`;
  const duplicateHistory = [...recentSpeeches, ...memory.lastPhrases.slice(-4)];
  const forbidden = [input.game.civilianWord, input.game.undercoverWord];

  for (let i = 0; i <= LLM_RETRY; i++) {
    try {
      const raw = await chatJsonByAgent({
        agentId: input.actor.agentId,
        systemPrompt,
        userPrompt,
        decode: {
          temperature: decode.temperature,
          topP: decode.topP,
          presencePenalty: decode.presencePenalty,
          frequencyPenalty: decode.frequencyPenalty,
          maxTokens: 220,
        },
      });
      const parsed = escapeJsonBlock(raw);
      const speech = sanitizeSpeech(String(parsed?.speech ?? ""));
      if (!speech) throw new Error("empty speech");
      if (looksTooSimilar(speech, memory.lastPhrases)) throw new Error("speech too similar");
      if (isDuplicateSpeech(speech, duplicateHistory)) throw new Error("speech duplicated");
      const overlap = overlapsFrequentPhrases(speech, frequentPublicPhrases);
      if (overlap.tooMany) throw new Error("speech overuses frequent phrases");
      if (containsMetaLeak(speech)) throw new Error("speech meta leak");
      if (containsForbiddenWord(speech, forbidden)) throw new Error("speech leaked secret word");
      if (containsForbiddenWord(speech, privateHints)) throw new Error("speech exposed private hint");
      if (looksLikeInternalReasoning(speech)) throw new Error("speech looks like internal reasoning");
      if (speech.length < 8 || speech.length > 56) throw new Error("speech length invalid");
      const maxSim = recentSpeeches.reduce((m, x) => Math.max(m, jaccardSimilarity(speech, x)), 0);
      if (maxSim >= SPEECH_SIMILARITY_THRESHOLD) throw new Error("speech too similar to recent public speech");
      return { speech, memory };
    } catch {
      // retry
    }
  }

  const fallback = buildSpeechFallback({
    topic: pair?.topic ?? "通用主题",
    dimension: requiredDimension,
    role: input.actor.role,
    roundNo: input.game.roundNo,
    agentId: input.actor.agentId,
    history: duplicateHistory,
  });
  return { speech: fallback, memory };
}

async function generateVoteByLLM(input: {
  game: UndercoverGame;
  actor: UndercoverPlayer;
  players: UndercoverPlayer[];
  validTargets: string[];
}) {
  const strategy = (input.actor.strategyKey ?? "steady_conservative") as UndercoverStrategyKey;
  const baseDecode = parseDecode(input.actor.decodeJson, getDefaultDecodeConfig(strategy));
  const decode = withAgentDecodeJitter(
    scheduleDecodeConfig(baseDecode, input.game.roundNo, input.game.phase),
    input.actor.agentId
  );
  const memory = parseMemory(input.actor.memoryJson);
  const events = await getRecentPublicSignals(input.game.id, 24);
  const recentHumanPublic = events
    .filter((e) => e.eventType === "speech" && e.actorAgentId === input.game.humanAgentId)
    .map((e) => String((e.payload as any)?.text ?? ""))
    .filter(Boolean)
    .slice(-4);
  const recentVoteReasons = events
    .filter((e) => e.eventType === "vote")
    .map((e) => String((e.payload as any)?.reason ?? ""))
    .filter(Boolean)
    .slice(-8);
  const frequentVotePhrases = buildFrequentPhrases(recentVoteReasons, 2, 8);

  const systemPrompt =
    `你是卧底游戏玩家，策略位=${strategy}，只允许中文输出。\n` +
    `你必须输出严格 JSON，不能解释。\n` +
    `投票目标只能从提供候选里选择。`;

  const userPrompt =
    `当前你是玩家 ${input.actor.agentId}（${input.actor.roleName}），身份=${input.actor.role}\n` +
    `回合=${input.game.roundNo}, 阶段=${input.game.phase}\n` +
    `候选目标=${JSON.stringify(input.validTargets)}\n` +
    `公共记录=${JSON.stringify(events)}\n` +
    `人类玩家最近公开发言=${JSON.stringify(recentHumanPublic)}\n` +
    `近期高频投票话术（尽量避开）=${JSON.stringify(frequentVotePhrases)}\n` +
    `你的怀疑度=${JSON.stringify(memory.suspectMap)}\n` +
    `输出格式: {"vote_target":"agent_id","reason":"一句中文理由","confidence":0.0}`;

  const forbidden = [input.game.civilianWord, input.game.undercoverWord];

  for (let i = 0; i <= LLM_RETRY; i++) {
    try {
      const raw = await chatJsonByAgent({
        agentId: input.actor.agentId,
        systemPrompt,
        userPrompt,
        decode: {
          temperature: decode.temperature,
          topP: decode.topP,
          presencePenalty: decode.presencePenalty,
          frequencyPenalty: decode.frequencyPenalty,
          maxTokens: 180,
        },
      });
      const parsed = escapeJsonBlock(raw);
      const voteTarget = String(parsed?.vote_target ?? "").trim();
      const reason = sanitizeSpeech(String(parsed?.reason ?? ""));
      if (!input.validTargets.includes(voteTarget)) throw new Error("invalid target");
      if (!reason) throw new Error("empty reason");
      const reasonOverlap = overlapsFrequentPhrases(reason, frequentVotePhrases, 2);
      if (reasonOverlap.tooMany) throw new Error("vote reason overuses frequent phrases");
      const voteMaxSim = recentVoteReasons.reduce((m: number, x: string) => Math.max(m, jaccardSimilarity(reason, x)), 0);
      if (voteMaxSim >= VOTE_REASON_SIMILARITY_THRESHOLD) throw new Error("vote reason too similar");
      if (containsMetaLeak(reason)) throw new Error("vote reason meta leak");
      if (containsForbiddenWord(reason, forbidden)) throw new Error("vote reason leaked secret word");
      return { voteTarget, reason, memory };
    } catch {
      // retry
    }
  }

  const target = chooseVoteTargetFallback({
    selfId: input.actor.agentId,
    role: input.actor.role,
    alivePlayers: input.players.filter((p) => p.alive),
    isTiebreak: input.game.phase === "round_tiebreak_voting",
    tieCandidates: input.game.state.tieCandidates,
  });
  const targetSpeech = events
    .filter((e) => e.eventType === "speech" && e.actorAgentId === target)
    .map((e) => String((e.payload as any)?.text ?? ""))
    .filter(Boolean)
    .slice(-1)[0] ?? "";
  const fallbackReason = buildVoteFallbackReason({
    voterId: input.actor.agentId,
    targetId: target,
    roundNo: input.game.roundNo,
    targetSpeech,
    recentReasons: recentVoteReasons,
  });
  return { voteTarget: target, reason: fallbackReason, memory };
}

async function resolveRoundElimination(game: UndercoverGame, players: UndercoverPlayer[]) {
  const votes = await listVotes(game.id, game.roundNo, game.isTiebreak);
  const candidates = game.isTiebreak
    ? game.state.tieCandidates
    : players.filter((p) => p.alive).map((p) => p.agentId);

  const score = new Map<string, number>();
  for (const c of candidates) score.set(c, 0);
  for (const vote of votes) score.set(vote.target_agent_id, (score.get(vote.target_agent_id) ?? 0) + 1);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] ?? 0;
  const ties = ranked.filter((x) => x[1] === top).map((x) => x[0]);

  if (ties.length > 1 && !game.isTiebreak) {
    game.phase = "round_tiebreak_speaking";
    game.isTiebreak = true;
    game.state.tieCandidates = ties;
    game.state.turnOrder = ties;
    game.state.turnIndex = 0;
    game.state.votersPending = [];
    game.currentTurnPlayerId = game.state.turnOrder[0] ?? null;
    await appendRoundEvent({
      gameId: game.id,
      roundNo: game.roundNo,
      phase: game.phase,
      eventType: "phase_change",
      payload: { to: game.phase, tieCandidates: ties },
    });
    return;
  }

  const eliminatedAgentId = ties.length === 1 ? ties[0]! : sample(ties);
  const sql = getSql();
  await sql/* sql */ `
    update undercover_players
    set alive = false, emotion_state = ${"eliminated"}
    where game_id = ${game.id}
      and agent_id = ${eliminatedAgentId}
  `;
  await emitEmotion({ gameId: game.id, agentId: eliminatedAgentId, emotion: "eliminated" });

  const eliminated = players.find((p) => p.agentId === eliminatedAgentId);
  await appendRoundEvent({
    gameId: game.id,
    roundNo: game.roundNo,
    phase: "round_elimination",
    eventType: "elimination",
    actorAgentId: eliminatedAgentId,
    payload: { eliminatedAgentId, role: eliminated?.role ?? "civilian", tiebreak: game.isTiebreak },
  });

  const refreshedPlayers = await listPlayers(game.id);
  const aliveCount = refreshedPlayers.filter((p) => p.alive).length;
  const undercoverAlive = refreshedPlayers.some((p) => p.role === "undercover" && p.alive);

  if (!undercoverAlive) {
    game.status = "finished";
    game.phase = "game_over";
    game.winnerSide = "civilian";
    game.currentTurnPlayerId = null;
    game.endedAt = nowIso();
    await appendRoundEvent({
      gameId: game.id,
      roundNo: game.roundNo,
      phase: game.phase,
      eventType: "game_over",
      payload: { winner: "civilian" },
    });
    await cleanupGameEphemeralAgents({ workspaceId: game.workspaceId, gameId: game.id });
    return;
  }

  if (aliveCount <= 3) {
    game.status = "finished";
    game.phase = "game_over";
    game.winnerSide = "undercover";
    game.currentTurnPlayerId = null;
    game.endedAt = nowIso();
    await appendRoundEvent({
      gameId: game.id,
      roundNo: game.roundNo,
      phase: game.phase,
      eventType: "game_over",
      payload: { winner: "undercover" },
    });
    await cleanupGameEphemeralAgents({ workspaceId: game.workspaceId, gameId: game.id });
    return;
  }

  game.roundNo += 1;
  game.phase = "round_speaking";
  game.isTiebreak = false;
  game.state.tieCandidates = [];
  game.state.turnOrder = aliveOrder(refreshedPlayers);
  game.state.turnIndex = 0;
  game.state.votersPending = [];
  game.currentTurnPlayerId = game.state.turnOrder[0] ?? null;
  await appendRoundEvent({
    gameId: game.id,
    roundNo: game.roundNo,
    phase: game.phase,
    eventType: "phase_change",
    payload: { to: game.phase, roundNo: game.roundNo },
  });
}

async function advanceGameAuto(gameId: string) {
  let safety = 0;
  while (safety < 120) {
    safety += 1;
    const game = await loadGame(gameId);
    if (game.status === "finished" || game.phase === "game_over") return;

    const players = await listPlayers(gameId);
    const alivePlayers = players.filter((p) => p.alive);

    if (game.phase === "round_speaking" || game.phase === "round_tiebreak_speaking") {
      const actorId = game.state.turnOrder[game.state.turnIndex] ?? null;
      if (!actorId) {
        game.phase = game.phase === "round_speaking" ? "round_voting" : "round_tiebreak_voting";
        game.state.votersPending = alivePlayers.map((p) => p.agentId);
        game.currentTurnPlayerId = game.state.votersPending[0] ?? null;
        await sleep(PHASE_DELAY_MS);
        await appendRoundEvent({
          gameId,
          roundNo: game.roundNo,
          phase: game.phase,
          eventType: "phase_change",
          payload: { to: game.phase },
        });
        await saveGame(game);
        continue;
      }

      const actor = players.find((p) => p.agentId === actorId);
      if (!actor || !actor.alive) {
        game.state.turnIndex += 1;
        game.currentTurnPlayerId = game.state.turnOrder[game.state.turnIndex] ?? null;
        await saveGame(game);
        continue;
      }

      await emitEvent(gameId, "ui.undercover.turn_start", {
        gameId,
        roundNo: game.roundNo,
        phase: game.phase,
        actorAgentId: actor.agentId,
        at: Date.now(),
      });

      if (actor.isHuman) {
        game.currentTurnPlayerId = actor.agentId;
        await saveGame(game);
        return;
      }

      await sleep(AI_SPEAK_DELAY_MS);
      await emitEmotion({ gameId, agentId: actor.agentId, emotion: "thinking" });
      await setPlayerRuntimeState({ gameId, agentId: actor.agentId, emotionState: "thinking" });
      const generated = await generateSpeechByLLM({ game, actor, players });
      await emitEmotion({ gameId, agentId: actor.agentId, emotion: "speaking" });
      await setPlayerRuntimeState({ gameId, agentId: actor.agentId, emotionState: "speaking" });

      await streamSpeechDelta({
        gameId,
        roundNo: game.roundNo,
        phase: game.phase,
        actorAgentId: actor.agentId,
        text: generated.speech,
      });
      await store.sendMessage({
        groupId: game.groupId,
        senderId: actor.agentId,
        content: generated.speech,
        contentType: "text",
      });
      await appendRoundEvent({
        gameId,
        roundNo: game.roundNo,
        phase: game.phase,
        eventType: "speech",
        actorAgentId: actor.agentId,
        payload: { text: generated.speech },
      });

      const nextMemory = rememberSpeech(generated.memory, game.roundNo, generated.speech);
      await setPlayerRuntimeState({
        gameId,
        agentId: actor.agentId,
        memory: nextMemory,
        emotionState: "neutral",
      });
      await emitEmotion({ gameId, agentId: actor.agentId, emotion: "neutral" });
      await emitEvent(gameId, "ui.undercover.turn_end", {
        gameId,
        roundNo: game.roundNo,
        phase: game.phase,
        actorAgentId: actor.agentId,
        at: Date.now(),
      });

      game.state.turnIndex += 1;
      game.currentTurnPlayerId = game.state.turnOrder[game.state.turnIndex] ?? null;
      await saveGame(game);
      continue;
    }

    if (game.phase === "round_voting" || game.phase === "round_tiebreak_voting") {
      const voterId = game.state.votersPending[0] ?? null;
      if (!voterId) {
        game.phase = "round_elimination";
        game.currentTurnPlayerId = null;
        await sleep(PHASE_DELAY_MS);
        await appendRoundEvent({
          gameId,
          roundNo: game.roundNo,
          phase: game.phase,
          eventType: "phase_change",
          payload: { to: game.phase },
        });
        await saveGame(game);
        continue;
      }

      const voter = players.find((p) => p.agentId === voterId);
      if (!voter || !voter.alive) {
        game.state.votersPending = game.state.votersPending.slice(1);
        game.currentTurnPlayerId = game.state.votersPending[0] ?? null;
        await saveGame(game);
        continue;
      }

      await emitEvent(gameId, "ui.undercover.turn_start", {
        gameId,
        roundNo: game.roundNo,
        phase: game.phase,
        actorAgentId: voter.agentId,
        at: Date.now(),
      });

      if (voter.isHuman) {
        game.currentTurnPlayerId = voter.agentId;
        await saveGame(game);
        return;
      }

      await sleep(AI_VOTE_DELAY_MS);
      await emitEmotion({ gameId, agentId: voter.agentId, emotion: "suspicious" });
      await setPlayerRuntimeState({ gameId, agentId: voter.agentId, emotionState: "suspicious" });

      const validTargets =
        game.phase === "round_tiebreak_voting"
          ? game.state.tieCandidates.filter((id) => id !== voter.agentId)
          : alivePlayers.filter((p) => p.agentId !== voter.agentId).map((p) => p.agentId);
      const generated = await generateVoteByLLM({
        game,
        actor: voter,
        players,
        validTargets,
      });

      await insertVote({
        gameId,
        roundNo: game.roundNo,
        voterAgentId: voter.agentId,
        targetAgentId: generated.voteTarget,
        isTiebreak: game.phase === "round_tiebreak_voting",
        reason: generated.reason,
      });
      await appendRoundEvent({
        gameId,
        roundNo: game.roundNo,
        phase: game.phase,
        eventType: "vote",
        actorAgentId: voter.agentId,
        targetAgentId: generated.voteTarget,
        payload: {
          reason: generated.reason,
          isTiebreak: game.phase === "round_tiebreak_voting",
          strategy: voter.strategyKey ?? "steady_conservative",
        },
      });
      await emitEvent(gameId, "ui.undercover.vote_reveal", {
        gameId,
        roundNo: game.roundNo,
        actorAgentId: voter.agentId,
        targetAgentId: generated.voteTarget,
        reason: generated.reason,
        at: Date.now(),
      });

      const nextMemory = rememberVote(generated.memory, game.roundNo, generated.voteTarget);
      await setPlayerRuntimeState({
        gameId,
        agentId: voter.agentId,
        memory: nextMemory,
        emotionState: "neutral",
      });
      await emitEmotion({ gameId, agentId: voter.agentId, emotion: "neutral" });
      await emitEvent(gameId, "ui.undercover.turn_end", {
        gameId,
        roundNo: game.roundNo,
        phase: game.phase,
        actorAgentId: voter.agentId,
        at: Date.now(),
      });

      game.state.votersPending = game.state.votersPending.slice(1);
      game.currentTurnPlayerId = game.state.votersPending[0] ?? null;
      await saveGame(game);
      continue;
    }

    if (game.phase === "round_elimination") {
      await resolveRoundElimination(game, players);
      await saveGame(game);
      continue;
    }

    return;
  }
}

export async function createUndercoverGame(input: { workspaceId: string; humanAgentId?: string | null }) {
  const defaults = await store.ensureWorkspaceDefaults({ workspaceId: input.workspaceId });
  const humanAgentId = input.humanAgentId ?? defaults.humanAgentId;

  const aiMembers: Array<{ agentId: string; seatNo: number; strategy: UndercoverStrategyKey }> = [];
  for (let i = 0; i < AI_COUNT; i++) {
    const strategy = STRATEGY_SLOTS[i]!;
    const created = await store.createSubAgentWithP2P({
      workspaceId: input.workspaceId,
      creatorId: humanAgentId,
      role: `undercover_ai_${i + 1}_${strategy}`,
      kind: "game_ephemeral",
      autoRunEnabled: false,
      originType: "undercover_game",
      guidance:
        `${getStrategyGuidance(strategy)}\n` +
        "You are playing Who-is-Undercover. Output must be Chinese in game rounds.",
    });
    aiMembers.push({ agentId: created.agentId, seatNo: i + 2, strategy });
  }

  const members = [humanAgentId, ...aiMembers.map((x) => x.agentId)];
  const group = await store.createGroup({
    workspaceId: input.workspaceId,
    memberIds: members,
    name: `undercover-${Date.now()}`,
    kind: "game_undercover",
  });

  const gameId = uid();
  const pair = pickWordPair(gameId, { minDifficulty: "normal", preferHard: true });
  const undercoverAgentId = sample(members);
  const state: UndercoverState = {
    turnOrder: members,
    turnIndex: 0,
    votersPending: [],
    tieCandidates: [],
  };
  const createdAt = nowIso();
  const sql = getSql();
  await sql/* sql */ `
    insert into undercover_games (
      id, workspace_id, status, phase, round_no, civilian_word, undercover_word,
      human_agent_id, group_id, current_turn_player_id, winner_side, is_tiebreak,
      state_json, started_at, ended_at, created_at
    ) values (
      ${gameId},
      ${input.workspaceId},
      ${"running"},
      ${"round_speaking"},
      ${1},
      ${pair.civilian},
      ${pair.undercover},
      ${humanAgentId},
      ${group.id},
      ${members[0]!},
      ${null},
      ${false},
      ${JSON.stringify(state)},
      ${createdAt},
      ${null},
      ${createdAt}
    )
  `;

  for (let i = 0; i < members.length; i++) {
    const agentId = members[i]!;
    const role: UndercoverRole = agentId === undercoverAgentId ? "undercover" : "civilian";
    const ai = aiMembers.find((x) => x.agentId === agentId);
    const strategy = ai?.strategy ?? null;
    const decode = strategy ? getDefaultDecodeConfig(strategy) : null;
    const memory = createInitialMemory(members);
    await sql/* sql */ `
      insert into undercover_players (
        game_id, agent_id, is_human, role, alive, seat_no, strategy_key, decode_json, memory_json, emotion_state
      ) values (
        ${gameId},
        ${agentId},
        ${agentId === humanAgentId},
        ${role},
        ${true},
        ${i + 1},
        ${strategy},
        ${decode ? JSON.stringify(decode) : null},
        ${JSON.stringify(memory)},
        ${"neutral"}
      )
    `;
  }

  const humanRole: UndercoverRole = undercoverAgentId === humanAgentId ? "undercover" : "civilian";
  const humanWord = humanRole === "undercover" ? pair.undercover : pair.civilian;

  await appendRoundEvent({
    gameId,
    roundNo: 1,
    phase: "round_speaking",
    eventType: "phase_change",
    payload: { to: "round_speaking", roundNo: 1, playerCount: PLAYER_COUNT, topic: pair.topic },
  });
  await emitGmNotice({
    gameId,
    roundNo: 1,
    phase: "round_speaking",
    level: "info",
    code: "game_start",
    message: `GM：本局主题为「${pair.topic}」，难度「${pair.difficulty}」。发言禁止直接说词或同义直指。`,
  });
  await emitEvent(gameId, "ui.undercover.game_created", { gameId, workspaceId: input.workspaceId });
  await advanceGameAuto(gameId);

  const detail = await getUndercoverGame(gameId);
  return {
    ...detail,
    humanRole,
    humanWord,
    topic: pair.topic,
  };
}

export async function listUndercoverGames(workspaceId: string) {
  const sql = getSql();
  const rows = await sql/* sql */ `
    select id, status, phase, round_no, winner_side, created_at
    from undercover_games
    where workspace_id = ${workspaceId}
    order by created_at desc
    limit 30
  `;
  return rows.map((row: any) => ({
    id: String(row.id),
    status: String(row.status),
    phase: String(row.phase),
    roundNo: Number(row.round_no),
    winnerSide: row.winner_side ? String(row.winner_side) : null,
    createdAt: toIso(row.created_at),
  }));
}

export async function getUndercoverGame(gameId: string) {
  const game = await loadGame(gameId);
  const players = await listPlayers(gameId);
  const humanPlayer = players.find((p) => p.agentId === game.humanAgentId);
  const humanRole: UndercoverRole = humanPlayer?.role === "undercover" ? "undercover" : "civilian";
  const humanWord = humanRole === "undercover" ? game.undercoverWord : game.civilianWord;
  const pair = getWordPairByGame(game);
  const safeGame: UndercoverGame = {
    ...game,
    civilianWord: "[hidden]",
    undercoverWord: "[hidden]",
  };
  const reveal =
    game.status === "finished"
      ? {
          topic: pair?.topic ?? "未知",
          difficulty: pair?.difficulty ?? "normal",
          civilianWord: game.civilianWord,
          undercoverWord: game.undercoverWord,
          civilianHints: pair?.civilianHints ?? [],
          undercoverHints: pair?.undercoverHints ?? [],
        }
      : null;
  return { game: safeGame, players, humanRole, humanWord, reveal };
}

export async function listUndercoverEvents(gameId: string) {
  const sql = getSql();
  const rows = await sql/* sql */ `
    select id, round_no, phase, event_type, actor_agent_id, target_agent_id, payload_json, created_at
    from undercover_round_events
    where game_id = ${gameId}
    order by created_at asc
  `;
  return rows.map((row: any) => {
    const payloadRaw = row.payload_json ? String(row.payload_json) : "{}";
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      payload = {};
    }
    return {
      id: String(row.id),
      roundNo: Number(row.round_no),
      phase: String(row.phase),
      eventType: String(row.event_type),
      actorAgentId: row.actor_agent_id ? String(row.actor_agent_id) : null,
      targetAgentId: row.target_agent_id ? String(row.target_agent_id) : null,
      payload,
      createdAt: toIso(row.created_at),
    };
  });
}

export async function submitHumanSpeech(input: { gameId: string; actorAgentId: string; text: string }) {
  const game = await loadGame(input.gameId);
  if (!(game.phase === "round_speaking" || game.phase === "round_tiebreak_speaking")) {
    throw new Error("not in speaking phase");
  }
  if (game.currentTurnPlayerId !== input.actorAgentId) throw new Error("not your turn");

  const players = await listPlayers(input.gameId);
  const actor = players.find((p) => p.agentId === input.actorAgentId);
  if (!actor || !actor.isHuman || !actor.alive) throw new Error("human actor invalid");

  const text = sanitizeSpeech(input.text);
  if (!text) throw new Error("speech text is empty");
  const forbidden = [game.civilianWord, game.undercoverWord];
  if (containsForbiddenWord(text, forbidden)) {
    await emitGmNotice({
      gameId: game.id,
      roundNo: game.roundNo,
      phase: game.phase,
      level: "warn",
      code: "speech_leak",
      message: "GM判定：发言违规，禁止直接说出词语本身。请更换为间接线索。",
    });
    throw new Error("GM判定违规：发言包含敏感词");
  }
  if (containsMetaLeak(text) || looksLikeInternalReasoning(text)) {
    await emitGmNotice({
      gameId: game.id,
      roundNo: game.roundNo,
      phase: game.phase,
      level: "warn",
      code: "speech_rule",
      message: "GM判定：发言应是词语线索，不应讨论身份、投票或推理过程。",
    });
    throw new Error("GM判定违规：发言不符合线索规则");
  }

  await emitEvent(game.id, "ui.undercover.turn_start", {
    gameId: game.id,
    roundNo: game.roundNo,
    phase: game.phase,
    actorAgentId: input.actorAgentId,
    at: Date.now(),
  });
  await emitEmotion({ gameId: game.id, agentId: input.actorAgentId, emotion: "speaking" });
  await streamSpeechDelta({
    gameId: game.id,
    roundNo: game.roundNo,
    phase: game.phase,
    actorAgentId: input.actorAgentId,
    text,
  });
  await store.sendMessage({
    groupId: game.groupId,
    senderId: input.actorAgentId,
    content: text,
    contentType: "text",
  });
  await appendRoundEvent({
    gameId: game.id,
    roundNo: game.roundNo,
    phase: game.phase,
    eventType: "speech",
    actorAgentId: input.actorAgentId,
    payload: { text },
  });
  const memory = rememberSpeech(parseMemory(actor.memoryJson), game.roundNo, text);
  await setPlayerRuntimeState({
    gameId: game.id,
    agentId: input.actorAgentId,
    memory,
    emotionState: "neutral",
  });
  await emitEmotion({ gameId: game.id, agentId: input.actorAgentId, emotion: "neutral" });
  await emitEvent(game.id, "ui.undercover.turn_end", {
    gameId: game.id,
    roundNo: game.roundNo,
    phase: game.phase,
    actorAgentId: input.actorAgentId,
    at: Date.now(),
  });

  game.state.turnIndex += 1;
  game.currentTurnPlayerId = game.state.turnOrder[game.state.turnIndex] ?? null;
  await saveGame(game);
  await advanceGameAuto(game.id);
  return getUndercoverGame(game.id);
}

export async function submitHumanVote(input: {
  gameId: string;
  voterAgentId: string;
  targetAgentId: string;
  reason: string;
}) {
  const game = await loadGame(input.gameId);
  if (!(game.phase === "round_voting" || game.phase === "round_tiebreak_voting")) {
    throw new Error("not in voting phase");
  }
  if (game.currentTurnPlayerId !== input.voterAgentId) throw new Error("not your turn");
  if (input.targetAgentId === input.voterAgentId) throw new Error("cannot vote self");

  const players = await listPlayers(game.id);
  const voter = players.find((p) => p.agentId === input.voterAgentId);
  if (!voter || !voter.isHuman || !voter.alive) throw new Error("human voter invalid");

  const validTargets =
    game.phase === "round_tiebreak_voting"
      ? game.state.tieCandidates.filter((id) => id !== input.voterAgentId)
      : players.filter((p) => p.alive && p.agentId !== input.voterAgentId).map((p) => p.agentId);
  if (!validTargets.includes(input.targetAgentId)) throw new Error("invalid target");

  const reason = sanitizeSpeech(input.reason) || "描述存在不一致。";
  const forbidden = [game.civilianWord, game.undercoverWord];
  if (containsForbiddenWord(reason, forbidden) || containsMetaLeak(reason)) {
    await emitGmNotice({
      gameId: game.id,
      roundNo: game.roundNo,
      phase: game.phase,
      level: "warn",
      code: "vote_leak",
      message: "GM判定：投票理由包含违规词，请使用行为线索描述理由。",
    });
    throw new Error("GM判定违规：投票理由不合规");
  }
  await emitEvent(game.id, "ui.undercover.turn_start", {
    gameId: game.id,
    roundNo: game.roundNo,
    phase: game.phase,
    actorAgentId: input.voterAgentId,
    at: Date.now(),
  });
  await insertVote({
    gameId: game.id,
    roundNo: game.roundNo,
    voterAgentId: input.voterAgentId,
    targetAgentId: input.targetAgentId,
    isTiebreak: game.phase === "round_tiebreak_voting",
    reason,
  });
  await appendRoundEvent({
    gameId: game.id,
    roundNo: game.roundNo,
    phase: game.phase,
    eventType: "vote",
    actorAgentId: input.voterAgentId,
    targetAgentId: input.targetAgentId,
    payload: { reason, isTiebreak: game.phase === "round_tiebreak_voting" },
  });
  await emitEvent(game.id, "ui.undercover.vote_reveal", {
    gameId: game.id,
    roundNo: game.roundNo,
    actorAgentId: input.voterAgentId,
    targetAgentId: input.targetAgentId,
    reason,
    at: Date.now(),
  });

  const memory = rememberVote(parseMemory(voter.memoryJson), game.roundNo, input.targetAgentId);
  await setPlayerRuntimeState({
    gameId: game.id,
    agentId: input.voterAgentId,
    memory,
    emotionState: "neutral",
  });
  await emitEvent(game.id, "ui.undercover.turn_end", {
    gameId: game.id,
    roundNo: game.roundNo,
    phase: game.phase,
    actorAgentId: input.voterAgentId,
    at: Date.now(),
  });

  game.state.votersPending = game.state.votersPending.filter((id) => id !== input.voterAgentId);
  game.currentTurnPlayerId = game.state.votersPending[0] ?? null;
  await saveGame(game);
  await advanceGameAuto(game.id);
  return getUndercoverGame(game.id);
}

export async function getUndercoverReview(gameId: string) {
  const sql = getSql();
  const existing = await sql/* sql */ `
    select summary_json, narrative_text, created_at
    from undercover_reviews
    where game_id = ${gameId}
    limit 1
  `;
  if (existing[0]) {
    const row = existing[0] as any;
    const parsed = JSON.parse(String(row.summary_json ?? "{}")) as Record<string, unknown>;
    const hasNewShape = Array.isArray((parsed as any).playerStats) || Array.isArray((parsed as any).turningPoints);
    return {
      ...(hasNewShape ? parsed : { summary: parsed }),
      narrative: String(row.narrative_text),
      createdAt: toIso(row.created_at),
    };
  }

  const detail = await getUndercoverGame(gameId);
  const events = await listUndercoverEvents(gameId);
  const votes = events.filter((e) => e.eventType === "vote").length;
  const speeches = events.filter((e) => e.eventType === "speech").length;
  const eliminations = events.filter((e) => e.eventType === "elimination").length;
  const keyTurns = events
    .filter((e) => e.eventType === "elimination" || e.eventType === "phase_change" || e.eventType === "game_over")
    .slice(-8)
    .map((e) => ({ roundNo: e.roundNo, type: e.eventType, payload: e.payload }));

  const summary = {
    winner: detail.game.winnerSide,
    totalRounds: detail.game.roundNo,
    totalSpeeches: speeches,
    totalVotes: votes,
    eliminations,
    keyTurns,
    revealed: detail.reveal ?? null,
  };
  const playersById = new Map(detail.players.map((p) => [p.agentId, p]));
  const voteEvents = events.filter((e) => e.eventType === "vote");
  const eliminationEvents = events.filter((e) => e.eventType === "elimination");
  const undercoverId = detail.players.find((p) => p.role === "undercover")?.agentId ?? null;
  const playerStats = detail.players
    .slice()
    .sort((a, b) => a.seatNo - b.seatNo)
    .map((p) => {
      const selfVotes = voteEvents.filter((v) => v.actorAgentId === p.agentId);
      const votedUndercover = undercoverId
        ? selfVotes.filter((v) => v.targetAgentId === undercoverId).length
        : 0;
      const gotVotes = voteEvents.filter((v) => v.targetAgentId === p.agentId).length;
      return {
        seatNo: p.seatNo,
        agentId: p.agentId,
        role: p.role,
        alive: p.alive,
        votesCast: selfVotes.length,
        votedUndercover,
        gotVotes,
      };
    });
  const turningPoints = eliminationEvents
    .map((e) => {
      const eliminatedId = String((e.payload as any)?.eliminatedAgentId ?? e.actorAgentId ?? "");
      const role = String((e.payload as any)?.role ?? playersById.get(eliminatedId)?.role ?? "civilian");
      const player = playersById.get(eliminatedId);
      return {
        roundNo: e.roundNo,
        event: `第${e.roundNo}轮淘汰${player ? `玩家${player.seatNo}` : eliminatedId}`,
        role,
        impact:
          role === "undercover"
            ? "卧底被清除，平民阵营直接获胜。"
            : "淘汰的是平民，卧底生存空间扩大。",
      };
    })
    .slice(-4);

  const narrativeLines = [
    detail.game.winnerSide === "undercover"
      ? "本局结果：卧底通过生存与分票策略拖入终盘并获胜。"
      : "本局结果：平民通过信息收敛成功锁定卧底并获胜。",
    detail.reveal
      ? `词面复盘：平民词「${detail.reveal.civilianWord}」，卧底词「${detail.reveal.undercoverWord}」。`
      : "词面复盘：当前对局尚未揭示词面。",
    turningPoints.length
      ? `关键转折：${turningPoints.map((x) => `${x.event}（${x.impact}）`).join("；")}`
      : "关键转折：本局未产生明确淘汰拐点。",
  ];
  const narrative = narrativeLines.join("\n");
  const report = {
    summary,
    turningPoints,
    playerStats,
    narrative,
  };

  await sql/* sql */ `
    insert into undercover_reviews (game_id, summary_json, narrative_text, created_at)
    values (${gameId}, ${JSON.stringify(report)}, ${narrative}, ${nowIso()})
  `;

  return { ...report, createdAt: nowIso() };
}

export function getUndercoverWordbank() {
  return WORD_PAIRS;
}
