import { getSql } from "@/db/client";
import { chatJsonByAgent } from "@/lib/llm-client";
import { store } from "@/lib/storage";
import { getUpstashRealtime } from "@/runtime/upstash-realtime";

import {
  createInitialMemory,
  getDefaultDecodeConfig,
  getStrategyPersonaRules,
  getStrategyGuidance,
  jaccardSimilarity,
  parseMemory,
  rememberSpeech,
  rememberSpeechSkip,
  rememberVote,
  scheduleDecodeConfig,
  STRATEGY_SLOTS,
  type DecodeConfig,
  type PlayerMemory,
  type WerewolfStrategyKey,
} from "./strategy";
import type {
  WerewolfActionType,
  WerewolfGame,
  WerewolfNightState,
  WerewolfPhase,
  WerewolfPlayer,
  WerewolfRole,
  WerewolfState,
} from "./types";

const AI_COUNT = 5;
const AI_SPEAK_DELAY_MS = Number(process.env.WEREWOLF_AI_SPEAK_DELAY_MS ?? 1700);
const AI_VOTE_DELAY_MS = Number(process.env.WEREWOLF_AI_VOTE_DELAY_MS ?? 1300);
const AI_NIGHT_DELAY_MS = Number(process.env.WEREWOLF_AI_NIGHT_DELAY_MS ?? 1200);
const PHASE_DELAY_MS = Number(process.env.WEREWOLF_PHASE_DELAY_MS ?? 800);
const SPEECH_STREAM_CHUNK_MS = Number(process.env.WEREWOLF_SPEECH_CHUNK_DELAY_MS ?? 120);
const LLM_RETRY = Number(process.env.WEREWOLF_LLM_RETRY ?? 2);
const SPEECH_SIMILARITY_THRESHOLD = Number(process.env.WEREWOLF_SPEECH_SIMILARITY_THRESHOLD ?? 0.45);
const VOTE_REASON_SIMILARITY_THRESHOLD = Number(process.env.WEREWOLF_VOTE_REASON_SIMILARITY_THRESHOLD ?? 0.46);
const CINEMATIC_NIGHT_MS = Number(process.env.WEREWOLF_CINEMATIC_NIGHT_MS ?? 1200);
const CINEMATIC_DAWN_MS = Number(process.env.WEREWOLF_CINEMATIC_DAWN_MS ?? 1200);
const CINEMATIC_DEATH_MS = Number(process.env.WEREWOLF_CINEMATIC_DEATH_MS ?? 1600);
const SPEECH_COUNTDOWN_SEC = Number(process.env.WEREWOLF_TURN_COUNTDOWN_SPEECH_SEC ?? 18);
const VOTE_COUNTDOWN_SEC = Number(process.env.WEREWOLF_TURN_COUNTDOWN_VOTE_SEC ?? 12);
const SPEECH_SKIP_LIMIT = 1;

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

function defaultNightState(): WerewolfNightState {
  return {
    wolfVotes: {},
    pendingKill: null,
    seerCheckTarget: null,
    seerResult: null,
    witchHealUsed: false,
    witchPoisonUsed: false,
    witchSaved: false,
    witchPoisonTarget: null,
    deathsLastNight: [],
  };
}

