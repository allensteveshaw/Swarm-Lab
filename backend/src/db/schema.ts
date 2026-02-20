import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  role: text("role").notNull(),
  kind: text("kind").notNull().default("worker"),
  autoRunEnabled: boolean("auto_run_enabled").notNull().default(true),
  originType: text("origin_type"),
  originId: uuid("origin_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  parentId: uuid("parent_id"),
  modelProfileId: uuid("model_profile_id"),
  llmHistory: text("llm_history").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const modelProfiles = pgTable("model_profiles", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  baseUrl: text("base_url"),
  model: text("model").notNull(),
  apiKey: text("api_key"),
  headersJson: text("headers_json"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const groups = pgTable("groups", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  name: text("name"),
  kind: text("kind").notNull().default("chat"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  contextTokens: integer("context_tokens").default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    userId: uuid("user_id").notNull(),
    lastReadMessageId: uuid("last_read_message_id"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
  })
);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  groupId: uuid("group_id")
    .notNull()
    .references(() => groups.id),
  senderId: uuid("sender_id").notNull(),
  contentType: text("content_type").notNull(),
  content: text("content").notNull(),
  sendTime: timestamp("send_time", { withTimezone: true }).notNull(),
});

export const taskRuns = pgTable("task_runs", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  rootGroupId: uuid("root_group_id")
    .notNull()
    .references(() => groups.id),
  ownerAgentId: uuid("owner_agent_id")
    .notNull()
    .references(() => agents.id),
  goal: text("goal").notNull(),
  status: text("status").notNull(),
  stopReason: text("stop_reason"),
  budgetJson: text("budget_json").notNull(),
  metricsJson: text("metrics_json").notNull(),
  summaryMessageId: uuid("summary_message_id"),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const taskReviews = pgTable("task_reviews", {
  taskId: uuid("task_id")
    .primaryKey()
    .references(() => taskRuns.id),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  reviewJson: text("review_json").notNull(),
  narrativeText: text("narrative_text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const undercoverGames = pgTable("undercover_games", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  status: text("status").notNull(),
  phase: text("phase").notNull(),
  roundNo: integer("round_no").notNull().default(1),
  civilianWord: text("civilian_word").notNull(),
  undercoverWord: text("undercover_word").notNull(),
  humanAgentId: uuid("human_agent_id").notNull(),
  groupId: uuid("group_id").notNull(),
  currentTurnPlayerId: uuid("current_turn_player_id"),
  winnerSide: text("winner_side"),
  isTiebreak: boolean("is_tiebreak").notNull().default(false),
  stateJson: text("state_json").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const undercoverPlayers = pgTable(
  "undercover_players",
  {
    gameId: uuid("game_id")
      .notNull()
      .references(() => undercoverGames.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    isHuman: boolean("is_human").notNull().default(false),
    role: text("role").notNull(),
    alive: boolean("alive").notNull().default(true),
    seatNo: integer("seat_no").notNull(),
    strategyKey: text("strategy_key"),
    decodeJson: text("decode_json"),
    memoryJson: text("memory_json"),
    emotionState: text("emotion_state"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.gameId, t.agentId] }),
  })
);

export const undercoverRoundEvents = pgTable("undercover_round_events", {
  id: uuid("id").primaryKey(),
  gameId: uuid("game_id")
    .notNull()
    .references(() => undercoverGames.id),
  roundNo: integer("round_no").notNull(),
  phase: text("phase").notNull(),
  eventType: text("event_type").notNull(),
  actorAgentId: uuid("actor_agent_id"),
  targetAgentId: uuid("target_agent_id"),
  payloadJson: text("payload_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const undercoverVotes = pgTable("undercover_votes", {
  id: uuid("id").primaryKey(),
  gameId: uuid("game_id")
    .notNull()
    .references(() => undercoverGames.id),
  roundNo: integer("round_no").notNull(),
  voterAgentId: uuid("voter_agent_id").notNull(),
  targetAgentId: uuid("target_agent_id").notNull(),
  isTiebreak: boolean("is_tiebreak").notNull().default(false),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const undercoverReviews = pgTable("undercover_reviews", {
  gameId: uuid("game_id")
    .primaryKey()
    .references(() => undercoverGames.id),
  summaryJson: text("summary_json").notNull(),
  narrativeText: text("narrative_text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const werewolfGames = pgTable("werewolf_games", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  status: text("status").notNull(),
  phase: text("phase").notNull(),
  roundNo: integer("round_no").notNull().default(1),
  humanAgentId: uuid("human_agent_id").notNull(),
  groupId: uuid("group_id").notNull(),
  currentTurnPlayerId: uuid("current_turn_player_id"),
  winnerSide: text("winner_side"),
  stateJson: text("state_json").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const werewolfPlayers = pgTable(
  "werewolf_players",
  {
    gameId: uuid("game_id")
      .notNull()
      .references(() => werewolfGames.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    isHuman: boolean("is_human").notNull().default(false),
    role: text("role").notNull(),
    alive: boolean("alive").notNull().default(true),
    seatNo: integer("seat_no").notNull(),
    strategyKey: text("strategy_key"),
    decodeJson: text("decode_json"),
    memoryJson: text("memory_json"),
    emotionState: text("emotion_state"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.gameId, t.agentId] }),
  })
);

export const werewolfRoundEvents = pgTable("werewolf_round_events", {
  id: uuid("id").primaryKey(),
  gameId: uuid("game_id")
    .notNull()
    .references(() => werewolfGames.id),
  roundNo: integer("round_no").notNull(),
  phase: text("phase").notNull(),
  eventType: text("event_type").notNull(),
  actorAgentId: uuid("actor_agent_id"),
  targetAgentId: uuid("target_agent_id"),
  payloadJson: text("payload_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const werewolfVotes = pgTable("werewolf_votes", {
  id: uuid("id").primaryKey(),
  gameId: uuid("game_id")
    .notNull()
    .references(() => werewolfGames.id),
  roundNo: integer("round_no").notNull(),
  voterAgentId: uuid("voter_agent_id").notNull(),
  targetAgentId: uuid("target_agent_id").notNull(),
  isTiebreak: boolean("is_tiebreak").notNull().default(false),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const werewolfReviews = pgTable("werewolf_reviews", {
  gameId: uuid("game_id")
    .primaryKey()
    .references(() => werewolfGames.id),
  summaryJson: text("summary_json").notNull(),
  narrativeText: text("narrative_text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

