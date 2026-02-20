import { and, desc, eq, gt, inArray, isNull, ne, or, sql as dsql } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";

import { getDb } from "@/db";
import {
  agents,
  groupMembers,
  groups,
  messages,
  modelProfiles,
  taskReviews,
  taskRuns,
  workspaces,
} from "@/db/schema";

type UUID = string;
export type ModelProvider = "glm" | "openrouter" | "openai_compatible";
export type AgentKind = "system_human" | "system_assistant" | "worker" | "game_ephemeral";
export type GroupKind = "chat" | "game_undercover" | "game_werewolf";
export type TaskStopReason =
  | "manual"
  | "timeout"
  | "no_progress"
  | "repeated_output"
  | "goal_reached"
  | "max_turns"
  | "manual_replaced"
  | "token_delta_exceeded";

export type TaskRunRecord = {
  id: UUID;
  workspaceId: UUID;
  rootGroupId: UUID;
  ownerAgentId: UUID;
  goal: string;
  status: "running" | "stopping" | "stopped" | "completed";
  stopReason: TaskStopReason | null;
  budgetJson: string;
  metricsJson: string;
  summaryMessageId: UUID | null;
  startAt: string;
  deadlineAt: string;
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskReviewRecord = {
  taskId: UUID;
  workspaceId: UUID;
  reviewJson: string;
  narrativeText: string;
  createdAt: string;
};

export type ModelProfile = {
  id: UUID;
  workspaceId: UUID;
  name: string;
  provider: ModelProvider;
  baseUrl: string | null;
  model: string;
  apiKey: string | null;
  headers: Record<string, string>;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

function now() {
  return new Date();
}

function uuid(): UUID {
  return crypto.randomUUID();
}

function isUuid(value: string | null | undefined): value is UUID {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim()
  );
}

function parseHeadersJson(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function readApiKeyFile(filename: string): Promise<string | null> {
  const candidates = [
    path.resolve(process.cwd(), "API-KEY", filename),
    path.resolve(process.cwd(), "..", "API-KEY", filename),
  ];
  for (const file of candidates) {
    try {
      const content = (await fs.readFile(file, "utf-8")).trim();
      if (content) return content;
    } catch {
      // ignore
    }
  }
  return null;
}

function initialAgentHistory(input: {
  agentId: UUID;
  workspaceId: UUID;
  role: string;
  guidance?: string;
}) {
  const content =
    `You are an agent in an IM system.\n` +
    `Your agent_id is: ${input.agentId}.\n` +
    `Your workspace_id is: ${input.workspaceId}.\n` +
    `Your role is: ${input.role}.\n` +
    `Act strictly as this role when replying. Be concise and helpful.\n` +
    `Your replies are NOT automatically delivered to humans.\n` +
    `To send messages, you MUST call tools like send_group_message or send_direct_message.\n` +
    `If you need to coordinate with other agents, you may use tools like self, list_agents, create, send, list_groups, list_group_members, create_group, send_group_message, send_direct_message, and get_group_messages.`;

  const history: Array<{ role: "system"; content: string }> = [{ role: "system", content }];
  const guidance = (input.guidance ?? "").trim();
  if (guidance) {
    history.push({
      role: "system",
      content: `Additional instructions:\n${guidance}`,
    });
  }
  return JSON.stringify(history);
}

async function emitDbWrite(input: {
  workspaceId: UUID;
  table: string;
  action: "insert" | "update" | "delete";
  recordId?: UUID | null;
}) {
  try {
    const { getWorkspaceUIBus } = await import("@/runtime/ui-bus");
    getWorkspaceUIBus().emit(input.workspaceId, {
      event: "ui.db.write",
      data: {
        workspaceId: input.workspaceId,
        table: input.table,
        action: input.action,
        recordId: input.recordId ?? null,
      },
    });
  } catch {
    // best-effort only
  }
}

export const store = {
  async findLatestExactP2PGroupId(input: {
    workspaceId: UUID;
    memberA: UUID;
    memberB: UUID;
    preferredName?: string | null;
  }): Promise<UUID | null> {
    const db = getDb();
    const a = input.memberA;
    const b = input.memberB;
    if (!a || !b || a === b || !isUuid(a) || !isUuid(b)) return null;

    const rows = await db
      .select({
        id: groups.id,
        name: groups.name,
        createdAt: groups.createdAt,
        lastMessageTime: dsql<Date | null>`max(${messages.sendTime})`,
      })
      .from(groups)
      .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
      .leftJoin(messages, eq(messages.groupId, groups.id))
      .where(and(eq(groups.workspaceId, input.workspaceId), isNull(groups.deletedAt)))
      .groupBy(groups.id)
      .having(
        dsql`count(*) = 2 and sum(case when ${groupMembers.userId} = ${a} or ${groupMembers.userId} = ${b} then 1 else 0 end) = 2`
      );

    if (rows.length === 0) return null;

    const preferred = (input.preferredName ?? null) || null;
    rows.sort((x, y) => {
      const xName = x.name ?? null;
      const yName = y.name ?? null;
      const xMatch = preferred && xName === preferred ? 1 : 0;
      const yMatch = preferred && yName === preferred ? 1 : 0;
      if (xMatch !== yMatch) return yMatch - xMatch;

      const xNamed = xName ? 1 : 0;
      const yNamed = yName ? 1 : 0;
      if (xNamed !== yNamed) return yNamed - xNamed;

      const xUpdated = (x.lastMessageTime ?? x.createdAt).getTime();
      const yUpdated = (y.lastMessageTime ?? y.createdAt).getTime();
      if (xUpdated !== yUpdated) return yUpdated - xUpdated;

      return y.createdAt.getTime() - x.createdAt.getTime();
    });

    return rows[0]!.id;
  },

  async mergeDuplicateExactP2PGroups(input: {
    workspaceId: UUID;
    memberA: UUID;
    memberB: UUID;
    preferredName?: string | null;
  }): Promise<UUID | null> {
    const db = getDb();
    const a = input.memberA;
    const b = input.memberB;
    if (!a || !b || a === b || !isUuid(a) || !isUuid(b)) return null;

    const createdAt = now();

    return await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: groups.id,
          name: groups.name,
          createdAt: groups.createdAt,
          lastMessageTime: dsql<Date | null>`max(${messages.sendTime})`,
        })
        .from(groups)
        .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
        .leftJoin(messages, eq(messages.groupId, groups.id))
        .where(and(eq(groups.workspaceId, input.workspaceId), isNull(groups.deletedAt)))
        .groupBy(groups.id)
        .having(
          dsql`count(*) = 2 and sum(case when ${groupMembers.userId} = ${a} or ${groupMembers.userId} = ${b} then 1 else 0 end) = 2`
        );

      const preferred = (input.preferredName ?? null) || null;

      const pickBest = (candidates: typeof rows) => {
        const sorted = [...candidates];
        sorted.sort((x, y) => {
          const xName = x.name ?? null;
          const yName = y.name ?? null;
          const xMatch = preferred && xName === preferred ? 1 : 0;
          const yMatch = preferred && yName === preferred ? 1 : 0;
          if (xMatch !== yMatch) return yMatch - xMatch;

          const xNamed = xName ? 1 : 0;
          const yNamed = yName ? 1 : 0;
          if (xNamed !== yNamed) return yNamed - xNamed;

          const xUpdated = (x.lastMessageTime ?? x.createdAt).getTime();
          const yUpdated = (y.lastMessageTime ?? y.createdAt).getTime();
          if (xUpdated !== yUpdated) return yUpdated - xUpdated;

          return y.createdAt.getTime() - x.createdAt.getTime();
        });
        return sorted[0]!;
      };

      let keepId: UUID | null = null;

      if (rows.length === 0) {
        keepId = uuid();
        await tx.insert(groups).values({
          id: keepId,
          workspaceId: input.workspaceId,
          name: preferred || null,
          createdAt,
        });
        await tx.insert(groupMembers).values([
          { groupId: keepId, userId: a, lastReadMessageId: null, joinedAt: createdAt },
          { groupId: keepId, userId: b, lastReadMessageId: null, joinedAt: createdAt },
        ]);
        return keepId;
      }

      const best = pickBest(rows);
      keepId = best.id;

      const others = rows.filter((r) => r.id !== keepId).map((r) => r.id);
      for (const otherId of others) {
        await tx
          .update(messages)
          .set({ groupId: keepId })
          .where(and(eq(messages.workspaceId, input.workspaceId), eq(messages.groupId, otherId)));

        await tx.delete(groupMembers).where(eq(groupMembers.groupId, otherId));
        await tx.delete(groups).where(eq(groups.id, otherId));
      }

      if (preferred && (best.name ?? null) !== preferred) {
        await tx.update(groups).set({ name: preferred }).where(eq(groups.id, keepId));
      }

      return keepId;
    });
  },

  async listModelProfiles(input: { workspaceId: UUID }): Promise<ModelProfile[]> {
    const db = getDb();
    const rows = await db
      .select({
        id: modelProfiles.id,
        workspaceId: modelProfiles.workspaceId,
        name: modelProfiles.name,
        provider: modelProfiles.provider,
        baseUrl: modelProfiles.baseUrl,
        model: modelProfiles.model,
        apiKey: modelProfiles.apiKey,
        headersJson: modelProfiles.headersJson,
        isDefault: modelProfiles.isDefault,
        createdAt: modelProfiles.createdAt,
        updatedAt: modelProfiles.updatedAt,
      })
      .from(modelProfiles)
      .where(eq(modelProfiles.workspaceId, input.workspaceId))
      .orderBy(desc(modelProfiles.isDefault), desc(modelProfiles.updatedAt));

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      provider: row.provider as ModelProvider,
      baseUrl: row.baseUrl,
      model: row.model,
      apiKey: row.apiKey,
      headers: parseHeadersJson(row.headersJson),
      isDefault: row.isDefault,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  },

  async getModelProfile(input: { id: UUID }): Promise<ModelProfile | null> {
    const db = getDb();
    const rows = await db
      .select({
        id: modelProfiles.id,
        workspaceId: modelProfiles.workspaceId,
        name: modelProfiles.name,
        provider: modelProfiles.provider,
        baseUrl: modelProfiles.baseUrl,
        model: modelProfiles.model,
        apiKey: modelProfiles.apiKey,
        headersJson: modelProfiles.headersJson,
        isDefault: modelProfiles.isDefault,
        createdAt: modelProfiles.createdAt,
        updatedAt: modelProfiles.updatedAt,
      })
      .from(modelProfiles)
      .where(eq(modelProfiles.id, input.id))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      provider: row.provider as ModelProvider,
      baseUrl: row.baseUrl,
      model: row.model,
      apiKey: row.apiKey,
      headers: parseHeadersJson(row.headersJson),
      isDefault: row.isDefault,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },

  async createModelProfile(input: {
    workspaceId: UUID;
    name: string;
    provider: ModelProvider;
    baseUrl?: string | null;
    model: string;
    apiKey?: string | null;
    headers?: Record<string, string>;
    isDefault?: boolean;
  }): Promise<ModelProfile> {
    const db = getDb();
    const id = uuid();
    const createdAt = now();
    const updatedAt = createdAt;
    const headersJson = JSON.stringify(input.headers ?? {});
    const isDefault = !!input.isDefault;

    await db.transaction(async (tx) => {
      if (isDefault) {
        await tx
          .update(modelProfiles)
          .set({ isDefault: false, updatedAt })
          .where(eq(modelProfiles.workspaceId, input.workspaceId));
      }

      await tx.insert(modelProfiles).values({
        id,
        workspaceId: input.workspaceId,
        name: input.name,
        provider: input.provider,
        baseUrl: input.baseUrl ?? null,
        model: input.model,
        apiKey: input.apiKey ?? null,
        headersJson,
        isDefault,
        createdAt,
        updatedAt,
      });
    });

    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "model_profiles",
      action: "insert",
      recordId: id,
    });

    const created = await this.getModelProfile({ id });
    if (!created) throw new Error("failed to create model profile");
    return created;
  },

  async updateModelProfile(
    input: {
      id: UUID;
      workspaceId: UUID;
      name?: string;
      provider?: ModelProvider;
      baseUrl?: string | null;
      model?: string;
      apiKey?: string | null;
      headers?: Record<string, string>;
      isDefault?: boolean;
    }
  ): Promise<ModelProfile | null> {
    const db = getDb();
    const updatedAt = now();
    const payload: Record<string, unknown> = { updatedAt };
    if (typeof input.name === "string") payload.name = input.name;
    if (typeof input.provider === "string") payload.provider = input.provider;
    if (typeof input.baseUrl !== "undefined") payload.baseUrl = input.baseUrl;
    if (typeof input.model === "string") payload.model = input.model;
    if (typeof input.apiKey !== "undefined") payload.apiKey = input.apiKey;
    if (typeof input.headers !== "undefined") payload.headersJson = JSON.stringify(input.headers);
    if (typeof input.isDefault === "boolean") payload.isDefault = input.isDefault;

    await db.transaction(async (tx) => {
      if (input.isDefault) {
        await tx
          .update(modelProfiles)
          .set({ isDefault: false, updatedAt })
          .where(eq(modelProfiles.workspaceId, input.workspaceId));
      }
      await tx
        .update(modelProfiles)
        .set(payload)
        .where(and(eq(modelProfiles.id, input.id), eq(modelProfiles.workspaceId, input.workspaceId)));
    });

    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "model_profiles",
      action: "update",
      recordId: input.id,
    });

    return await this.getModelProfile({ id: input.id });
  },

  async deleteModelProfile(input: { id: UUID; workspaceId: UUID }) {
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ modelProfileId: null })
        .where(and(eq(agents.workspaceId, input.workspaceId), eq(agents.modelProfileId, input.id)));
      await tx
        .delete(modelProfiles)
        .where(and(eq(modelProfiles.id, input.id), eq(modelProfiles.workspaceId, input.workspaceId)));
    });

    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "model_profiles",
      action: "delete",
      recordId: input.id,
    });
  },

  async ensurePresetModelProfiles(input: { workspaceId: UUID }) {
    const db = getDb();
    const existing = await this.listModelProfiles({ workspaceId: input.workspaceId });
    const profileKey = (name: string, baseUrl: string | null, model: string) =>
      `${name}::${baseUrl ?? ""}::${model}`;
    const existingKeys = new Set(
      existing.map((p) => profileKey(p.name, p.baseUrl, p.model))
    );

    const dashscopeKey =
      (process.env.DASHSCOPE_API_KEY ?? "").trim() ||
      (await readApiKeyFile("QWEN3")) ||
      (await readApiKeyFile("KIMI")) ||
      (await readApiKeyFile("GLM")) ||
      null;

    const qwenKey = dashscopeKey;
    if (
      qwenKey &&
      !existingKeys.has(
        profileKey(
          "Qwen3 (DashScope)",
          "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
          "qwen-max-latest"
        )
      )
    ) {
      await db.insert(modelProfiles).values({
        id: uuid(),
        workspaceId: input.workspaceId,
        name: "Qwen3 (DashScope)",
        provider: "openai_compatible",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        model: "qwen-max-latest",
        apiKey: qwenKey,
        headersJson: JSON.stringify({}),
        isDefault: false,
        createdAt: now(),
        updatedAt: now(),
      });
      existingKeys.add(
        profileKey(
          "Qwen3 (DashScope)",
          "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
          "qwen-max-latest"
        )
      );
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "model_profiles",
        action: "insert",
      });
    }

    if (
      dashscopeKey &&
      !existingKeys.has(
        profileKey(
          "Kimi 2.5 (DashScope)",
          "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
          "kimi-k2.5"
        )
      )
    ) {
      await db.insert(modelProfiles).values({
        id: uuid(),
        workspaceId: input.workspaceId,
        name: "Kimi 2.5 (DashScope)",
        provider: "openai_compatible",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        model: "kimi-k2.5",
        apiKey: dashscopeKey,
        headersJson: JSON.stringify({}),
        isDefault: false,
        createdAt: now(),
        updatedAt: now(),
      });
      existingKeys.add(
        profileKey(
          "Kimi 2.5 (DashScope)",
          "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
          "kimi-k2.5"
        )
      );
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "model_profiles",
        action: "insert",
      });
    }

    const glmKey = dashscopeKey;
    if (
      glmKey &&
      !existingKeys.has(
        profileKey(
          "GLM-5 (DashScope)",
          "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
          "glm-5"
        )
      )
    ) {
      await db.insert(modelProfiles).values({
        id: uuid(),
        workspaceId: input.workspaceId,
        name: "GLM-5 (DashScope)",
        provider: "openai_compatible",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        model: "glm-5",
        apiKey: glmKey,
        headersJson: JSON.stringify({}),
        isDefault: false,
        createdAt: now(),
        updatedAt: now(),
      });
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "model_profiles",
        action: "insert",
      });
    }
  },

  async listWorkspaces(): Promise<Array<{ id: UUID; name: string; createdAt: string }>> {
    const db = getDb();
    const rows = await db
      .select({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt })
      .from(workspaces)
      .orderBy(desc(workspaces.createdAt));

    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  },

  async createAgent(input: {
    workspaceId: UUID;
    role: string;
    parentId?: UUID | null;
    llmHistory?: string;
    guidance?: string;
    kind?: AgentKind;
    autoRunEnabled?: boolean;
    originType?: string | null;
    originId?: UUID | null;
  }) {
    const db = getDb();
    const agentId = uuid();
    const createdAt = now();

    const workspace = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1);
    if (workspace.length === 0) throw new Error("workspace not found");

    await db.insert(agents).values({
      id: agentId,
      workspaceId: input.workspaceId,
      role: input.role,
      kind: input.kind ?? "worker",
      autoRunEnabled: input.autoRunEnabled ?? true,
      originType: input.originType ?? null,
      originId: input.originId ?? null,
      deletedAt: null,
      lastActiveAt: createdAt,
      parentId: input.parentId ?? null,
      llmHistory:
        input.llmHistory ??
        initialAgentHistory({
          agentId,
          workspaceId: input.workspaceId,
          role: input.role,
          guidance: input.guidance,
        }),
      createdAt,
    });

    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "agents",
      action: "insert",
      recordId: agentId,
    });

    return { id: agentId, role: input.role, createdAt: createdAt.toISOString() };
  },

  async listAgentsMeta(
    input: { workspaceId: UUID; includeDeleted?: boolean; kinds?: AgentKind[] }
  ): Promise<
    Array<{
      id: UUID;
      role: string;
      kind: AgentKind;
      autoRunEnabled: boolean;
      deletedAt: string | null;
      parentId: UUID | null;
      modelProfileId: UUID | null;
      modelLabel: string | null;
      createdAt: string;
    }>
  > {
    const db = getDb();
    const rows = await db
      .select({
        id: agents.id,
        role: agents.role,
        kind: agents.kind,
        autoRunEnabled: agents.autoRunEnabled,
        deletedAt: agents.deletedAt,
        parentId: agents.parentId,
        modelProfileId: agents.modelProfileId,
        modelName: modelProfiles.name,
        modelValue: modelProfiles.model,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .leftJoin(modelProfiles, eq(modelProfiles.id, agents.modelProfileId))
      .where(
        and(
          eq(agents.workspaceId, input.workspaceId),
          input.includeDeleted ? undefined : isNull(agents.deletedAt),
          input.kinds && input.kinds.length > 0 ? inArray(agents.kind, input.kinds) : undefined
        )
      )
      .orderBy(desc(agents.createdAt));

    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      kind: r.kind as AgentKind,
      autoRunEnabled: r.autoRunEnabled,
      deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
      parentId: r.parentId,
      modelProfileId: r.modelProfileId,
      modelLabel: r.modelName ?? r.modelValue ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  },

  async getDefaultHumanAgentId(input: { workspaceId: UUID }): Promise<UUID | null> {
    const agents = await this.listAgentsMeta({ workspaceId: input.workspaceId });
    return agents.find((a) => a.role === "human")?.id ?? null;
  },

  async createWorkspaceWithDefaults(input: { name: string }) {
    const db = getDb();
    const workspaceId = uuid();
    const humanAgentId = uuid();
    const assistantAgentId = uuid();
    const defaultGroupId = uuid();
    const createdAt = now();

    await db.transaction(async (tx) => {
      await tx.insert(workspaces).values({
        id: workspaceId,
        name: input.name,
        createdAt,
      });

      await tx.insert(agents).values([
        {
          id: humanAgentId,
          workspaceId,
          role: "human",
          kind: "system_human",
          autoRunEnabled: false,
          parentId: null,
          llmHistory: initialAgentHistory({
            agentId: humanAgentId,
            workspaceId,
            role: "human",
          }),
          createdAt,
        },
        {
          id: assistantAgentId,
          workspaceId,
          role: "assistant",
          kind: "system_assistant",
          autoRunEnabled: true,
          parentId: null,
          llmHistory: initialAgentHistory({
            agentId: assistantAgentId,
            workspaceId,
            role: "assistant",
          }),
          createdAt,
        },
      ]);

      await tx.insert(groups).values({
        id: defaultGroupId,
        workspaceId,
        name: null,
        kind: "chat",
        deletedAt: null,
        createdAt,
      });

      await tx.insert(groupMembers).values([
        {
          groupId: defaultGroupId,
          userId: humanAgentId,
          lastReadMessageId: null,
          joinedAt: createdAt,
        },
        {
          groupId: defaultGroupId,
          userId: assistantAgentId,
          lastReadMessageId: null,
          joinedAt: createdAt,
        },
      ]);
    });

    await emitDbWrite({
      workspaceId,
      table: "workspaces",
      action: "insert",
      recordId: workspaceId,
    });
    await emitDbWrite({
      workspaceId,
      table: "agents",
      action: "insert",
    });
    await emitDbWrite({
      workspaceId,
      table: "groups",
      action: "insert",
      recordId: defaultGroupId,
    });
    await emitDbWrite({
      workspaceId,
      table: "group_members",
      action: "insert",
    });

    return { workspaceId, humanAgentId, assistantAgentId, defaultGroupId };
  },

  async ensureWorkspaceDefaults(input: { workspaceId: UUID }) {
    const db = getDb();
    const createdAt = now();

    const workspace = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1);
    if (workspace.length === 0) throw new Error("workspace not found");

    let createdHuman = false;
    let createdAssistant = false;
    let createdGroup = false;

    const result = await db.transaction(async (tx) => {
      const existingAgents = await tx
        .select({ id: agents.id, role: agents.role })
        .from(agents)
        .where(and(eq(agents.workspaceId, input.workspaceId), isNull(agents.deletedAt)));

      let humanAgentId = existingAgents.find((a) => a.role === "human")?.id ?? null;
      let assistantAgentId =
        existingAgents.find((a) => a.role === "assistant")?.id ?? null;

      if (!humanAgentId) {
        humanAgentId = uuid();
        await tx.insert(agents).values({
          id: humanAgentId,
          workspaceId: input.workspaceId,
          role: "human",
          kind: "system_human",
          autoRunEnabled: false,
          parentId: null,
          llmHistory: initialAgentHistory({
            agentId: humanAgentId,
            workspaceId: input.workspaceId,
            role: "human",
          }),
          createdAt,
        });
        createdHuman = true;
      }

      if (!assistantAgentId) {
        assistantAgentId = uuid();
        await tx.insert(agents).values({
          id: assistantAgentId,
          workspaceId: input.workspaceId,
          role: "assistant",
          kind: "system_assistant",
          autoRunEnabled: true,
          parentId: null,
          llmHistory: initialAgentHistory({
            agentId: assistantAgentId,
            workspaceId: input.workspaceId,
            role: "assistant",
          }),
          createdAt,
        });
        createdAssistant = true;
      }

      const candidate = await tx
        .select({ id: groups.id })
        .from(groups)
        .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
        .where(and(eq(groups.workspaceId, input.workspaceId), isNull(groups.deletedAt)))
        .groupBy(groups.id)
        .having(
          dsql`count(*) = 2 and sum(case when ${groupMembers.userId} = ${humanAgentId} or ${groupMembers.userId} = ${assistantAgentId} then 1 else 0 end) = 2`
        )
        .orderBy(desc(groups.createdAt))
        .limit(1);

      let defaultGroupId = candidate[0]?.id ?? null;

      if (!defaultGroupId) {
        defaultGroupId = uuid();
        await tx.insert(groups).values({
          id: defaultGroupId,
          workspaceId: input.workspaceId,
          name: null,
          kind: "chat",
          deletedAt: null,
          createdAt,
        });

        await tx.insert(groupMembers).values([
          {
            groupId: defaultGroupId,
            userId: humanAgentId,
            lastReadMessageId: null,
            joinedAt: createdAt,
          },
          {
            groupId: defaultGroupId,
            userId: assistantAgentId,
            lastReadMessageId: null,
            joinedAt: createdAt,
          },
        ]);
        createdGroup = true;
      }

      return { workspaceId: input.workspaceId, humanAgentId, assistantAgentId, defaultGroupId };
    });

    if (createdHuman) {
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "agents",
        action: "insert",
      });
    }
    if (createdAssistant) {
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "agents",
        action: "insert",
      });
    }
    if (createdGroup) {
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "groups",
        action: "insert",
        recordId: result.defaultGroupId,
      });
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "group_members",
        action: "insert",
        recordId: result.defaultGroupId,
      });
    }

    return result;
  },

  async createSubAgentWithP2P(input: {
    workspaceId: UUID;
    creatorId: UUID;
    role: string;
    guidance?: string;
    kind?: AgentKind;
    autoRunEnabled?: boolean;
    originType?: string | null;
    originId?: UUID | null;
    groupKind?: GroupKind;
  }) {
    const db = getDb();
    const createdAt = now();
    const agentId = uuid();
    const groupId = uuid();

    const defaults = await store.ensureWorkspaceDefaults({ workspaceId: input.workspaceId });
    const humanAgentId = defaults.humanAgentId;

    const workspace = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1);
    if (workspace.length === 0) throw new Error("workspace not found");

    await db.transaction(async (tx) => {
      await tx.insert(agents).values({
        id: agentId,
        workspaceId: input.workspaceId,
        role: input.role,
        kind: input.kind ?? "worker",
        autoRunEnabled: input.autoRunEnabled ?? true,
        originType: input.originType ?? null,
        originId: input.originId ?? null,
        deletedAt: null,
        lastActiveAt: createdAt,
        parentId: input.creatorId,
        llmHistory: initialAgentHistory({
          agentId,
          workspaceId: input.workspaceId,
          role: input.role,
          guidance: input.guidance,
        }),
        createdAt,
      });

      await tx.insert(groups).values({
        id: groupId,
        workspaceId: input.workspaceId,
        name: input.role,
        kind: input.groupKind ?? "chat",
        deletedAt: null,
        createdAt,
      });

      await tx.insert(groupMembers).values([
        {
          groupId,
          userId: humanAgentId,
          lastReadMessageId: null,
          joinedAt: createdAt,
        },
        {
          groupId,
          userId: agentId,
          lastReadMessageId: null,
          joinedAt: createdAt,
        },
      ]);
    });

    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "agents",
      action: "insert",
      recordId: agentId,
    });
    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "groups",
      action: "insert",
      recordId: groupId,
    });
    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "group_members",
      action: "insert",
      recordId: groupId,
    });

    return { agentId, groupId, humanAgentId, createdAt: createdAt.toISOString() };
  },

  async addGroupMembers(input: { groupId: UUID; userIds: UUID[] }) {
    const db = getDb();
    const joinedAt = now();

    if (input.userIds.length === 0) return;

    const group = await db
      .select({ workspaceId: groups.workspaceId })
      .from(groups)
      .where(and(eq(groups.id, input.groupId), isNull(groups.deletedAt)))
      .limit(1);
    if (group.length === 0) throw new Error("group not found");

    await db
      .insert(groupMembers)
      .values(
        input.userIds.map((userId) => ({
          groupId: input.groupId,
          userId,
          lastReadMessageId: null,
          joinedAt,
        }))
      )
      .onConflictDoNothing();

    await emitDbWrite({
      workspaceId: group[0]!.workspaceId,
      table: "group_members",
      action: "insert",
      recordId: input.groupId,
    });
  },

  async createGroup(input: { workspaceId: UUID; memberIds: UUID[]; name?: string; kind?: GroupKind }) {
    const db = getDb();
    const safeMemberIds = [...new Set(input.memberIds.filter((id) => isUuid(id)))];
    if (safeMemberIds.length < 2) {
      throw new Error("memberIds must contain at least two valid UUIDs");
    }
    const groupId = uuid();
    const createdAt = now();

    await db.transaction(async (tx) => {
      await tx.insert(groups).values({
        id: groupId,
        workspaceId: input.workspaceId,
        name: input.name ?? null,
        kind: input.kind ?? "chat",
        deletedAt: null,
        createdAt,
      });

      await tx.insert(groupMembers).values(
        safeMemberIds.map((userId) => ({
          groupId,
          userId,
          lastReadMessageId: null,
          joinedAt: createdAt,
        }))
      );
    });

    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "groups",
      action: "insert",
      recordId: groupId,
    });
    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "group_members",
      action: "insert",
      recordId: groupId,
    });

    return { id: groupId, name: input.name ?? null, createdAt: createdAt.toISOString() };
  },

  async findLatestExactGroupId(input: { workspaceId: UUID; memberIds: UUID[] }): Promise<UUID | null> {
    const db = getDb();
    const ids = [...new Set(input.memberIds)].filter((id) => isUuid(id));
    if (ids.length === 0) return null;

    const rows = await db
      .select({
        id: groups.id,
        createdAt: groups.createdAt,
        lastMessageTime: dsql<Date | null>`max(${messages.sendTime})`,
      })
      .from(groups)
      .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
      .leftJoin(messages, eq(messages.groupId, groups.id))
      .where(
        and(eq(groups.workspaceId, input.workspaceId), inArray(groupMembers.userId, ids), isNull(groups.deletedAt))
      )
      .groupBy(groups.id)
      .having(
        dsql`count(distinct ${groupMembers.userId}) = ${ids.length} and count(*) = ${ids.length}`
      )
      .orderBy(desc(dsql`coalesce(max(${messages.sendTime}), ${groups.createdAt})`))
      .limit(1);

    return rows[0]?.id ?? null;
  },

  async listMessages(input: { groupId: UUID }) {
    const db = getDb();
    const group = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, input.groupId), isNull(groups.deletedAt)))
      .limit(1);
    if (group.length === 0) return [];

    const rows = await db
      .select({
        id: messages.id,
        senderId: messages.senderId,
        content: messages.content,
        contentType: messages.contentType,
        sendTime: messages.sendTime,
      })
      .from(messages)
      .where(eq(messages.groupId, input.groupId))
      .orderBy(messages.sendTime);

    return rows.map((m) => ({ ...m, sendTime: m.sendTime.toISOString() }));
  },

  async listWorkspacePublicFeed(input: { workspaceId: UUID; limit?: number }) {
    const db = getDb();
    const limit = Math.max(1, Math.min(input.limit ?? 300, 1000));
    const rows = await db
      .select({
        id: messages.id,
        groupId: messages.groupId,
        senderId: messages.senderId,
        content: messages.content,
        contentType: messages.contentType,
        sendTime: messages.sendTime,
        groupName: groups.name,
      })
      .from(messages)
      .innerJoin(groups, eq(groups.id, messages.groupId))
      .where(and(eq(messages.workspaceId, input.workspaceId), isNull(groups.deletedAt)))
      .orderBy(desc(messages.sendTime))
      .limit(limit);

    return rows
      .map((m) => ({
        id: m.id,
        groupId: m.groupId,
        groupName: m.groupName,
        senderId: m.senderId,
        content: m.content,
        contentType: m.contentType,
        sendTime: m.sendTime.toISOString(),
      }))
      .reverse();
  },

  async sendMessage(input: {
    groupId: UUID;
    senderId: UUID;
    content: string;
    contentType: string;
  }) {
    const db = getDb();
    const group = await db
      .select({ workspaceId: groups.workspaceId })
      .from(groups)
      .where(and(eq(groups.id, input.groupId), isNull(groups.deletedAt)))
      .limit(1);

    if (group.length === 0) throw new Error("group not found");

    const messageId = uuid();
    const sendTime = now();

    await db.insert(messages).values({
      id: messageId,
      workspaceId: group[0]!.workspaceId,
      groupId: input.groupId,
      senderId: input.senderId,
      contentType: input.contentType,
      content: input.content,
      sendTime,
    });

    await emitDbWrite({
      workspaceId: group[0]!.workspaceId,
      table: "messages",
      action: "insert",
      recordId: messageId,
    });

    return { id: messageId, sendTime: sendTime.toISOString() };
  },

  async sendDirectMessage(input: {
    workspaceId: UUID;
    fromId: UUID;
    toId: UUID;
    observerHumanId?: UUID | null;
    content: string;
    contentType?: string;
    groupName?: string | null;
    newThread?: boolean;
  }) {
    const memberIds = [
      input.fromId,
      input.toId,
      input.observerHumanId && input.observerHumanId !== input.fromId && input.observerHumanId !== input.toId
        ? input.observerHumanId
        : null,
    ].filter(Boolean) as UUID[];

    let groupId: UUID;
    let channel: "new_thread" | "new_group" | "reuse_existing_group";
    if (input.newThread === true) {
      groupId = (
        await this.createGroup({
          workspaceId: input.workspaceId,
          memberIds,
          name: input.groupName ?? undefined,
        })
      ).id;
      channel = "new_thread";
    } else if (memberIds.length === 2) {
      const existing = await this.findLatestExactP2PGroupId({
        workspaceId: input.workspaceId,
        memberA: memberIds[0]!,
        memberB: memberIds[1]!,
        preferredName: input.groupName ?? null,
      });
      groupId =
        (await this.mergeDuplicateExactP2PGroups({
          workspaceId: input.workspaceId,
          memberA: memberIds[0]!,
          memberB: memberIds[1]!,
          preferredName: input.groupName ?? null,
        })) ??
        (
          await this.createGroup({
            workspaceId: input.workspaceId,
            memberIds,
            name: input.groupName ?? undefined,
          })
        ).id;
      channel = existing ? "reuse_existing_group" : "new_group";
    } else {
      const existing = await this.findLatestExactGroupId({
        workspaceId: input.workspaceId,
        memberIds,
      });
      groupId =
        existing ??
        (
          await this.createGroup({
            workspaceId: input.workspaceId,
            memberIds,
            name: input.groupName ?? undefined,
          })
        ).id;
      channel = existing ? "reuse_existing_group" : "new_group";
    }

    const message = await this.sendMessage({
      groupId,
      senderId: input.fromId,
      content: input.content,
      contentType: input.contentType ?? "text",
    });

    return { groupId, messageId: message.id, sendTime: message.sendTime, channel };
  },

  async getGroupWorkspaceId(input: { groupId: UUID }): Promise<UUID> {
    const db = getDb();
    const group = await db
      .select({ workspaceId: groups.workspaceId })
      .from(groups)
      .where(and(eq(groups.id, input.groupId), isNull(groups.deletedAt)))
      .limit(1);
    if (group.length === 0) throw new Error("group not found");
    return group[0]!.workspaceId;
  },

  async markGroupRead(input: { groupId: UUID; readerId: UUID }) {
    const db = getDb();
    const last = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.groupId, input.groupId))
      .orderBy(desc(messages.sendTime))
      .limit(1);

    await db
      .update(groupMembers)
      .set({ lastReadMessageId: last[0]?.id ?? null })
      .where(
        dsql`${groupMembers.groupId} = ${input.groupId} and ${groupMembers.userId} = ${input.readerId}`
      );

    const group = await db
      .select({ workspaceId: groups.workspaceId })
      .from(groups)
      .where(and(eq(groups.id, input.groupId), isNull(groups.deletedAt)))
      .limit(1);
    if (group.length > 0) {
      await emitDbWrite({
        workspaceId: group[0]!.workspaceId,
        table: "group_members",
        action: "update",
        recordId: input.groupId,
      });
    }
  },

  async markGroupReadToMessage(input: { groupId: UUID; readerId: UUID; messageId: UUID }) {
    const db = getDb();
    await db
      .update(groupMembers)
      .set({ lastReadMessageId: input.messageId })
      .where(
        dsql`${groupMembers.groupId} = ${input.groupId} and ${groupMembers.userId} = ${input.readerId}`
      );

    const group = await db
      .select({ workspaceId: groups.workspaceId })
      .from(groups)
      .where(and(eq(groups.id, input.groupId), isNull(groups.deletedAt)))
      .limit(1);
    if (group.length > 0) {
      await emitDbWrite({
        workspaceId: group[0]!.workspaceId,
        table: "group_members",
        action: "update",
        recordId: input.groupId,
      });
    }
  },

  async listGroupMemberIds(input: { groupId: UUID }): Promise<UUID[]> {
    const db = getDb();
    const exists = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, input.groupId), isNull(groups.deletedAt)))
      .limit(1);
    if (exists.length === 0) return [];

    const rows = await db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, input.groupId));
    return rows.map((r) => r.userId);
  },

  async listAgents(
    input?: { workspaceId?: UUID; includeDeleted?: boolean; kinds?: AgentKind[] }
  ): Promise<
    Array<{
      id: UUID;
      workspaceId: UUID;
      role: string;
      kind: AgentKind;
      autoRunEnabled: boolean;
      deletedAt: Date | null;
      llmHistory: string;
      modelProfileId: UUID | null;
      modelName: string | null;
      modelProvider: string | null;
      modelValue: string | null;
      modelBaseUrl: string | null;
      modelApiKey: string | null;
      modelHeadersJson: string | null;
    }>
  > {
    const db = getDb();
    const rows = await db
      .select({
        id: agents.id,
        workspaceId: agents.workspaceId,
        role: agents.role,
        kind: agents.kind,
        autoRunEnabled: agents.autoRunEnabled,
        deletedAt: agents.deletedAt,
        llmHistory: agents.llmHistory,
        modelProfileId: agents.modelProfileId,
        modelName: modelProfiles.name,
        modelProvider: modelProfiles.provider,
        modelValue: modelProfiles.model,
        modelBaseUrl: modelProfiles.baseUrl,
        modelApiKey: modelProfiles.apiKey,
        modelHeadersJson: modelProfiles.headersJson,
      })
      .from(agents)
      .leftJoin(modelProfiles, eq(modelProfiles.id, agents.modelProfileId))
      .where(
        and(
          input?.workspaceId ? eq(agents.workspaceId, input.workspaceId) : undefined,
          input?.includeDeleted ? undefined : isNull(agents.deletedAt),
          input?.kinds && input.kinds.length > 0 ? inArray(agents.kind, input.kinds) : undefined
        )
      )
      .orderBy(desc(agents.createdAt));

    return rows.map((row) => ({
      ...row,
      kind: row.kind as AgentKind,
    }));
  },

  async getAgent(input: { agentId: UUID }): Promise<{
    id: UUID;
    role: string;
    kind: AgentKind;
    autoRunEnabled: boolean;
    deletedAt: Date | null;
    llmHistory: string;
    workspaceId: UUID;
    modelProfileId: UUID | null;
  }> {
    const db = getDb();
    const rows = await db
      .select({
        id: agents.id,
        role: agents.role,
        kind: agents.kind,
        autoRunEnabled: agents.autoRunEnabled,
        deletedAt: agents.deletedAt,
        llmHistory: agents.llmHistory,
        workspaceId: agents.workspaceId,
        modelProfileId: agents.modelProfileId,
      })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)))
      .limit(1);
    if (rows.length === 0) throw new Error("agent not found");
    const row = rows[0]!;
    return {
      ...row,
      kind: row.kind as AgentKind,
    };
  },

  async getAgentRole(input: { agentId: UUID }): Promise<string> {
    const agent = await this.getAgent(input);
    return agent.role;
  },

  async getGroupKind(input: { groupId: UUID }): Promise<GroupKind | null> {
    const db = getDb();
    const rows = await db
      .select({ kind: groups.kind })
      .from(groups)
      .where(and(eq(groups.id, input.groupId), isNull(groups.deletedAt)))
      .limit(1);
    return (rows[0]?.kind as GroupKind | undefined) ?? null;
  },

  async setAgentModelProfile(input: {
    agentId: UUID;
    workspaceId: UUID;
    modelProfileId: UUID | null;
  }) {
    const db = getDb();
    if (input.modelProfileId) {
      const profile = await db
        .select({ id: modelProfiles.id })
        .from(modelProfiles)
        .where(
          and(
            eq(modelProfiles.id, input.modelProfileId),
            eq(modelProfiles.workspaceId, input.workspaceId)
          )
        )
        .limit(1);
      if (profile.length === 0) throw new Error("model profile not found");
    }

    await db
      .update(agents)
      .set({ modelProfileId: input.modelProfileId })
      .where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, input.workspaceId)));

    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "agents",
      action: "update",
      recordId: input.agentId,
    });
  },

  async getAgentModelRuntimeConfig(input: { agentId: UUID }): Promise<{
    provider: ModelProvider | null;
    model: string | null;
    baseUrl: string | null;
    apiKey: string | null;
    headers: Record<string, string>;
    profileId: UUID | null;
    profileName: string | null;
  }> {
    const db = getDb();
    const rows = await db
      .select({
        profileId: modelProfiles.id,
        profileName: modelProfiles.name,
        provider: modelProfiles.provider,
        model: modelProfiles.model,
        baseUrl: modelProfiles.baseUrl,
        apiKey: modelProfiles.apiKey,
        headersJson: modelProfiles.headersJson,
      })
      .from(agents)
      .leftJoin(modelProfiles, eq(modelProfiles.id, agents.modelProfileId))
      .where(eq(agents.id, input.agentId))
      .limit(1);
    const row = rows[0];
    if (!row || !row.profileId) {
      return {
        provider: null,
        model: null,
        baseUrl: null,
        apiKey: null,
        headers: {},
        profileId: null,
        profileName: null,
      };
    }
    return {
      provider: row.provider as ModelProvider,
      model: row.model,
      baseUrl: row.baseUrl,
      apiKey: row.apiKey,
      headers: parseHeadersJson(row.headersJson),
      profileId: row.profileId,
      profileName: row.profileName,
    };
  },

  async setAgentHistory(input: { agentId: UUID; llmHistory: string; workspaceId?: UUID }) {
    const db = getDb();
    await db.update(agents).set({ llmHistory: input.llmHistory }).where(eq(agents.id, input.agentId));

    const workspaceId =
      input.workspaceId ??
      (
        await db
          .select({ workspaceId: agents.workspaceId })
          .from(agents)
          .where(eq(agents.id, input.agentId))
          .limit(1)
      )[0]?.workspaceId;
    if (workspaceId) {
      await emitDbWrite({
        workspaceId,
        table: "agents",
        action: "update",
        recordId: input.agentId,
      });
    }
  },

  async setAgentAutoRun(input: { agentId: UUID; autoRunEnabled: boolean }) {
    const db = getDb();
    const row = await db
      .select({ workspaceId: agents.workspaceId })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)))
      .limit(1);
    if (row.length === 0) return;
    await db
      .update(agents)
      .set({ autoRunEnabled: input.autoRunEnabled, lastActiveAt: now() })
      .where(eq(agents.id, input.agentId));
    await emitDbWrite({
      workspaceId: row[0]!.workspaceId,
      table: "agents",
      action: "update",
      recordId: input.agentId,
    });
  },

  async bulkPauseAgents(input: {
    workspaceId: UUID;
    includeKinds?: AgentKind[];
    excludeKinds?: AgentKind[];
  }) {
    const db = getDb();
    const rows = await db
      .select({ id: agents.id, kind: agents.kind })
      .from(agents)
      .where(and(eq(agents.workspaceId, input.workspaceId), isNull(agents.deletedAt)));
    const include = new Set(input.includeKinds ?? []);
    const exclude = new Set(input.excludeKinds ?? []);
    const ids = rows
      .filter((r) => (include.size === 0 ? true : include.has(r.kind as AgentKind)))
      .filter((r) => !exclude.has(r.kind as AgentKind))
      .map((r) => r.id);
    if (ids.length > 0) {
      await db
        .update(agents)
        .set({ autoRunEnabled: false, lastActiveAt: now() })
        .where(inArray(agents.id, ids));
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "agents",
        action: "update",
      });
    }
    return { agentIds: ids, paused: ids.length };
  },

  async bulkSoftDeleteAgents(input: {
    workspaceId: UUID;
    includeKinds?: AgentKind[];
    excludeKinds?: AgentKind[];
  }) {
    const db = getDb();
    const rows = await db
      .select({ id: agents.id, kind: agents.kind })
      .from(agents)
      .where(and(eq(agents.workspaceId, input.workspaceId), isNull(agents.deletedAt)));
    const include = new Set(input.includeKinds ?? []);
    const exclude = new Set(input.excludeKinds ?? []);
    const ids = rows
      .filter((r) => (include.size === 0 ? true : include.has(r.kind as AgentKind)))
      .filter((r) => !exclude.has(r.kind as AgentKind))
      .map((r) => r.id);
    if (ids.length > 0) {
      const deletedAt = now();
      await db.update(agents).set({ deletedAt, autoRunEnabled: false }).where(inArray(agents.id, ids));
      await db.delete(groupMembers).where(inArray(groupMembers.userId, ids));
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "agents",
        action: "update",
      });
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "group_members",
        action: "delete",
      });
    }
    return { agentIds: ids, deleted: ids.length };
  },

  async softDeleteAgentsByIds(input: { workspaceId: UUID; agentIds: UUID[] }) {
    const ids = [...new Set(input.agentIds)].filter(Boolean);
    if (ids.length === 0) return { agentIds: [], deleted: 0 };
    const db = getDb();
    const existing = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, input.workspaceId), isNull(agents.deletedAt), inArray(agents.id, ids)));
    const existingIds = existing.map((x) => x.id);
    if (existingIds.length === 0) return { agentIds: [], deleted: 0 };
    await db.update(agents).set({ deletedAt: now(), autoRunEnabled: false }).where(inArray(agents.id, existingIds));
    await db.delete(groupMembers).where(inArray(groupMembers.userId, existingIds));
    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "agents",
      action: "update",
    });
    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "group_members",
      action: "delete",
    });
    return { agentIds: existingIds, deleted: existingIds.length };
  },

  async softDeleteOrphanGroups(input: { workspaceId: UUID }) {
    const db = getDb();
    const defaults = await this.ensureWorkspaceDefaults({ workspaceId: input.workspaceId });
    const rows = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.workspaceId, input.workspaceId), isNull(groups.deletedAt)));
    const orphanIds: UUID[] = [];
    for (const row of rows) {
      if (row.id === defaults.defaultGroupId) continue;
      const members = await db
        .select({
          userId: groupMembers.userId,
          agentId: agents.id,
          deletedAt: agents.deletedAt,
        })
        .from(groupMembers)
        .leftJoin(agents, eq(agents.id, groupMembers.userId))
        .where(eq(groupMembers.groupId, row.id));
      // Only count members that still map to a real agent row.
      const activeMembers = members.filter((m) => !!m.agentId && !m.deletedAt);
      // Remove degenerate groups with 0/1 active member after agent cleanup.
      if (activeMembers.length <= 1) orphanIds.push(row.id);
    }
    if (orphanIds.length > 0) {
      await db.update(groups).set({ deletedAt: now() }).where(inArray(groups.id, orphanIds));
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "groups",
        action: "update",
      });
    }
    return { groupIds: orphanIds, deleted: orphanIds.length };
  },

  async softDeleteRedundantSystemGroups(input: { workspaceId: UUID }) {
    const db = getDb();
    const defaults = await this.ensureWorkspaceDefaults({ workspaceId: input.workspaceId });
    const rows = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.workspaceId, input.workspaceId), isNull(groups.deletedAt)));

    const toDelete: UUID[] = [];
    for (const row of rows) {
      if (row.id === defaults.defaultGroupId) continue;
      const members = await db
        .select({
          userId: groupMembers.userId,
          agentId: agents.id,
          role: agents.role,
          kind: agents.kind,
          deletedAt: agents.deletedAt,
        })
        .from(groupMembers)
        .leftJoin(agents, eq(agents.id, groupMembers.userId))
        .where(eq(groupMembers.groupId, row.id));
      // Ignore dangling group_members rows whose userId no longer exists in agents.
      const activeMembers = members.filter((m) => !!m.agentId && !m.deletedAt);
      if (activeMembers.length === 0) {
        toDelete.push(row.id);
        continue;
      }
      // Keep only groups that still contain at least one non-system participant.
      const hasNonSystem = activeMembers.some((m) => {
        const kind = (m.kind ?? "") as AgentKind;
        return kind !== "system_human" && kind !== "system_assistant";
      });
      if (!hasNonSystem) {
        toDelete.push(row.id);
      }
    }

    if (toDelete.length > 0) {
      await db.update(groups).set({ deletedAt: now() }).where(inArray(groups.id, toDelete));
      await emitDbWrite({
        workspaceId: input.workspaceId,
        table: "groups",
        action: "update",
      });
    }
    return { groupIds: toDelete, deleted: toDelete.length };
  },

  async listUnreadByGroup(input: { agentId: UUID }): Promise<
    Array<{
      groupId: UUID;
      messages: Array<{
        id: UUID;
        senderId: UUID;
        contentType: string;
        content: string;
        sendTime: string;
      }>;
    }>
  > {
    const db = getDb();
    const currentAgent = await db
      .select({ autoRunEnabled: agents.autoRunEnabled, deletedAt: agents.deletedAt })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    if (currentAgent.length === 0) return [];
    if (currentAgent[0]!.deletedAt || !currentAgent[0]!.autoRunEnabled) return [];

    const memberships = await db
      .select({ groupId: groupMembers.groupId, lastReadMessageId: groupMembers.lastReadMessageId })
      .from(groupMembers)
      .where(eq(groupMembers.userId, input.agentId));

    const result = [];

    for (const m of memberships) {
      const groupRow = await db
        .select({ deletedAt: groups.deletedAt })
        .from(groups)
        .where(eq(groups.id, m.groupId))
        .limit(1);
      if (groupRow.length === 0 || groupRow[0]!.deletedAt) continue;

      let cutoff = new Date(0);
      if (m.lastReadMessageId) {
        const last = await db
          .select({ sendTime: messages.sendTime })
          .from(messages)
          .where(eq(messages.id, m.lastReadMessageId))
          .limit(1);
        cutoff = last[0]?.sendTime ?? cutoff;
      }

      const rows = await db
        .select({
          id: messages.id,
          senderId: messages.senderId,
          content: messages.content,
          contentType: messages.contentType,
          sendTime: messages.sendTime,
        })
        .from(messages)
        .where(
          and(eq(messages.groupId, m.groupId), gt(messages.sendTime, cutoff), ne(messages.senderId, input.agentId))
        )
        .orderBy(messages.sendTime);

      if (rows.length === 0) continue;

      result.push({
        groupId: m.groupId,
        messages: rows.map((row) => ({ ...row, sendTime: row.sendTime.toISOString() })),
      });
    }

    return result;
  },

  async listGroups(input: { workspaceId?: UUID; agentId?: UUID }) {
    const db = getDb();
    const viewerRole =
      input.agentId
        ? (
            await db
              .select({ role: agents.role })
              .from(agents)
              .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)))
              .limit(1)
          )[0]?.role ?? null
        : null;

    const rows = input.agentId
      ? await db
          .select({
            id: groups.id,
            name: groups.name,
            kind: groups.kind,
            workspaceId: groups.workspaceId,
            contextTokens: groups.contextTokens,
            createdAt: groups.createdAt,
          })
          .from(groups)
          .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
          .where(
            input.workspaceId
              ? and(eq(groups.workspaceId, input.workspaceId), eq(groupMembers.userId, input.agentId), isNull(groups.deletedAt))
              : and(eq(groupMembers.userId, input.agentId), isNull(groups.deletedAt))
          )
          .orderBy(desc(groups.createdAt))
      : await db
          .select({
            id: groups.id,
            name: groups.name,
            kind: groups.kind,
            workspaceId: groups.workspaceId,
            contextTokens: groups.contextTokens,
            createdAt: groups.createdAt,
          })
          .from(groups)
          .where(
            and(
              input.workspaceId ? eq(groups.workspaceId, input.workspaceId) : undefined,
              isNull(groups.deletedAt)
            )
          )
          .orderBy(desc(groups.createdAt));

    const result = [];
    for (const g of rows) {
      const members = await db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, g.id));

      const lastMessage = await db
        .select({
          id: messages.id,
          senderId: messages.senderId,
          content: messages.content,
          contentType: messages.contentType,
          sendTime: messages.sendTime,
        })
        .from(messages)
        .where(eq(messages.groupId, g.id))
        .orderBy(desc(messages.sendTime))
        .limit(1);

      let unreadCount = 0;
      if (input.agentId) {
        const state = await db
          .select({ lastReadMessageId: groupMembers.lastReadMessageId })
          .from(groupMembers)
          .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, input.agentId)))
          .limit(1);

        const lastReadId = state[0]?.lastReadMessageId ?? null;
        if (!lastReadId) {
          const countRow = await db
            .select({ c: dsql<number>`count(*)` })
            .from(messages)
            .where(and(eq(messages.groupId, g.id), ne(messages.senderId, input.agentId)));
          unreadCount = Number(countRow[0]?.c ?? 0);
        } else {
          const lastRead = await db
            .select({ sendTime: messages.sendTime })
            .from(messages)
            .where(eq(messages.id, lastReadId))
            .limit(1);

          const cutoff = lastRead[0]?.sendTime ?? new Date(0);
          const countRow = await db
            .select({ c: dsql<number>`count(*)` })
            .from(messages)
            .where(
              and(eq(messages.groupId, g.id), gt(messages.sendTime, cutoff), ne(messages.senderId, input.agentId))
            );
          unreadCount = Number(countRow[0]?.c ?? 0);
        }
      }

      const updatedAt = lastMessage[0]?.sendTime ?? g.createdAt;

      result.push({
        id: g.id,
        name: g.name,
        kind: g.kind as GroupKind,
        memberIds: members.map((m) => m.userId),
        unreadCount,
        contextTokens: g.contextTokens ?? 0,
        lastMessage: lastMessage[0]
          ? {
              content: lastMessage[0].content,
              contentType: lastMessage[0].contentType,
              sendTime: lastMessage[0].sendTime.toISOString(),
              senderId: lastMessage[0].senderId,
            }
          : undefined,
        updatedAt: updatedAt.toISOString(),
        createdAt: g.createdAt.toISOString(),
      });
    }

    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async setGroupContextTokens(input: { groupId: UUID; tokens: number }) {
    const db = getDb();
    const group = await db
      .select({ workspaceId: groups.workspaceId, contextTokens: groups.contextTokens })
      .from(groups)
      .where(eq(groups.id, input.groupId))
      .limit(1);
    if (group.length === 0) throw new Error("group not found");

    await db.update(groups).set({ contextTokens: input.tokens }).where(eq(groups.id, input.groupId));

    await emitDbWrite({
      workspaceId: group[0]!.workspaceId,
      table: "groups",
      action: "update",
      recordId: input.groupId,
    });

    return { contextTokens: input.tokens };
  },

  async createTaskRun(input: {
    workspaceId: UUID;
    rootGroupId: UUID;
    ownerAgentId: UUID;
    goal: string;
    status: "running" | "stopping" | "stopped" | "completed";
    budgetJson: string;
    metricsJson: string;
    startAt: Date;
    deadlineAt: Date;
  }): Promise<TaskRunRecord> {
    const db = getDb();
    const createdAt = now();
    const id = uuid();
    await db.insert(taskRuns).values({
      id,
      workspaceId: input.workspaceId,
      rootGroupId: input.rootGroupId,
      ownerAgentId: input.ownerAgentId,
      goal: input.goal,
      status: input.status,
      stopReason: null,
      budgetJson: input.budgetJson,
      metricsJson: input.metricsJson,
      summaryMessageId: null,
      startAt: input.startAt,
      deadlineAt: input.deadlineAt,
      stoppedAt: null,
      createdAt,
      updatedAt: createdAt,
    });

    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "task_runs",
      action: "insert",
      recordId: id,
    });
    const task = await this.getTaskRunById({ taskId: id });
    if (!task) throw new Error("failed to create task run");
    return task;
  },

  async updateTaskRun(input: {
    taskId: UUID;
    workspaceId: UUID;
    status?: "running" | "stopping" | "stopped" | "completed";
    stopReason?: TaskStopReason | null;
    budgetJson?: string;
    metricsJson?: string;
    summaryMessageId?: UUID | null;
    stoppedAt?: Date | null;
  }): Promise<TaskRunRecord | null> {
    const db = getDb();
    const patch: Record<string, unknown> = { updatedAt: now() };
    if (typeof input.status === "string") patch.status = input.status;
    if (typeof input.stopReason !== "undefined") patch.stopReason = input.stopReason;
    if (typeof input.budgetJson === "string") patch.budgetJson = input.budgetJson;
    if (typeof input.metricsJson === "string") patch.metricsJson = input.metricsJson;
    if (typeof input.summaryMessageId !== "undefined") patch.summaryMessageId = input.summaryMessageId;
    if (typeof input.stoppedAt !== "undefined") patch.stoppedAt = input.stoppedAt;

    await db
      .update(taskRuns)
      .set(patch)
      .where(and(eq(taskRuns.id, input.taskId), eq(taskRuns.workspaceId, input.workspaceId)));

    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "task_runs",
      action: "update",
      recordId: input.taskId,
    });
    return await this.getTaskRunById({ taskId: input.taskId });
  },

  async getTaskRunById(input: { taskId: UUID }): Promise<TaskRunRecord | null> {
    const db = getDb();
    const rows = await db
      .select({
        id: taskRuns.id,
        workspaceId: taskRuns.workspaceId,
        rootGroupId: taskRuns.rootGroupId,
        ownerAgentId: taskRuns.ownerAgentId,
        goal: taskRuns.goal,
        status: taskRuns.status,
        stopReason: taskRuns.stopReason,
        budgetJson: taskRuns.budgetJson,
        metricsJson: taskRuns.metricsJson,
        summaryMessageId: taskRuns.summaryMessageId,
        startAt: taskRuns.startAt,
        deadlineAt: taskRuns.deadlineAt,
        stoppedAt: taskRuns.stoppedAt,
        createdAt: taskRuns.createdAt,
        updatedAt: taskRuns.updatedAt,
      })
      .from(taskRuns)
      .where(eq(taskRuns.id, input.taskId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      rootGroupId: row.rootGroupId,
      ownerAgentId: row.ownerAgentId,
      goal: row.goal,
      status: row.status as TaskRunRecord["status"],
      stopReason: (row.stopReason as TaskStopReason | null) ?? null,
      budgetJson: row.budgetJson,
      metricsJson: row.metricsJson,
      summaryMessageId: row.summaryMessageId,
      startAt: row.startAt.toISOString(),
      deadlineAt: row.deadlineAt.toISOString(),
      stoppedAt: row.stoppedAt ? row.stoppedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },

  async getLatestTaskRun(input: { workspaceId: UUID }): Promise<TaskRunRecord | null> {
    const db = getDb();
    const rows = await db
      .select({
        id: taskRuns.id,
        workspaceId: taskRuns.workspaceId,
        rootGroupId: taskRuns.rootGroupId,
        ownerAgentId: taskRuns.ownerAgentId,
        goal: taskRuns.goal,
        status: taskRuns.status,
        stopReason: taskRuns.stopReason,
        budgetJson: taskRuns.budgetJson,
        metricsJson: taskRuns.metricsJson,
        summaryMessageId: taskRuns.summaryMessageId,
        startAt: taskRuns.startAt,
        deadlineAt: taskRuns.deadlineAt,
        stoppedAt: taskRuns.stoppedAt,
        createdAt: taskRuns.createdAt,
        updatedAt: taskRuns.updatedAt,
      })
      .from(taskRuns)
      .where(eq(taskRuns.workspaceId, input.workspaceId))
      .orderBy(desc(taskRuns.updatedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      rootGroupId: row.rootGroupId,
      ownerAgentId: row.ownerAgentId,
      goal: row.goal,
      status: row.status as TaskRunRecord["status"],
      stopReason: (row.stopReason as TaskStopReason | null) ?? null,
      budgetJson: row.budgetJson,
      metricsJson: row.metricsJson,
      summaryMessageId: row.summaryMessageId,
      startAt: row.startAt.toISOString(),
      deadlineAt: row.deadlineAt.toISOString(),
      stoppedAt: row.stoppedAt ? row.stoppedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },

  async listRunningTaskRuns(): Promise<TaskRunRecord[]> {
    const db = getDb();
    const rows = await db
      .select({
        id: taskRuns.id,
        workspaceId: taskRuns.workspaceId,
        rootGroupId: taskRuns.rootGroupId,
        ownerAgentId: taskRuns.ownerAgentId,
        goal: taskRuns.goal,
        status: taskRuns.status,
        stopReason: taskRuns.stopReason,
        budgetJson: taskRuns.budgetJson,
        metricsJson: taskRuns.metricsJson,
        summaryMessageId: taskRuns.summaryMessageId,
        startAt: taskRuns.startAt,
        deadlineAt: taskRuns.deadlineAt,
        stoppedAt: taskRuns.stoppedAt,
        createdAt: taskRuns.createdAt,
        updatedAt: taskRuns.updatedAt,
      })
      .from(taskRuns)
      .where(or(eq(taskRuns.status, "running"), eq(taskRuns.status, "stopping")))
      .orderBy(desc(taskRuns.updatedAt));

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      rootGroupId: row.rootGroupId,
      ownerAgentId: row.ownerAgentId,
      goal: row.goal,
      status: row.status as TaskRunRecord["status"],
      stopReason: (row.stopReason as TaskStopReason | null) ?? null,
      budgetJson: row.budgetJson,
      metricsJson: row.metricsJson,
      summaryMessageId: row.summaryMessageId,
      startAt: row.startAt.toISOString(),
      deadlineAt: row.deadlineAt.toISOString(),
      stoppedAt: row.stoppedAt ? row.stoppedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  },

  async listRecentWorkspaceMessages(input: { workspaceId: UUID; limit?: number }) {
    const db = getDb();
    const limit = Math.max(1, Math.min(5000, input.limit ?? 2000));
    const rows = await db
      .select({
        id: messages.id,
        groupId: messages.groupId,
        senderId: messages.senderId,
        sendTime: messages.sendTime,
      })
      .from(messages)
      .where(eq(messages.workspaceId, input.workspaceId))
      .orderBy(desc(messages.sendTime))
      .limit(limit);

    return rows.map((m) => ({
      id: m.id,
      groupId: m.groupId,
      senderId: m.senderId,
      sendTime: m.sendTime.toISOString(),
    }));
  },

  async createTaskReview(input: {
    taskId: UUID;
    workspaceId: UUID;
    reviewJson: string;
    narrativeText: string;
  }): Promise<TaskReviewRecord> {
    const db = getDb();
    const createdAt = now();
    await db.delete(taskReviews).where(eq(taskReviews.taskId, input.taskId));
    await db.insert(taskReviews).values({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      reviewJson: input.reviewJson,
      narrativeText: input.narrativeText,
      createdAt,
    });
    await emitDbWrite({
      workspaceId: input.workspaceId,
      table: "task_reviews",
      action: "insert",
      recordId: input.taskId,
    });
    return {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      reviewJson: input.reviewJson,
      narrativeText: input.narrativeText,
      createdAt: createdAt.toISOString(),
    };
  },

  async getTaskReview(input: { taskId: UUID }): Promise<TaskReviewRecord | null> {
    const db = getDb();
    const rows = await db
      .select({
        taskId: taskReviews.taskId,
        workspaceId: taskReviews.workspaceId,
        reviewJson: taskReviews.reviewJson,
        narrativeText: taskReviews.narrativeText,
        createdAt: taskReviews.createdAt,
      })
      .from(taskReviews)
      .where(eq(taskReviews.taskId, input.taskId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      taskId: row.taskId,
      workspaceId: row.workspaceId,
      reviewJson: row.reviewJson,
      narrativeText: row.narrativeText,
      createdAt: row.createdAt.toISOString(),
    };
  },
};
