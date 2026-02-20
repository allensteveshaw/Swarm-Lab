export type UUID = string;

export type WerewolfPhase =
  | "night_wolf"
  | "night_seer"
  | "night_witch"
  | "day_announce"
  | "day_speaking"
  | "day_voting"
  | "day_tiebreak_speaking"
  | "day_tiebreak_voting"
  | "day_elimination"
  | "game_over";

export type WerewolfStatus = "running" | "finished";
export type WerewolfRole = "werewolf" | "seer" | "witch" | "villager";
export type WinnerSide = "werewolf_side" | "good_side" | null;

export type WerewolfNightState = {
  wolfVotes: Record<string, string>;
  pendingKill: string | null;
  seerCheckTarget: string | null;
  seerResult: "werewolf" | "good" | null;
  witchHealUsed: boolean;
  witchPoisonUsed: boolean;
  witchSaved: boolean;
  witchPoisonTarget: string | null;
  deathsLastNight: string[];
};

export type WerewolfState = {
  turnOrder: UUID[];
  turnIndex: number;
  votersPending: UUID[];
  tieCandidates: UUID[];
  isTiebreak: boolean;
  night: WerewolfNightState;
};

export type WerewolfPlayer = {
  gameId: UUID;
  agentId: UUID;
  isHuman: boolean;
  role: WerewolfRole;
  alive: boolean;
  seatNo: number;
  roleName: string;
  strategyKey: string | null;
  decodeJson: string | null;
  memoryJson: string | null;
  emotionState: string | null;
};

export type WerewolfGame = {
  id: UUID;
  workspaceId: UUID;
  status: WerewolfStatus;
  phase: WerewolfPhase;
  roundNo: number;
  humanAgentId: UUID;
  groupId: UUID;
  currentTurnPlayerId: UUID | null;
  winnerSide: WinnerSide;
  state: WerewolfState;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
};

export type WerewolfActionType =
  | "wolf_kill"
  | "seer_check"
  | "witch_heal"
  | "witch_poison"
  | "witch_skip";