function parseState(raw: string): WerewolfState {
  try {
    const parsed = JSON.parse(raw) as Partial<WerewolfState>;
    return {
      turnOrder: Array.isArray(parsed.turnOrder) ? parsed.turnOrder.map(String) : [],
      turnIndex: typeof parsed.turnIndex === "number" ? parsed.turnIndex : 0,
      votersPending: Array.isArray(parsed.votersPending) ? parsed.votersPending.map(String) : [],
      tieCandidates: Array.isArray(parsed.tieCandidates) ? parsed.tieCandidates.map(String) : [],
      isTiebreak: Boolean(parsed.isTiebreak),
      night:
        parsed.night && typeof parsed.night === "object"
          ? {
              ...defaultNightState(),
              ...parsed.night,
              wolfVotes:
                (parsed.night as any).wolfVotes && typeof (parsed.night as any).wolfVotes === "object"
                  ? (parsed.night as any).wolfVotes
                  : {},
              deathsLastNight: Array.isArray((parsed.night as any).deathsLastNight)
                ? (parsed.night as any).deathsLastNight.map(String)
                : [],
            }
          : defaultNightState(),
    };
  } catch {
    return { turnOrder: [], turnIndex: 0, votersPending: [], tieCandidates: [], isTiebreak: false, night: defaultNightState() };
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

function sanitizeText(text: string) {
  return text.replace(/\s+/g, " ").replace(/[“”]/g, "\"").trim();
}

function containsMetaLeak(text: string) {
  const patterns = [/系统提示/, /提示词/, /prompt/i, /secret/i, /keyword/i, /api[\s_-]?key/i];
  return patterns.some((p) => p.test(text));
}

function normalizeSpeechForCompare(text: string) {
  return text
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?;:：“”"'（）()【】\[\]-]/g, "")
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

function hasTemplateTalk(text: string) {
  const low = text.toLowerCase();
  const list = ["描述偏空泛", "先投这一位", "先观察一轮", "感觉像", "同上", "没什么可说"];
  return list.some((x) => text.includes(x) || low.includes(x.toLowerCase()));
}

function hasObservableAnchor(text: string) {
  const anchors = ["发言", "投票", "前后", "矛盾", "回避", "逻辑", "站边", "细节", "轮", "票"];
  return anchors.some((x) => text.includes(x));
}

function hasFictionalSceneTerms(text: string) {
  const terms = ["东区", "西区", "南区", "北区", "村口", "林间", "仓库", "广场", "小路", "徘徊"];
  return terms.some((x) => text.includes(x));
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
  return {
    temperature: Math.max(0.62, Math.min(1.12, base.temperature + (u - 0.5) * 0.12)),
    topP: Math.max(0.8, Math.min(0.98, base.topP + (u - 0.5) * 0.06)),
    presencePenalty: base.presencePenalty,
    frequencyPenalty: base.frequencyPenalty,
  };
}

async function emitEvent(gameId: string, eventType: string, data: Record<string, unknown>) {
  try {
    await getUpstashRealtime().channel(`werewolf:${gameId}`).emit(eventType, data);
  } catch {
    // best effort
  }
}



async function emitCinematic(input: {
  gameId: string;
  roundNo: number;
  phase: WerewolfPhase;
  kind: "curtain_night" | "curtain_dawn" | "death_mark" | "vote_start" | "vote_result";
  text?: string;
}) {
  await emitEvent(input.gameId, "ui.werewolf.cinematic", {
    gameId: input.gameId,
    roundNo: input.roundNo,
    phase: input.phase,
    kind: input.kind,
    text: input.text ?? null,
    at: Date.now(),
  });
}

async function emitTimelineTick(input: {
  gameId: string;
  roundNo: number;
  phase: WerewolfPhase;
  scene: "night" | "dawn" | "day";
  remainMs: number;
}) {
  await emitEvent(input.gameId, "ui.werewolf.timeline_tick", {
    gameId: input.gameId,
    roundNo: input.roundNo,
    phase: input.phase,
    scene: input.scene,
    remainMs: input.remainMs,
    at: Date.now(),
  });
}

async function emitTurnCountdown(input: {
  gameId: string;
  roundNo: number;
  phase: WerewolfPhase;
  actorAgentId: string;
  seconds: number;
}) {
  await emitEvent(input.gameId, "ui.werewolf.countdown", {
    gameId: input.gameId,
    roundNo: input.roundNo,
    phase: input.phase,
    actorAgentId: input.actorAgentId,
    remainSec: input.seconds,
    at: Date.now(),
  });
}

async function appendRoundEvent(input: {
  gameId: string;
  roundNo: number;
  phase: WerewolfPhase;
  eventType: string;
  actorAgentId?: string | null;
  targetAgentId?: string | null;
  payload: Record<string, unknown>;
}) {
  const sql = getSql();
  await sql/* sql */ `
    insert into werewolf_round_events (
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
  await emitEvent(input.gameId, `ui.werewolf.${input.eventType}`, {
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
  phase: WerewolfPhase;
  message: string;
  level?: "info" | "warn";
  code?: string;
}) {
  await appendRoundEvent({
    gameId: input.gameId,
    roundNo: input.roundNo,
    phase: input.phase,
    eventType: "gm_notice",
    payload: { message: input.message, level: input.level ?? "info", code: input.code ?? null },
  });
}

async function streamSpeechDelta(input: {
  gameId: string;
  roundNo: number;
  phase: WerewolfPhase;
  actorAgentId: string;
  text: string;
}) {
  let acc = "";
  const size = 6;
  for (let i = 0; i < input.text.length; i += size) {
    acc += input.text.slice(i, i + size);
    await emitEvent(input.gameId, "ui.werewolf.speech_delta", {
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
  await emitEvent(input.gameId, "ui.werewolf.speech_delta", {
    gameId: input.gameId,
    roundNo: input.roundNo,
    phase: input.phase,
    actorAgentId: input.actorAgentId,
    text: input.text,
    done: true,
    at: Date.now(),
  });
}

async function loadGame(gameId: string): Promise<WerewolfGame> {
  const sql = getSql();
  const rows = await sql/* sql */ `select * from werewolf_games where id = ${gameId} limit 1`;
  if (!rows[0]) throw new Error("game not found");
  const row = rows[0] as Record<string, unknown>;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    status: row.status as WerewolfGame["status"],
    phase: row.phase as WerewolfGame["phase"],
    roundNo: Number(row.round_no),
    humanAgentId: String(row.human_agent_id),
    groupId: String(row.group_id),
    currentTurnPlayerId: row.current_turn_player_id ? String(row.current_turn_player_id) : null,
    winnerSide: (row.winner_side ?? null) as WerewolfGame["winnerSide"],
    state: parseState(String(row.state_json)),
    startedAt: toIso(row.started_at),
    endedAt: row.ended_at ? toIso(row.ended_at) : null,
    createdAt: toIso(row.created_at),
  };
}

async function saveGame(game: WerewolfGame) {
  const sql = getSql();
  await sql/* sql */ `
    update werewolf_games
    set
      status = ${game.status},
      phase = ${game.phase},
      round_no = ${game.roundNo},
      current_turn_player_id = ${game.currentTurnPlayerId},
      winner_side = ${game.winnerSide},
      state_json = ${JSON.stringify(game.state)},
      ended_at = ${game.endedAt}
    where id = ${game.id}
  `;
}

async function listPlayers(gameId: string): Promise<WerewolfPlayer[]> {
  const sql = getSql();
  const rows = await sql/* sql */ `
    select p.game_id, p.agent_id, p.is_human, p.role, p.alive, p.seat_no, p.strategy_key, p.decode_json, p.memory_json, p.emotion_state, a.role as role_name
    from werewolf_players p
    join agents a on a.id = p.agent_id
    where p.game_id = ${gameId}
    order by p.seat_no asc
  `;
  return rows.map((row: any) => ({
    gameId: row.game_id,
    agentId: row.agent_id,
    isHuman: Boolean(row.is_human),
    role: row.role as WerewolfRole,
    alive: Boolean(row.alive),
    seatNo: Number(row.seat_no),
    roleName: String(row.role_name),
    strategyKey: row.strategy_key ? String(row.strategy_key) : null,
    decodeJson: row.decode_json ? String(row.decode_json) : null,
    memoryJson: row.memory_json ? String(row.memory_json) : null,
    emotionState: row.emotion_state ? String(row.emotion_state) : null,
  }));
}

async function setPlayerRuntimeState(input: { gameId: string; agentId: string; memory?: PlayerMemory; emotionState?: string }) {
  const sql = getSql();
  await sql/* sql */ `
    update werewolf_players
    set
      memory_json = coalesce(${input.memory ? JSON.stringify(input.memory) : null}, memory_json),
      emotion_state = coalesce(${input.emotionState ?? null}, emotion_state)
    where game_id = ${input.gameId}
      and agent_id = ${input.agentId}
  `;
}

async function emitEmotion(input: { gameId: string; agentId: string; emotion: string }) {
  await emitEvent(input.gameId, "ui.werewolf.emotion_update", {
    gameId: input.gameId,
    agentId: input.agentId,
    emotion: input.emotion,
    at: Date.now(),
  });
}

async function listVotes(gameId: string, roundNo: number, isTiebreak: boolean) {
  const sql = getSql();
  const rows = await sql/* sql */ `
    select voter_agent_id, target_agent_id, reason
    from werewolf_votes
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
    insert into werewolf_votes (
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

async function getRecentPublicSignals(gameId: string, limit: number) {
  const sql = getSql();
  const rows = await sql/* sql */ `
    select round_no, event_type, actor_agent_id, target_agent_id, payload_json
    from werewolf_round_events
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
    .slice(-20);
}

function validWerewolfKillTargets(players: WerewolfPlayer[], actorId: string) {
  const self = players.find((p) => p.agentId === actorId);
  return players
    .filter((p) => p.alive && p.agentId !== actorId && (self?.role !== "werewolf" || p.role !== "werewolf"))
    .map((p) => p.agentId);
}

function chooseVoteTargetFallback(input: { selfId: string; role: WerewolfRole; alivePlayers: WerewolfPlayer[]; validTargets: string[] }) {
  const candidates = input.validTargets.filter((id) => id !== input.selfId);
  if (candidates.length === 0) throw new Error("no vote candidates");
  if (input.role === "werewolf") {
    const nonWolves = input.alivePlayers
      .filter((p) => p.role !== "werewolf")
      .map((p) => p.agentId)
      .filter((id) => candidates.includes(id));
    if (nonWolves.length > 0) return sample(nonWolves);
  }
  return sample(candidates);
}

function seatNameById(players: WerewolfPlayer[], agentId: string | null | undefined) {
  if (!agentId) return "未知玩家";
  const p = players.find((x) => x.agentId === agentId);
  if (!p) return "未知玩家";
  return `玩家${p.seatNo}`;
}

function buildPublicStateSnapshot(input: { game: WerewolfGame; players: WerewolfPlayer[]; events: Awaited<ReturnType<typeof getRecentPublicSignals>> }) {
  const alive = input.players.filter((p) => p.alive).map((p) => `玩家${p.seatNo}`);
  const dead = input.players.filter((p) => !p.alive).map((p) => `玩家${p.seatNo}`);
  const publicLines = input.events.slice(-12).map((e) => {
    if (e.eventType === "speech") {
      return `${seatNameById(input.players, e.actorAgentId)}发言：${String((e.payload as any)?.text ?? "")}`;
    }
    if (e.eventType === "vote") {
      return `${seatNameById(input.players, e.actorAgentId)}投票给${seatNameById(input.players, e.targetAgentId)}：${String((e.payload as any)?.reason ?? "")}`;
    }
    if (e.eventType === "elimination") {
      return `出局：${seatNameById(input.players, String((e.payload as any)?.eliminatedAgentId ?? ""))}`;
    }
    return `${e.eventType}`;
  });
  return {
    roundNo: input.game.roundNo,
    phase: input.game.phase,
    alive,
    dead,
    publicLines,
  };
}

function buildPrivateStateSnapshot(input: { actor: WerewolfPlayer; game: WerewolfGame; players: WerewolfPlayer[] }) {
  if (input.actor.role === "werewolf") {
    const mates = input.players
      .filter((p) => p.role === "werewolf" && p.agentId !== input.actor.agentId)
      .map((p) => `玩家${p.seatNo}`);
    return { roleHint: "狼人", privateFacts: [`你的狼人同伴：${mates.join("、") || "无"}`] };
  }
  if (input.actor.role === "seer") {
    const seat = seatNameById(input.players, input.game.state.night.seerCheckTarget);
    const res = input.game.state.night.seerResult;
    return {
      roleHint: "预言家",
      privateFacts: [res ? `最近一次查验：${seat} => ${res === "werewolf" ? "狼人" : "好人"}` : "最近一次查验：暂无"],
    };
  }
  if (input.actor.role === "witch") {
    return {
      roleHint: "女巫",
      privateFacts: [
        `解药已用：${input.game.state.night.witchHealUsed ? "是" : "否"}`,
        `毒药已用：${input.game.state.night.witchPoisonUsed ? "是" : "否"}`,
      ],
    };
  }
  return { roleHint: "村民", privateFacts: ["无私有技能信息"] };
}

function validateUtterance(input: { text: string; actor: WerewolfPlayer; players: WerewolfPlayer[] }) {
  const text = input.text;
  const mentioned = [...text.matchAll(/玩家(\d+)/g)].map((m) => Number(m[1]));
  const seatSet = new Set(input.players.map((p) => p.seatNo));
  for (const s of mentioned) {
    if (!seatSet.has(s)) return { ok: false as const, code: "bad_seat" as const };
  }
  const deadSet = new Set(input.players.filter((p) => !p.alive).map((p) => p.seatNo));
  const speaksAboutNow = /(现在|当前|本轮|这一轮)/.test(text);
  if (speaksAboutNow && mentioned.some((x) => deadSet.has(x))) return { ok: false as const, code: "dead_ref" as const };
  if (text.length < 6) return { ok: false as const, code: "too_short" as const };
  return { ok: true as const };
}

function repairVoteReasonSeat(input: { reason: string; actor: WerewolfPlayer; targetAgentId: string; players: WerewolfPlayer[] }) {
  const actorSeat = input.actor.seatNo;
  const targetSeat = input.players.find((p) => p.agentId === input.targetAgentId)?.seatNo;
  if (!targetSeat) return input.reason;
  const generic = /(该玩家|其行为|其发言|其逻辑|其动机)/.test(input.reason);
  if (!generic) return input.reason;
  const selfSeatRef = new RegExp(`玩家${actorSeat}(?!\\d)`, "g");
  return input.reason.replace(selfSeatRef, `玩家${targetSeat}`);
}

function isPeacefulFirstDay(game: WerewolfGame) {
  return game.roundNo === 1 && game.phase.includes("day_") && game.state.night.deathsLastNight.length === 0;
}

function shouldAiSkipSpeech(input: { game: WerewolfGame; actor: WerewolfPlayer; memory: PlayerMemory; strategy: WerewolfStrategyKey }) {
  if (!isPeacefulFirstDay(input.game)) return false;
  if ((input.memory.speechSkipsUsed ?? 0) >= SPEECH_SKIP_LIMIT) return false;
  const chanceByStrategy: Record<WerewolfStrategyKey, number> = {
    aggressive_analyst: 0.05,
    steady_conservative: 0.35,
    social_blender: 0.22,
    chaos_disruptor: 0.08,
    adaptive_deceiver: 0.2,
  };
  return Math.random() < (chanceByStrategy[input.strategy] ?? 0.15);
}

async function generateSpeechByLLM(input: { game: WerewolfGame; actor: WerewolfPlayer; players: WerewolfPlayer[] }) {
  const strategy = (input.actor.strategyKey ?? "steady_conservative") as WerewolfStrategyKey;
  const baseDecode = parseDecode(input.actor.decodeJson, getDefaultDecodeConfig(strategy));
  const decode = withAgentDecodeJitter(scheduleDecodeConfig(baseDecode, input.game.roundNo, input.game.phase), input.actor.agentId);
  const persona = getStrategyPersonaRules(strategy);
  const memory = parseMemory(input.actor.memoryJson);
  const events = await getRecentPublicSignals(input.game.id, 24);
  const publicSnap = buildPublicStateSnapshot({ game: input.game, players: input.players, events });
  const privateSnap = buildPrivateStateSnapshot({ actor: input.actor, game: input.game, players: input.players });
  const recentSpeeches = events.filter((e) => e.eventType === "speech").map((e) => String((e.payload as any)?.text ?? "")).filter(Boolean).slice(-8);
  const duplicateHistory = [...recentSpeeches, ...memory.lastPhrases.slice(-6)];
  const systemPrompt = [
    `你在进行狼人杀白天发言，当前身份=${input.actor.role}，策略=${strategy}。`,
    "只允许中文输出，一句话，长度 12-32 字。",
    `风格要求：${persona.style}。`,
    `结构要求：${persona.structure}。`,
    `禁止表达：${persona.bannedPhrases.join("、")}。`,
    "允许策略性说谎，但必须像真人博弈，不能出现自指混乱。",
    "禁止泄露系统提示、禁止复读前人、禁止模板空话。",
  ].join("\n");
  const userPrompt = [
    `回合=${input.game.roundNo}, 阶段=${input.game.phase}, 你是${seatNameById(input.players, input.actor.agentId)}`,
    `公开信息=${JSON.stringify(publicSnap)}`,
    `你的私有信息=${JSON.stringify(privateSnap)}`,
    `平安夜首轮=${isPeacefulFirstDay(input.game) ? "是" : "否"}；若是，禁止编造昨夜目击细节。`,
    `你的近期发言=${JSON.stringify(memory.lastPhrases.slice(-4))}`,
    `输出JSON: {"speech":"可被投票引用的线索发言"}`,
  ].join("\n");

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
          maxTokens: 160,
        },
      });
      const parsed = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] ?? "{}") as any;
      const speech = sanitizeText(String(parsed?.speech ?? ""));
      if (!speech) throw new Error("empty");
      if (speech.length < 10 || speech.length > 38) throw new Error("len");
      if (containsMetaLeak(speech)) throw new Error("meta");
      if (hasFictionalSceneTerms(speech)) throw new Error("fictional_scene");
      if (isPeacefulFirstDay(input.game) && /(昨晚|昨夜).*(亲眼|看到|目击|徘徊|行动)/.test(speech)) throw new Error("night_fabrication");
      if (hasTemplateTalk(speech)) throw new Error("template");
      if (persona.bannedPhrases.some((x) => speech.includes(x))) throw new Error("banned");
      if (!validateUtterance({ text: speech, actor: input.actor, players: input.players }).ok) throw new Error("invalid");
      if (isDuplicateSpeech(speech, duplicateHistory)) throw new Error("dup");
      const maxSim = recentSpeeches.reduce((m, x) => Math.max(m, jaccardSimilarity(speech, x)), 0);
      if (maxSim >= SPEECH_SIMILARITY_THRESHOLD) throw new Error("sim");
      return { speech, memory };
    } catch {
      // retry
    }
  }
  return { speech: "我会先核对前后逻辑是否自洽，再决定站边。", memory };
}

async function generateVoteByLLM(input: { game: WerewolfGame; actor: WerewolfPlayer; players: WerewolfPlayer[]; validTargets: string[] }) {
  const strategy = (input.actor.strategyKey ?? "steady_conservative") as WerewolfStrategyKey;
  const baseDecode = parseDecode(input.actor.decodeJson, getDefaultDecodeConfig(strategy));
  const decode = withAgentDecodeJitter(scheduleDecodeConfig(baseDecode, input.game.roundNo, input.game.phase), input.actor.agentId);
  const persona = getStrategyPersonaRules(strategy);
  const memory = parseMemory(input.actor.memoryJson);
  const events = await getRecentPublicSignals(input.game.id, 20);
  const publicSnap = buildPublicStateSnapshot({ game: input.game, players: input.players, events });
  const privateSnap = buildPrivateStateSnapshot({ actor: input.actor, game: input.game, players: input.players });
  const recentReasons = events.filter((e) => e.eventType === "vote").map((e) => String((e.payload as any)?.reason ?? "")).filter(Boolean).slice(-8);
  const systemPrompt = [
    `你在狼人杀投票阶段，当前身份=${input.actor.role}，策略=${strategy}。`,
    `理由风格：${persona.style}。`,
    "只输出 JSON，不要多余解释。",
    "理由 14-34 字，必须引用可观察行为，不得空话和复述。",
  ].join("\n");
  const userPrompt = [
    `回合=${input.game.roundNo}, 阶段=${input.game.phase}, 你是${seatNameById(input.players, input.actor.agentId)}`,
    `候选=${JSON.stringify(input.validTargets)}`,
    `公开信息=${JSON.stringify(publicSnap)}`,
    `你的私有信息=${JSON.stringify(privateSnap)}`,
    `输出JSON: {"vote_target":"agent_id","reason":"一句投票理由"}`,
  ].join("\n");

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
          maxTokens: 140,
        },
      });
      const parsed = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] ?? "{}") as any;
      const voteTarget = String(parsed?.vote_target ?? "").trim();
      const reasonRaw = sanitizeText(String(parsed?.reason ?? ""));
      if (!input.validTargets.includes(voteTarget)) throw new Error("target");
      if (!reasonRaw) throw new Error("reason");
      const reason = repairVoteReasonSeat({ reason: reasonRaw, actor: input.actor, targetAgentId: voteTarget, players: input.players });
      if (!validateUtterance({ text: reason, actor: input.actor, players: input.players }).ok) throw new Error("invalid");
      if (hasFictionalSceneTerms(reason)) throw new Error("fictional_scene");
      if (!hasObservableAnchor(reason)) throw new Error("no_anchor");
      if (hasTemplateTalk(reason)) throw new Error("template");
      if (persona.bannedPhrases.some((x) => reason.includes(x))) throw new Error("banned");
      const maxSim = recentReasons.reduce((m, x) => Math.max(m, jaccardSimilarity(reason, x)), 0);
      if (maxSim >= VOTE_REASON_SIMILARITY_THRESHOLD) throw new Error("sim");
      return { voteTarget, reason, memory };
    } catch {
      // retry
    }
  }
  const target = chooseVoteTargetFallback({
    selfId: input.actor.agentId,
    role: input.actor.role,
    alivePlayers: input.players.filter((p) => p.alive),
    validTargets: input.validTargets,
  });
  return { voteTarget: target, reason: "该玩家发言和主线线索衔接较弱，先投票排查。", memory };
}

async function generateNightActionByLLM(input: {
  game: WerewolfGame;
  actor: WerewolfPlayer;
  players: WerewolfPlayer[];
  validTargets: string[];
  actionType: WerewolfActionType;
}) {
  if (input.validTargets.length === 0) return { target: null as string | null };
  const strategy = (input.actor.strategyKey ?? "steady_conservative") as WerewolfStrategyKey;
  const baseDecode = parseDecode(input.actor.decodeJson, getDefaultDecodeConfig(strategy));
  const decode = withAgentDecodeJitter(scheduleDecodeConfig(baseDecode, input.game.roundNo, input.game.phase), input.actor.agentId);
  const events = await getRecentPublicSignals(input.game.id, 14);
  const systemPrompt = `你在执行狼人杀夜晚行动决策，身份=${input.actor.role}，action=${input.actionType}。只输出JSON。`;
  const userPrompt =
    `候选=${JSON.stringify(input.validTargets)}\n` +
    `最近记录=${JSON.stringify(events.slice(-10))}\n` +
    `输出JSON: {"target":"agent_id 或 null"}`;

  for (let i = 0; i <= 1; i++) {
    try {
      const raw = await chatJsonByAgent({
        agentId: input.actor.agentId,
        systemPrompt,
        userPrompt,
        decode: {
          temperature: Math.max(0.65, decode.temperature - 0.08),
          topP: decode.topP,
          presencePenalty: decode.presencePenalty,
          frequencyPenalty: decode.frequencyPenalty,
          maxTokens: 80,
        },
      });
      const parsed = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] ?? "{}") as any;
      const targetRaw = parsed?.target;
      if (targetRaw === null || String(targetRaw).trim().toLowerCase() === "null") return { target: null };
      const target = String(targetRaw ?? "").trim();
      if (input.validTargets.includes(target)) return { target };
    } catch {
      // fallback
    }
  }
  return { target: sample(input.validTargets) };
}

function evaluateWinner(players: WerewolfPlayer[]) {
  const alive = players.filter((p) => p.alive);
  const wolfCount = alive.filter((p) => p.role === "werewolf").length;
  const goodCount = alive.length - wolfCount;
  if (wolfCount <= 0) return "good_side" as const;
  if (wolfCount >= goodCount) return "werewolf_side" as const;
  return null;
}

async function resolveNightToDay(game: WerewolfGame) {
  const players = await listPlayers(game.id);
  const aliveSet = new Set(players.filter((p) => p.alive).map((p) => p.agentId));
  const deaths = new Set<string>();
  if (game.state.night.pendingKill && aliveSet.has(game.state.night.pendingKill) && !game.state.night.witchSaved) {
    deaths.add(game.state.night.pendingKill);
  }
  if (game.state.night.witchPoisonTarget && aliveSet.has(game.state.night.witchPoisonTarget)) {
    deaths.add(game.state.night.witchPoisonTarget);
  }
  if (deaths.size > 0) {
    const sql = getSql();
    await sql/* sql */ `
      update werewolf_players
      set alive = false, emotion_state = ${"eliminated"}
      where game_id = ${game.id}
        and agent_id = any(${[...deaths]}::uuid[])
    `;
    for (const id of deaths) await emitEmotion({ gameId: game.id, agentId: id, emotion: "eliminated" });
  }
  game.state.night.deathsLastNight = [...deaths];
  game.phase = "day_announce";
  game.currentTurnPlayerId = null;
  await emitCinematic({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, kind: "curtain_dawn", text: "天亮了" });
  await emitTimelineTick({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, scene: "dawn", remainMs: CINEMATIC_DAWN_MS });
  await sleep(CINEMATIC_DAWN_MS);
  await appendRoundEvent({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, eventType: "phase_change", payload: { to: game.phase } });
}

async function resolveDayElimination(game: WerewolfGame, players: WerewolfPlayer[]) {
  const votes = await listVotes(game.id, game.roundNo, game.state.isTiebreak);
  const candidates = game.state.isTiebreak ? game.state.tieCandidates : players.filter((p) => p.alive).map((p) => p.agentId);
  const score = new Map<string, number>();
  for (const c of candidates) score.set(c, 0);
  for (const vote of votes) score.set(vote.target_agent_id, (score.get(vote.target_agent_id) ?? 0) + 1);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] ?? 0;
  const ties = ranked.filter((x) => x[1] === top).map((x) => x[0]);

  if (ties.length > 1 && !game.state.isTiebreak) {
    game.phase = "day_tiebreak_speaking";
    game.state.isTiebreak = true;
    game.state.tieCandidates = ties;
    game.state.turnOrder = ties;
    game.state.turnIndex = 0;
    game.state.votersPending = [];
    game.currentTurnPlayerId = game.state.turnOrder[0] ?? null;
    await appendRoundEvent({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, eventType: "phase_change", payload: { to: game.phase, tieCandidates: ties } });
    return;
  }

  const eliminatedId = ties.length === 1 ? ties[0]! : sample(ties);
  const sql = getSql();
  await sql/* sql */ `
    update werewolf_players
    set alive = false, emotion_state = ${"eliminated"}
    where game_id = ${game.id}
      and agent_id = ${eliminatedId}
  `;
  await emitEmotion({ gameId: game.id, agentId: eliminatedId, emotion: "eliminated" });
  const eliminated = players.find((p) => p.agentId === eliminatedId);
  await appendRoundEvent({
    gameId: game.id,
    roundNo: game.roundNo,
    phase: "day_elimination",
    eventType: "elimination",
    actorAgentId: eliminatedId,
    payload: { eliminatedAgentId: eliminatedId, role: eliminated?.role ?? "villager", tiebreak: game.state.isTiebreak },
  });
  await emitCinematic({ gameId: game.id, roundNo: game.roundNo, phase: "day_elimination", kind: "vote_result", text: "公布出局结果" });

  const refreshed = await listPlayers(game.id);
  const winner = evaluateWinner(refreshed);
  if (winner) {
    game.status = "finished";
    game.phase = "game_over";
    game.winnerSide = winner;
    game.currentTurnPlayerId = null;
    game.endedAt = nowIso();
    await appendRoundEvent({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, eventType: "game_over", payload: { winner } });
    await cleanupGameEphemeralAgents({ workspaceId: game.workspaceId, gameId: game.id });
    return;
  }

  game.roundNo += 1;
  game.phase = "night_wolf";
  game.state.isTiebreak = false;
  game.state.tieCandidates = [];
  game.state.votersPending = [];
  game.state.turnOrder = refreshed.filter((p) => p.alive && p.role === "werewolf").map((p) => p.agentId);
  game.state.turnIndex = 0;
  game.state.night = {
    ...game.state.night,
    wolfVotes: {},
    pendingKill: null,
    seerCheckTarget: null,
    seerResult: null,
    witchSaved: false,
    witchPoisonTarget: null,
    deathsLastNight: [],
  };
  game.currentTurnPlayerId = game.state.turnOrder[0] ?? null;
  await appendRoundEvent({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, eventType: "phase_change", payload: { to: game.phase, roundNo: game.roundNo } });
  await emitCinematic({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, kind: "curtain_night", text: "新一轮夜晚降临" });
  await emitTimelineTick({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, scene: "night", remainMs: CINEMATIC_NIGHT_MS });
  await sleep(CINEMATIC_NIGHT_MS);
}

async function advanceGameAuto(gameId: string) {
  let safety = 0;
  while (safety < 160) {
    safety += 1;
    const game = await loadGame(gameId);
    if (game.status === "finished" || game.phase === "game_over") return;
    const players = await listPlayers(gameId);
    const alivePlayers = players.filter((p) => p.alive);
    const winner = evaluateWinner(players);
    if (winner) {
      game.status = "finished";
      game.phase = "game_over";
      game.winnerSide = winner;
      game.currentTurnPlayerId = null;
      game.endedAt = nowIso();
      await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: "game_over", eventType: "game_over", payload: { winner } });
      await cleanupGameEphemeralAgents({ workspaceId: game.workspaceId, gameId: game.id });
      await saveGame(game);
      return;
    }

    if (game.phase === "night_wolf") {
      const wolves = alivePlayers.filter((p) => p.role === "werewolf");
      if (wolves.length === 0) {
        game.phase = "night_seer";
        game.currentTurnPlayerId = null;
        game.state.turnOrder = [];
        await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "phase_change", payload: { to: game.phase } });
        await saveGame(game);
        continue;
      }
      if (game.state.turnOrder.length === 0) {
        game.state.turnOrder = wolves.map((w) => w.agentId);
        game.state.turnIndex = 0;
        game.currentTurnPlayerId = game.state.turnOrder[0] ?? null;
      }
      const actorId = game.state.turnOrder[game.state.turnIndex] ?? null;
      if (!actorId) {
        const votes = Object.values(game.state.night.wolfVotes);
        game.state.night.pendingKill = votes.length > 0 ? sample(votes) : sample(validWerewolfKillTargets(players, wolves[0]!.agentId));
        game.phase = "night_seer";
        game.state.turnOrder = [];
        game.state.turnIndex = 0;
        game.currentTurnPlayerId = null;
        await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "phase_change", payload: { to: game.phase } });
        await saveGame(game);
        continue;
      }
      const actor = players.find((p) => p.agentId === actorId && p.alive);
      if (!actor) {
        game.state.turnIndex += 1;
        game.currentTurnPlayerId = game.state.turnOrder[game.state.turnIndex] ?? null;
        await saveGame(game);
        continue;
      }
      await emitEvent(gameId, "ui.werewolf.turn_start", { gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: actor.agentId, at: Date.now() });
      await emitTurnCountdown({ gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: actor.agentId, seconds: Math.max(4, Math.floor(AI_NIGHT_DELAY_MS / 300)) });
      if (actor.isHuman) {
        game.currentTurnPlayerId = actor.agentId;
        await saveGame(game);
        return;
      }
      await emitEmotion({ gameId, agentId: actor.agentId, emotion: "thinking" });
      const validTargets = validWerewolfKillTargets(players, actor.agentId);
      const action = await generateNightActionByLLM({ game, actor, players, validTargets, actionType: "wolf_kill" });
      if (action.target) game.state.night.wolfVotes[actor.agentId] = action.target;
      await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "night_action", actorAgentId: actor.agentId, targetAgentId: action.target, payload: { actionType: "wolf_kill" } });
      await emitEmotion({ gameId, agentId: actor.agentId, emotion: "neutral" });
      await emitEvent(gameId, "ui.werewolf.turn_end", { gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: actor.agentId, at: Date.now() });
      await sleep(AI_NIGHT_DELAY_MS);
      game.state.turnIndex += 1;
      if (game.state.turnIndex >= game.state.turnOrder.length) {
        const votes = Object.values(game.state.night.wolfVotes);
        game.state.night.pendingKill = votes.length > 0 ? sample(votes) : (validTargets[0] ?? null);
        game.phase = "night_seer";
        game.state.turnOrder = [];
        game.state.turnIndex = 0;
        game.currentTurnPlayerId = null;
        await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "phase_change", payload: { to: game.phase } });
      } else {
        game.currentTurnPlayerId = game.state.turnOrder[game.state.turnIndex] ?? null;
      }
      await saveGame(game);
      continue;
    }

    if (game.phase === "night_seer") {
      const seer = alivePlayers.find((p) => p.role === "seer");
      if (!seer) {
        game.phase = "night_witch";
        game.currentTurnPlayerId = null;
        await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "phase_change", payload: { to: game.phase } });
        await saveGame(game);
        continue;
      }
      await emitEvent(gameId, "ui.werewolf.turn_start", { gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: seer.agentId, at: Date.now() });
      await emitTurnCountdown({ gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: seer.agentId, seconds: Math.max(4, Math.floor(AI_NIGHT_DELAY_MS / 300)) });
      if (seer.isHuman) {
        game.currentTurnPlayerId = seer.agentId;
        await saveGame(game);
        return;
      }
      const targets = alivePlayers.filter((p) => p.agentId !== seer.agentId).map((p) => p.agentId);
      const action = await generateNightActionByLLM({ game, actor: seer, players, validTargets: targets, actionType: "seer_check" });
      const target = action.target ?? targets[0] ?? null;
      game.state.night.seerCheckTarget = target;
      game.state.night.seerResult = target && players.find((p) => p.agentId === target)?.role === "werewolf" ? "werewolf" : "good";
      await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "night_action", actorAgentId: seer.agentId, targetAgentId: target, payload: { actionType: "seer_check" } });
      await emitEvent(gameId, "ui.werewolf.turn_end", { gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: seer.agentId, at: Date.now() });
      await sleep(AI_NIGHT_DELAY_MS);
      game.phase = "night_witch";
      game.currentTurnPlayerId = null;
      await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "phase_change", payload: { to: game.phase } });
      await saveGame(game);
      continue;
    }

    if (game.phase === "night_witch") {
      const witch = alivePlayers.find((p) => p.role === "witch");
      if (!witch) {
        await resolveNightToDay(game);
        await saveGame(game);
        continue;
      }
      await emitEvent(gameId, "ui.werewolf.turn_start", { gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: witch.agentId, at: Date.now() });
      await emitTurnCountdown({ gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: witch.agentId, seconds: Math.max(4, Math.floor(AI_NIGHT_DELAY_MS / 300)) });
      if (witch.isHuman) {
        game.currentTurnPlayerId = witch.agentId;
        await saveGame(game);
        return;
      }
      const kill = game.state.night.pendingKill;
      if (!game.state.night.witchHealUsed && kill && Math.random() < 0.6) {
        game.state.night.witchSaved = true;
        game.state.night.witchHealUsed = true;
      }
      if (!game.state.night.witchPoisonUsed && Math.random() < 0.35) {
        const candidates = alivePlayers.filter((p) => p.agentId !== witch.agentId).map((p) => p.agentId);
        if (candidates.length > 0) {
          game.state.night.witchPoisonTarget = sample(candidates);
          game.state.night.witchPoisonUsed = true;
        }
      }
      await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "night_action", actorAgentId: witch.agentId, targetAgentId: game.state.night.witchPoisonTarget, payload: { actionType: "witch_auto", saved: game.state.night.witchSaved, poisonTarget: game.state.night.witchPoisonTarget } });
      await emitEvent(gameId, "ui.werewolf.turn_end", { gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: witch.agentId, at: Date.now() });
      await sleep(AI_NIGHT_DELAY_MS);
      await resolveNightToDay(game);
      await saveGame(game);
      continue;
    }

    if (game.phase === "day_announce") {
      await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "day_announce", payload: { deaths: game.state.night.deathsLastNight } });
      if (game.state.night.deathsLastNight.length > 0) {
        await emitCinematic({ gameId, roundNo: game.roundNo, phase: game.phase, kind: "death_mark", text: "昨夜有人倒下" });
        await emitEvent(gameId, "ui.werewolf.death_reveal", {
          gameId,
          roundNo: game.roundNo,
          phase: game.phase,
          deaths: game.state.night.deathsLastNight,
          style: "restrained",
          at: Date.now(),
        });
        await sleep(CINEMATIC_DEATH_MS);
      }
      const winnerAfterNight = evaluateWinner(await listPlayers(gameId));
      if (winnerAfterNight) {
        game.status = "finished";
        game.phase = "game_over";
        game.winnerSide = winnerAfterNight;
        game.currentTurnPlayerId = null;
        game.endedAt = nowIso();
        await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "game_over", payload: { winner: winnerAfterNight } });
        await cleanupGameEphemeralAgents({ workspaceId: game.workspaceId, gameId: game.id });
        await saveGame(game);
        return;
      }
      game.phase = "day_speaking";
      game.state.turnOrder = alivePlayers.map((p) => p.agentId);
      game.state.turnIndex = 0;
      game.currentTurnPlayerId = game.state.turnOrder[0] ?? null;
      await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "phase_change", payload: { to: game.phase } });
      await saveGame(game);
      continue;
    }

    if (game.phase === "day_speaking" || game.phase === "day_tiebreak_speaking") {
      if (!game.currentTurnPlayerId) {
        await sleep(PHASE_DELAY_MS);
        game.phase = game.phase === "day_tiebreak_speaking" ? "day_tiebreak_voting" : "day_voting";
        game.state.votersPending = alivePlayers.map((p) => p.agentId);
        game.currentTurnPlayerId = game.state.votersPending[0] ?? null;
        await emitCinematic({ gameId, roundNo: game.roundNo, phase: game.phase, kind: "vote_start", text: "开始投票" });
        await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "phase_change", payload: { to: game.phase } });
        await saveGame(game);
        continue;
      }
      const actor = players.find((p) => p.agentId === game.currentTurnPlayerId && p.alive);
      if (!actor) {
        game.state.turnIndex += 1;
        game.currentTurnPlayerId = game.state.turnOrder[game.state.turnIndex] ?? null;
        await saveGame(game);
        continue;
      }
      await emitEvent(gameId, "ui.werewolf.turn_start", { gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: actor.agentId, at: Date.now() });
      await emitTurnCountdown({
        gameId,
        roundNo: game.roundNo,
        phase: game.phase,
        actorAgentId: actor.agentId,
        seconds: actor.isHuman ? SPEECH_COUNTDOWN_SEC : Math.max(6, Math.floor(AI_SPEAK_DELAY_MS / 260)),
      });
      if (actor.isHuman) {
        await saveGame(game);
        return;
      }
      const strategy = (actor.strategyKey ?? "steady_conservative") as WerewolfStrategyKey;
      const actorMemory = parseMemory(actor.memoryJson);
      if (shouldAiSkipSpeech({ game, actor, memory: actorMemory, strategy })) {
        const reason = "信息不足，先保留发言。";
        await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "speech_skip", actorAgentId: actor.agentId, payload: { reason } });
        const nextMemory = rememberSpeechSkip(actorMemory);
        await setPlayerRuntimeState({ gameId, agentId: actor.agentId, memory: nextMemory, emotionState: "neutral" });
        await emitEvent(gameId, "ui.werewolf.turn_end", { gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: actor.agentId, at: Date.now() });
        await sleep(Math.max(700, Math.floor(AI_SPEAK_DELAY_MS * 0.7)));
        game.state.turnIndex += 1;
        game.currentTurnPlayerId = game.state.turnOrder[game.state.turnIndex] ?? null;
        await saveGame(game);
        continue;
      }
      await emitEmotion({ gameId, agentId: actor.agentId, emotion: "thinking" });
      const generated = await generateSpeechByLLM({ game, actor, players });
      await emitEmotion({ gameId, agentId: actor.agentId, emotion: "speaking" });
      await streamSpeechDelta({ gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: actor.agentId, text: generated.speech });
      await store.sendMessage({ groupId: game.groupId, senderId: actor.agentId, content: generated.speech, contentType: "text" });
      await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "speech", actorAgentId: actor.agentId, payload: { text: generated.speech } });
      const nextMemory = rememberSpeech(generated.memory, game.roundNo, generated.speech);
      await setPlayerRuntimeState({ gameId, agentId: actor.agentId, memory: nextMemory, emotionState: "neutral" });
      await emitEmotion({ gameId, agentId: actor.agentId, emotion: "neutral" });
      await emitEvent(gameId, "ui.werewolf.turn_end", { gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: actor.agentId, at: Date.now() });
      await sleep(AI_SPEAK_DELAY_MS);
      game.state.turnIndex += 1;
      game.currentTurnPlayerId = game.state.turnOrder[game.state.turnIndex] ?? null;
      await saveGame(game);
      continue;
    }

    if (game.phase === "day_voting" || game.phase === "day_tiebreak_voting") {
      if (!game.currentTurnPlayerId) {
        await sleep(PHASE_DELAY_MS);
        await emitCinematic({ gameId, roundNo: game.roundNo, phase: game.phase, kind: "vote_result", text: "票型统计中" });
        game.phase = "day_elimination";
        await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "phase_change", payload: { to: game.phase } });
        await saveGame(game);
        continue;
      }
      const voter = players.find((p) => p.agentId === game.currentTurnPlayerId && p.alive);
      if (!voter) {
        game.state.votersPending = game.state.votersPending.slice(1);
        game.currentTurnPlayerId = game.state.votersPending[0] ?? null;
        await saveGame(game);
        continue;
      }
      await emitEvent(gameId, "ui.werewolf.turn_start", { gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: voter.agentId, at: Date.now() });
      await emitTurnCountdown({
        gameId,
        roundNo: game.roundNo,
        phase: game.phase,
        actorAgentId: voter.agentId,
        seconds: voter.isHuman ? VOTE_COUNTDOWN_SEC : Math.max(5, Math.floor(AI_VOTE_DELAY_MS / 250)),
      });
      if (voter.isHuman) {
        await saveGame(game);
        return;
      }
      const validTargets = game.phase === "day_tiebreak_voting" ? game.state.tieCandidates.filter((id) => id !== voter.agentId) : alivePlayers.filter((p) => p.agentId !== voter.agentId).map((p) => p.agentId);
      const generated = await generateVoteByLLM({ game, actor: voter, players, validTargets });
      await insertVote({ gameId, roundNo: game.roundNo, voterAgentId: voter.agentId, targetAgentId: generated.voteTarget, isTiebreak: game.phase === "day_tiebreak_voting", reason: generated.reason });
      await appendRoundEvent({ gameId, roundNo: game.roundNo, phase: game.phase, eventType: "vote", actorAgentId: voter.agentId, targetAgentId: generated.voteTarget, payload: { reason: generated.reason, isTiebreak: game.phase === "day_tiebreak_voting" } });
      await emitEvent(gameId, "ui.werewolf.vote_reveal", { gameId, roundNo: game.roundNo, actorAgentId: voter.agentId, targetAgentId: generated.voteTarget, reason: generated.reason, at: Date.now() });
      const nextMemory = rememberVote(generated.memory, game.roundNo, generated.voteTarget);
      await setPlayerRuntimeState({ gameId, agentId: voter.agentId, memory: nextMemory, emotionState: "neutral" });
      await emitEvent(gameId, "ui.werewolf.turn_end", { gameId, roundNo: game.roundNo, phase: game.phase, actorAgentId: voter.agentId, at: Date.now() });
      await sleep(AI_VOTE_DELAY_MS);
      game.state.votersPending = game.state.votersPending.filter((id) => id !== voter.agentId);
      game.currentTurnPlayerId = game.state.votersPending[0] ?? null;
      await saveGame(game);
      continue;
    }

    if (game.phase === "day_elimination") {
      await resolveDayElimination(game, players);
      await saveGame(game);
      continue;
    }
    return;
  }
}

export async function createWerewolfGame(input: { workspaceId: string; humanAgentId?: string | null }) {
  const defaults = await store.ensureWorkspaceDefaults({ workspaceId: input.workspaceId });
  const humanAgentId = input.humanAgentId ?? defaults.humanAgentId;
  const aiMembers: Array<{ agentId: string; strategy: WerewolfStrategyKey }> = [];
  for (let i = 0; i < AI_COUNT; i++) {
    const strategy = STRATEGY_SLOTS[i]!;
    const created = await store.createSubAgentWithP2P({
      workspaceId: input.workspaceId,
      creatorId: humanAgentId,
      role: `werewolf_ai_${i + 1}_${strategy}`,
      kind: "game_ephemeral",
      autoRunEnabled: false,
      originType: "werewolf_game",
      guidance: `${getStrategyGuidance(strategy)}\nYou are playing Werewolf. Output Chinese in game rounds.`,
    });
    aiMembers.push({ agentId: created.agentId, strategy });
  }
  const members = [humanAgentId, ...aiMembers.map((x) => x.agentId)];
  const group = await store.createGroup({
    workspaceId: input.workspaceId,
    memberIds: members,
    name: `werewolf-${Date.now()}`,
    kind: "game_werewolf",
  });
  const rolePool = (["werewolf", "werewolf", "seer", "witch", "villager", "villager"] as WerewolfRole[]).sort(() => Math.random() - 0.5);
  const roleMap = new Map<string, WerewolfRole>();
  for (let i = 0; i < members.length; i++) roleMap.set(members[i]!, rolePool[i]!);

  const gameId = uid();
  const state: WerewolfState = {
    turnOrder: members.filter((id) => roleMap.get(id) === "werewolf"),
    turnIndex: 0,
    votersPending: [],
    tieCandidates: [],
    isTiebreak: false,
    night: defaultNightState(),
  };
  const sql = getSql();
  const createdAt = nowIso();
  await sql/* sql */ `
    insert into werewolf_games (
      id, workspace_id, status, phase, round_no, human_agent_id, group_id,
      current_turn_player_id, winner_side, state_json, started_at, ended_at, created_at
    ) values (
      ${gameId},
      ${input.workspaceId},
      ${"running"},
      ${"night_wolf"},
      ${1},
      ${humanAgentId},
      ${group.id},
      ${state.turnOrder[0] ?? null},
      ${null},
      ${JSON.stringify(state)},
      ${createdAt},
      ${null},
      ${createdAt}
    )
  `;
  for (let i = 0; i < members.length; i++) {
    const agentId = members[i]!;
    const role = roleMap.get(agentId)!;
    const ai = aiMembers.find((x) => x.agentId === agentId);
    const strategy = ai?.strategy ?? null;
    const decode = strategy ? getDefaultDecodeConfig(strategy) : null;
    await sql/* sql */ `
      insert into werewolf_players (
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
        ${JSON.stringify(createInitialMemory(members))},
        ${"neutral"}
      )
    `;
  }
  await appendRoundEvent({ gameId, roundNo: 1, phase: "night_wolf", eventType: "phase_change", payload: { to: "night_wolf", roundNo: 1, playerCount: 6 } });
  await emitGmNotice({ gameId, roundNo: 1, phase: "night_wolf", code: "game_start", message: "GM：狼人杀开局，夜晚阶段开始。" });
  await emitCinematic({ gameId, roundNo: 1, phase: "night_wolf", kind: "curtain_night", text: "天黑请闭眼" });
  await emitTimelineTick({ gameId, roundNo: 1, phase: "night_wolf", scene: "night", remainMs: CINEMATIC_NIGHT_MS });
  await sleep(CINEMATIC_NIGHT_MS);
  await emitEvent(gameId, "ui.werewolf.game_created", { gameId, workspaceId: input.workspaceId });
  await advanceGameAuto(gameId);
  return getWerewolfGame(gameId);
}

export async function listWerewolfGames(workspaceId: string) {
  const sql = getSql();
  const rows = await sql/* sql */ `
    select id, status, phase, round_no, winner_side, created_at
    from werewolf_games
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

export async function getWerewolfGame(gameId: string) {
  const game = await loadGame(gameId);
  const players = await listPlayers(gameId);
  const human = players.find((p) => p.agentId === game.humanAgentId);
  const humanMemory = parseMemory(human?.memoryJson);
  const humanRole = (human?.role ?? "villager") as WerewolfRole;
  const reveal = game.status === "finished" ? players.map((p) => ({ agentId: p.agentId, seatNo: p.seatNo, role: p.role, alive: p.alive })) : null;
  const maskedPlayers = players.map((p) => ({
    ...p,
    role: game.status === "finished" || p.agentId === game.humanAgentId ? p.role : ("villager" as WerewolfRole),
  }));
  return {
    game,
    players: maskedPlayers,
    humanRole,
    humanNightInfo: {
      canAct:
        (game.phase === "night_wolf" && humanRole === "werewolf") ||
        (game.phase === "night_seer" && humanRole === "seer") ||
        (game.phase === "night_witch" && humanRole === "witch"),
      seerResult: humanRole === "seer" ? { targetAgentId: game.state.night.seerCheckTarget, result: game.state.night.seerResult } : null,
      witchState:
        humanRole === "witch"
          ? { healUsed: game.state.night.witchHealUsed, poisonUsed: game.state.night.witchPoisonUsed, pendingKill: game.state.night.pendingKill }
          : null,
    },
    humanSpeechInfo: {
      skipUsed: humanMemory.speechSkipsUsed ?? 0,
      skipLimit: SPEECH_SKIP_LIMIT,
    },
    reveal,
  };
}

export async function listWerewolfEvents(gameId: string) {
  const sql = getSql();
  const rows = await sql/* sql */ `
    select id, round_no, phase, event_type, actor_agent_id, target_agent_id, payload_json, created_at
    from werewolf_round_events
    where game_id = ${gameId}
    order by created_at asc
  `;
  return rows.map((row: any) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(String(row.payload_json ?? "{}"));
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

export async function submitHumanNightAction(input: { gameId: string; actorAgentId: string; actionType: WerewolfActionType; targetAgentId?: string | null }) {
  const game = await loadGame(input.gameId);
  const players = await listPlayers(game.id);
  const actor = players.find((p) => p.agentId === input.actorAgentId);
  if (!actor || !actor.isHuman || !actor.alive) throw new Error("human actor invalid");
  if (game.currentTurnPlayerId !== actor.agentId) throw new Error("not your turn");

  if (game.phase === "night_wolf" && actor.role === "werewolf") {
    const valid = validWerewolfKillTargets(players, actor.agentId);
    const target = String(input.targetAgentId ?? "").trim();
    if (!valid.includes(target)) throw new Error("invalid kill target");
    game.state.night.wolfVotes[actor.agentId] = target;
    await appendRoundEvent({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, eventType: "night_action", actorAgentId: actor.agentId, targetAgentId: target, payload: { actionType: "wolf_kill" } });
    game.state.turnIndex += 1;
    game.currentTurnPlayerId = game.state.turnOrder[game.state.turnIndex] ?? null;
    if (!game.currentTurnPlayerId) {
      const votes = Object.values(game.state.night.wolfVotes);
      game.state.night.pendingKill = votes.length > 0 ? sample(votes) : (valid[0] ?? null);
      game.phase = "night_seer";
      game.state.turnOrder = [];
      game.state.turnIndex = 0;
      game.currentTurnPlayerId = null;
    }
    await saveGame(game);
    await advanceGameAuto(game.id);
    return getWerewolfGame(game.id);
  }
  if (game.phase === "night_seer" && actor.role === "seer") {
    const valid = players.filter((p) => p.alive && p.agentId !== actor.agentId).map((p) => p.agentId);
    const target = String(input.targetAgentId ?? "").trim();
    if (!valid.includes(target)) throw new Error("invalid check target");
    game.state.night.seerCheckTarget = target;
    game.state.night.seerResult = players.find((p) => p.agentId === target)?.role === "werewolf" ? "werewolf" : "good";
    await appendRoundEvent({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, eventType: "night_action", actorAgentId: actor.agentId, targetAgentId: target, payload: { actionType: "seer_check" } });
    game.phase = "night_witch";
    game.currentTurnPlayerId = null;
    await saveGame(game);
    await advanceGameAuto(game.id);
    return getWerewolfGame(game.id);
  }
  if (game.phase === "night_witch" && actor.role === "witch") {
    if (input.actionType === "witch_heal") {
      if (game.state.night.witchHealUsed) throw new Error("heal already used");
      if (!game.state.night.pendingKill) throw new Error("no pending kill");
      game.state.night.witchSaved = true;
      game.state.night.witchHealUsed = true;
    } else if (input.actionType === "witch_poison") {
      if (game.state.night.witchPoisonUsed) throw new Error("poison already used");
      const valid = players.filter((p) => p.alive && p.agentId !== actor.agentId).map((p) => p.agentId);
      const target = String(input.targetAgentId ?? "").trim();
      if (!valid.includes(target)) throw new Error("invalid poison target");
      game.state.night.witchPoisonUsed = true;
      game.state.night.witchPoisonTarget = target;
    } else if (input.actionType !== "witch_skip") {
      throw new Error("invalid witch action");
    }
    await appendRoundEvent({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, eventType: "night_action", actorAgentId: actor.agentId, targetAgentId: game.state.night.witchPoisonTarget, payload: { actionType: input.actionType } });
    await resolveNightToDay(game);
    await saveGame(game);
    await advanceGameAuto(game.id);
    return getWerewolfGame(game.id);
  }
  throw new Error("invalid phase or role for night action");
}

export async function submitHumanSpeech(input: { gameId: string; actorAgentId: string; text?: string; action?: "speak" | "skip"; reason?: string }) {
  const game = await loadGame(input.gameId);
  if (!(game.phase === "day_speaking" || game.phase === "day_tiebreak_speaking")) throw new Error("not in speaking phase");
  if (game.currentTurnPlayerId !== input.actorAgentId) throw new Error("not your turn");
  const players = await listPlayers(input.gameId);
  const actor = players.find((p) => p.agentId === input.actorAgentId);
  if (!actor || !actor.isHuman || !actor.alive) throw new Error("human actor invalid");
  const memory = parseMemory(actor.memoryJson);
  const normalizedText = sanitizeText(String(input.text ?? ""));
  const normalizedAction = input.action ?? ((normalizedText === "过" || normalizedText === "无") ? "skip" : "speak");
  if (normalizedAction === "skip") {
    if ((memory.speechSkipsUsed ?? 0) >= SPEECH_SKIP_LIMIT) throw new Error("speech skip limit reached");
    const reason = sanitizeText(input.reason ?? "保留信息，暂不过麦");
    await appendRoundEvent({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, eventType: "speech_skip", actorAgentId: input.actorAgentId, payload: { reason } });
    const nextMemory = rememberSpeechSkip(memory);
    await setPlayerRuntimeState({ gameId: game.id, agentId: input.actorAgentId, memory: nextMemory, emotionState: "neutral" });
    game.state.turnIndex += 1;
    game.currentTurnPlayerId = game.state.turnOrder[game.state.turnIndex] ?? null;
    await saveGame(game);
    await advanceGameAuto(game.id);
    return getWerewolfGame(game.id);
  }
  const text = normalizedText;
  if (!text) throw new Error("speech text is empty");
  if (containsMetaLeak(text)) throw new Error("speech leaks role");
  await emitEvent(game.id, "ui.werewolf.turn_start", { gameId: game.id, roundNo: game.roundNo, phase: game.phase, actorAgentId: input.actorAgentId, at: Date.now() });
  await emitEmotion({ gameId: game.id, agentId: input.actorAgentId, emotion: "speaking" });
  await streamSpeechDelta({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, actorAgentId: input.actorAgentId, text });
  await store.sendMessage({ groupId: game.groupId, senderId: input.actorAgentId, content: text, contentType: "text" });
  await appendRoundEvent({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, eventType: "speech", actorAgentId: input.actorAgentId, payload: { text } });
  const nextMemory = rememberSpeech(memory, game.roundNo, text);
  await setPlayerRuntimeState({ gameId: game.id, agentId: input.actorAgentId, memory: nextMemory, emotionState: "neutral" });
  await emitEmotion({ gameId: game.id, agentId: input.actorAgentId, emotion: "neutral" });
  await emitEvent(game.id, "ui.werewolf.turn_end", { gameId: game.id, roundNo: game.roundNo, phase: game.phase, actorAgentId: input.actorAgentId, at: Date.now() });
  game.state.turnIndex += 1;
  game.currentTurnPlayerId = game.state.turnOrder[game.state.turnIndex] ?? null;
  await saveGame(game);
  await advanceGameAuto(game.id);
  return getWerewolfGame(game.id);
}

export async function submitHumanVote(input: { gameId: string; voterAgentId: string; targetAgentId: string; reason: string }) {
  const game = await loadGame(input.gameId);
  if (!(game.phase === "day_voting" || game.phase === "day_tiebreak_voting")) throw new Error("not in voting phase");
  if (game.currentTurnPlayerId !== input.voterAgentId) throw new Error("not your turn");
  if (input.targetAgentId === input.voterAgentId) throw new Error("cannot vote self");
  const players = await listPlayers(game.id);
  const voter = players.find((p) => p.agentId === input.voterAgentId);
  if (!voter || !voter.isHuman || !voter.alive) throw new Error("human voter invalid");
  const valid = game.phase === "day_tiebreak_voting" ? game.state.tieCandidates.filter((id) => id !== input.voterAgentId) : players.filter((p) => p.alive && p.agentId !== input.voterAgentId).map((p) => p.agentId);
  if (!valid.includes(input.targetAgentId)) throw new Error("invalid target");
  const reason = sanitizeText(input.reason) || "该玩家发言与全场线索衔接偏弱，先投票排查。";
  await insertVote({ gameId: game.id, roundNo: game.roundNo, voterAgentId: input.voterAgentId, targetAgentId: input.targetAgentId, isTiebreak: game.phase === "day_tiebreak_voting", reason });
  await appendRoundEvent({ gameId: game.id, roundNo: game.roundNo, phase: game.phase, eventType: "vote", actorAgentId: input.voterAgentId, targetAgentId: input.targetAgentId, payload: { reason, isTiebreak: game.phase === "day_tiebreak_voting" } });
  await emitEvent(game.id, "ui.werewolf.vote_reveal", { gameId: game.id, roundNo: game.roundNo, actorAgentId: input.voterAgentId, targetAgentId: input.targetAgentId, reason, at: Date.now() });
  const memory = rememberVote(parseMemory(voter.memoryJson), game.roundNo, input.targetAgentId);
  await setPlayerRuntimeState({ gameId: game.id, agentId: input.voterAgentId, memory, emotionState: "neutral" });
  game.state.votersPending = game.state.votersPending.filter((id) => id !== input.voterAgentId);
  game.currentTurnPlayerId = game.state.votersPending[0] ?? null;
  await saveGame(game);
  await advanceGameAuto(game.id);
  return getWerewolfGame(game.id);
}

export async function getWerewolfReview(gameId: string) {
  const sql = getSql();
  const existing = await sql/* sql */ `select summary_json, narrative_text, created_at from werewolf_reviews where game_id = ${gameId} limit 1`;
  if (existing[0]) {
    const row = existing[0] as any;
    return { summary: JSON.parse(String(row.summary_json ?? "{}")), narrative: String(row.narrative_text), createdAt: toIso(row.created_at) };
  }
  const detail = await getWerewolfGame(gameId);
  const events = await listWerewolfEvents(gameId);
  const players = await listPlayers(gameId);
  const votes = events.filter((e) => e.eventType === "vote").length;
  const speeches = events.filter((e) => e.eventType === "speech").length;
  const keyTurns = events.filter((e) => e.eventType === "elimination" || e.eventType === "day_announce" || e.eventType === "game_over").slice(-8).map((e) => ({ roundNo: e.roundNo, type: e.eventType, payload: e.payload }));
  const voteEvents = events.filter((e) => e.eventType === "vote");
  const wolves = players.filter((p) => p.role === "werewolf").map((p) => p.agentId);
  const playerStats = players.map((p) => {
    const mine = voteEvents.filter((v) => v.actorAgentId === p.agentId);
    return {
      seatNo: p.seatNo,
      role: p.role,
      alive: p.alive,
      votesCast: mine.length,
      votedWolf: mine.filter((v) => wolves.includes(String(v.targetAgentId ?? ""))).length,
      gotVotes: voteEvents.filter((v) => v.targetAgentId === p.agentId).length,
    };
  });
  const summary = { winner: detail.game.winnerSide, totalRounds: detail.game.roundNo, totalSpeeches: speeches, totalVotes: votes, keyTurns, reveal: detail.reveal, playerStats };
  const narrative = detail.game.winnerSide === "werewolf_side" ? "狼人通过夜晚优势和白天分票拖入终局并获胜。" : "好人阵营通过白天信息收敛和关键投票取胜。";
  await sql/* sql */ `insert into werewolf_reviews (game_id, summary_json, narrative_text, created_at) values (${gameId}, ${JSON.stringify(summary)}, ${narrative}, ${nowIso()})`;
  return { summary, narrative, createdAt: nowIso() };
}

