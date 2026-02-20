export type UUID = string;

export type UndercoverPhase =
  | "waiting_human_join"
  | "round_speaking"
  | "round_voting"
  | "round_tiebreak_speaking"
  | "round_tiebreak_voting"
  | "round_elimination"
  | "game_over";

export type UndercoverStatus = "running" | "finished";
export type UndercoverRole = "civilian" | "undercover";
export type WinnerSide = UndercoverRole | null;

export type UndercoverState = {
  turnOrder: UUID[];
  turnIndex: number;
  votersPending: UUID[];
  tieCandidates: UUID[];
};

export type UndercoverPlayer = {
  gameId: UUID;
  agentId: UUID;
  isHuman: boolean;
  role: UndercoverRole;
  alive: boolean;
  seatNo: number;
  roleName: string;
  strategyKey: string | null;
  decodeJson: string | null;
  memoryJson: string | null;
  emotionState: string | null;
};

export type UndercoverGame = {
  id: UUID;
  workspaceId: UUID;
  status: UndercoverStatus;
  phase: UndercoverPhase;
  roundNo: number;
  civilianWord: string;
  undercoverWord: string;
  humanAgentId: UUID;
  groupId: UUID;
  currentTurnPlayerId: UUID | null;
  winnerSide: WinnerSide;
  isTiebreak: boolean;
  state: UndercoverState;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
};
