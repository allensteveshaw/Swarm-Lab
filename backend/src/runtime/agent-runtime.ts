import { store } from "@/lib/storage";
import { chatJsonByAgent } from "@/lib/llm-client";
import { GLMStreamAssembler, parseSSEJsonLines } from "@/lib/glm-stream";
import { OpenAIStreamAssembler } from "@/lib/openai-stream";

import { AgentEventBus } from "./event-bus";
import { createDeferred, safeJsonParse } from "./utils";
import { getWorkspaceUIBus } from "./ui-bus";
import { getMcpRegistry } from "./mcp";
import { appendAgentHistorySnapshot, appendAgentLlmRequestRaw, appendAgentStreamEvent } from "./agent-logger";
import { formatSkillPrompt, getSkillLoader } from "./skill-loader";
import { executeShellCommand } from "./shell-executor";

type UUID = string;

type HistoryMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string;
      tool_calls?: unknown;
      reasoning_content?: string;
    }
  | { role: "tool"; content: string; tool_call_id?: string; name?: string };

type ToolCall = {
  index: number;
  id?: string;
  name?: string;
  argumentsText: string;
};

const SKILLS_MARKER = "[skills:loaded]";
const SEND_TOOL_NAMES = new Set(["send", "send_group_message", "send_direct_message"]);
type TaskStopReason =
  | "manual"
  | "timeout"
  | "no_progress"
  | "repeated_output"
  | "goal_reached"
  | "max_turns"
  | "manual_replaced"
  | "token_delta_exceeded";
type TaskRun = {
  id: UUID;
  workspaceId: UUID;
  rootGroupId: UUID;
  ownerAgentId: UUID;
  goal: string;
  status: "running" | "stopping" | "stopped";
  startAt: number;
  deadlineAt: number;
  maxDurationMs: number;
  maxTurns: number;
  maxTokenDelta: number;
  totalTurns: number;
  totalMessages: number;
  startGroupTokens: number;
  lastMessageAt: number;
  repeatedRatio: number;
  participants: Set<UUID>;
  timer: NodeJS.Timeout | null;
  stopReason?: TaskStopReason;
  stoppedAt?: number;
};

type TaskQualityReview = {
  score: {
    completion: number;
    relevance: number;
    clarity: number;
    nonRedundancy: number;
    safety: number;
    overall: number;
  };
  verdict: "pass" | "borderline" | "fail";
  highlights: string[];
  issues: Array<{ severity: "high" | "medium" | "low"; detail: string }>;
  nextActions: string[];
};

async function buildSkillsBlock(): Promise<string> {
  try {
    const loader = await getSkillLoader();
    const skillsMetadata = await loader.getSkillsMetadataPrompt();
    const autoSkills = await loader.listAutoLoadSkills();
    const autoBlocks = autoSkills.map((skill) => formatSkillPrompt(skill)).join("\n\n");
    const skillsParts = [skillsMetadata, autoBlocks].filter((part) => part && part.trim());
    if (skillsParts.length === 0) return "";
    return `${SKILLS_MARKER}\n\n${skillsParts.join("\n\n")}`;
  } catch {
    return "";
  }
}

function historyHasSkills(history: HistoryMessage[]) {
  return history.some(
    (msg) =>
      msg.role === "system" && typeof msg.content === "string" && msg.content.includes(SKILLS_MARKER)
  );
}

function mapOpenRouterMessages(history: HistoryMessage[]): Array<Record<string, unknown>> {
  return history.map((msg) => {
    if (msg.role === "tool") return msg;

    const { reasoning_content, ...rest } = msg as Exclude<HistoryMessage, { role: "tool" }>;
    const mapped: Record<string, unknown> = { ...rest };

    if (msg.role === "assistant" && reasoning_content) {
      mapped.reasoning = reasoning_content;
    }

    return mapped;
  });
}

const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "create",
      description:
        "Create a sub-agent with the given role for delegation. Returns {agentId}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: {
            type: "string",
            description: "Role name for the new agent, e.g. coder/researcher/reviewer",
          },
          guidance: {
            type: "string",
            description: "Extra system guidance to seed the new agent.",
          },
        },
        required: ["role"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self",
      description: "Return the current agent's identity (agent_id, workspace_id, role).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_skill",
      description:
        "Load the full content of a specific skill by name (use when the skill metadata indicates relevance).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          skill_name: { type: "string", description: "Skill name to retrieve" },
        },
        required: ["skill_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_agents",
      description: "List all agents in the current workspace (ids + roles).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send",
      description:
        "Send a direct message to another agent_id. The IM storage (group) is created/selected automatically.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          to: { type: "string", description: "Target agent_id" },
          content: { type: "string", description: "Message content" },
        },
        required: ["to", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_groups",
      description: "List visible groups for this agent.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_group_members",
      description: "List member ids for a group.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          groupId: { type: "string", description: "Target group id" },
        },
        required: ["groupId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_group",
      description: "Create a group with the given member ids.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          memberIds: { type: "array", items: { type: "string" } },
          name: { type: "string" },
        },
        required: ["memberIds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_group_message",
      description: "Send a message to a group.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          groupId: { type: "string" },
          content: { type: "string" },
          contentType: { type: "string" },
        },
        required: ["groupId", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_direct_message",
      description:
        "Send a direct message to another agent. Creates or reuses a P2P group and returns the channel type.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          toAgentId: { type: "string" },
          content: { type: "string" },
          contentType: { type: "string" },
        },
        required: ["toAgentId", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_group_messages",
      description: "Fetch full message history for a group.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          groupId: { type: "string" },
        },
        required: ["groupId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command on the server. Returns stdout/stderr/exitCode. Use for debugging or file operations.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          cwd: { type: "string", description: "Working directory (relative to workspace root or absolute)" },
          timeoutMs: { type: "number", description: "Timeout in milliseconds (default 120000)" },
          maxOutputKB: { type: "number", description: "Maximum combined output size in KB (default 1024)" },
        },
        required: ["command"],
      },
    },
  },
] as const;

const BUILTIN_TOOL_NAMES = new Set(AGENT_TOOLS.map((tool) => tool.function.name));

function isUuid(value: string | null | undefined): value is UUID {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim()
  );
}

function formatUpstreamError(provider: string, status: number, text: string) {
  const raw = String(text ?? "").trim();
  let message = raw;
  let code = "";
  try {
    const parsed = JSON.parse(raw) as any;
    code = String(parsed?.error?.code ?? parsed?.code ?? "");
    message = String(parsed?.error?.message ?? parsed?.message ?? raw);
  } catch {
    // keep raw
  }
  const compact = message.replace(/\s+/g, " ").trim();
  const looksArrearage =
    /arrearage/i.test(code) || /overdue-payment|access denied|in good standing/i.test(compact);
  if (looksArrearage) {
    return `模型调用失败：账户欠费或状态受限（Arrearage）。请到阿里云百炼充值并确认账号状态后重试。provider=${provider}, status=${status}`;
  }
  const clipped = compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
  return `${provider} upstream error: ${status} ${clipped}`;
}

async function getAgentTools() {
  const loadTimeoutMs =
    Number(process.env.MCP_LOAD_TIMEOUT_MS) > 0 ? Number(process.env.MCP_LOAD_TIMEOUT_MS) : 2000;
  const mcp = await getMcpRegistry(BUILTIN_TOOL_NAMES, { loadTimeoutMs });
  const mcpTools = mcp.getToolDefinitions();
  return [...AGENT_TOOLS, ...mcpTools];
}

function getGlmConfig() {
  const apiKey = process.env.GLM_API_KEY ?? process.env.ZHIPUAI_API_KEY ?? "";
  const baseUrl =
    process.env.GLM_BASE_URL ??
    "https://open.bigmodel.cn/api/paas/v4/chat/completions";
  const model = process.env.GLM_MODEL ?? "glm-4.7";

  if (!apiKey) {
    throw new Error("Missing GLM API key (set GLM_API_KEY or ZHIPUAI_API_KEY)");
  }

  return { apiKey, baseUrl, model };
}

type LlmProvider = "glm" | "openrouter" | "openai_compatible";
type ResolvedLlmConfig = {
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
};

function getLlmProvider(): Exclude<LlmProvider, "openai_compatible"> {
  const raw = (process.env.LLM_PROVIDER ?? "glm").toLowerCase();
  if (raw === "openrouter" || raw === "open-router" || raw === "or") return "openrouter";
  return "glm";
}

function normalizeOpenRouterUrl(value: string) {
  if (!value) return "https://openrouter.ai/api/v1/chat/completions";
  if (value.endsWith("/chat/completions")) return value;
  if (value.endsWith("/api/v1")) return `${value}/chat/completions`;
  if (value.endsWith("/v1")) return `${value}/chat/completions`;
  return value;
}

function getOpenRouterConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  const baseUrl = normalizeOpenRouterUrl(
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1/chat/completions"
  );
  const model = process.env.OPENROUTER_MODEL ?? "";
  const httpReferer = process.env.OPENROUTER_HTTP_REFERER ?? "";
  const appTitle = process.env.OPENROUTER_APP_TITLE ?? "";

  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  return { apiKey, baseUrl, model, httpReferer, appTitle };
}

function getOpenAiCompatibleConfig() {
  const apiKey = process.env.OPENAI_COMPAT_API_KEY ?? "";
  const baseUrl =
    process.env.OPENAI_COMPAT_BASE_URL ?? "http://127.0.0.1:11434/v1/chat/completions";
  const model = process.env.OPENAI_COMPAT_MODEL ?? "";
  const headers = safeJsonParse<Record<string, string>>(process.env.OPENAI_COMPAT_HEADERS ?? "{}", {});

  if (!apiKey) {
    throw new Error("Missing OPENAI_COMPAT_API_KEY");
  }

  return { apiKey, baseUrl, model, headers };
}

async function resolveAgentLlmConfig(agentId: UUID): Promise<ResolvedLlmConfig> {
  const profile = await store.getAgentModelRuntimeConfig({ agentId });
  if (profile.provider && profile.model && profile.baseUrl && profile.apiKey) {
    return {
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      headers: profile.headers,
    };
  }

  const provider = getLlmProvider();
  if (provider === "openrouter") {
    const cfg = getOpenRouterConfig();
    return {
      provider: "openrouter",
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      headers: {
        ...(cfg.httpReferer ? { "HTTP-Referer": cfg.httpReferer } : {}),
        ...(cfg.appTitle ? { "X-Title": cfg.appTitle } : {}),
      },
    };
  }

  if ((process.env.LLM_PROVIDER ?? "").toLowerCase() === "openai_compatible") {
    const cfg = getOpenAiCompatibleConfig();
    return {
      provider: "openai_compatible",
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      headers: cfg.headers,
    };
  }

  const cfg = getGlmConfig();
  return {
    provider: "glm",
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
  };
}

class AgentRunner {
  private wake = createDeferred<void>();
  private started = false;
  private running = false;
  private interruptRequested = false;

  constructor(
    private readonly agentId: UUID,
    private readonly bus: AgentEventBus,
    private readonly ensureRunner: (agentId: UUID) => void,
    private readonly wakeAgent: (agentId: UUID) => void,
    private readonly noteTaskTurn: (input: {
      workspaceId: UUID;
      groupId: UUID;
      agentId: UUID;
      finishReason?: string | null;
    }) => void,
    private readonly noteTaskMessage: (input: {
      workspaceId: UUID;
      groupId: UUID;
      senderId: UUID;
      content: string;
      contentType: string;
    }) => void
  ) {}

  start() {
    if (this.started) return;
    this.started = true;
    void this.ensureSkillsLoaded();
    void this.loop();
  }

  private async ensureSkillsLoaded() {
    try {
      const agent = await store.getAgent({ agentId: this.agentId });
      const parsed = safeJsonParse<unknown>(agent.llmHistory, {});
      const history = Array.isArray(parsed) ? (parsed as HistoryMessage[]) : [];
      if (historyHasSkills(history)) return;
      const skillsBlock = await buildSkillsBlock();
      if (!skillsBlock) return;
      history.push({ role: "system", content: skillsBlock });
      await store.setAgentHistory({
        agentId: this.agentId,
        llmHistory: JSON.stringify(history),
      });
    } catch {
      // best-effort only
    }
  }

  wakeup(reason: "manual" | "group_message" | "direct_message" | "context_stream" = "manual") {
    this.wake.resolve();
    this.wake = createDeferred<void>();
    this.bus.emit(this.agentId, {
      event: "agent.wakeup",
      data: { agentId: this.agentId, reason },
    });
  }

  requestInterrupt() {
    this.interruptRequested = true;
    this.wake.resolve();
    this.wake = createDeferred<void>();
  }

  private consumeInterruptRequest() {
    if (!this.interruptRequested) return false;
    this.interruptRequested = false;
    return true;
  }

  private async loop() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this.wake.promise;
      if (this.running) continue;
      this.running = true;
      try {
        await this.processUntilIdle();
      } catch (err) {
        this.bus.emit(this.agentId, {
          event: "agent.error",
          data: { message: err instanceof Error ? err.message : String(err) },
        });
        const message = err instanceof Error ? err.message : String(err);
        void appendAgentStreamEvent({
          agentId: this.agentId,
          kind: "error",
          error: message,
        });
      } finally {
        this.running = false;
      }
    }
  }

  private async processUntilIdle() {
    const agent = await store.getAgent({ agentId: this.agentId }).catch(() => null);
    if (!agent || agent.role === "human" || !agent.autoRunEnabled) return;
    if (this.consumeInterruptRequest()) return;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.consumeInterruptRequest()) return;
      const batches = await store.listUnreadByGroup({ agentId: this.agentId });
      if (batches.length === 0) return;

      this.bus.emit(this.agentId, {
        event: "agent.unread",
        data: {
          agentId: this.agentId,
          batches: batches.map((batch) => ({
            groupId: batch.groupId,
            messageIds: batch.messages.map((m) => m.id),
          })),
        },
      });

      for (const batch of batches) {
        if (this.consumeInterruptRequest()) return;
        await this.processGroupUnread(batch.groupId, batch.messages);
        if (this.consumeInterruptRequest()) return;
      }
    }
  }

  private async processGroupUnread(
    groupId: UUID,
    unreadMessages: Array<{
      id: UUID;
      senderId: UUID;
      content: string;
      contentType: string;
      sendTime: string;
    }>
  ) {
    const workspaceId = await store.getGroupWorkspaceId({ groupId });
    const agent = await store.getAgent({ agentId: this.agentId });
    const parsed = safeJsonParse<unknown>(agent.llmHistory, {});
    const history = Array.isArray(parsed) ? (parsed as HistoryMessage[]) : [];
    const skillsBlock = await buildSkillsBlock();
    const hasSkills = historyHasSkills(history);

    if (history.length === 0) {
      const role = agent.role;
      history.push({
        role: "system",
        content:
          `You are an agent in an IM system.\n` +
          `Your agent_id is: ${this.agentId}.\n` +
          `Your workspace_id is: ${workspaceId}.\n` +
          `Your role is: ${role}.\n` +
          `Act strictly as this role when replying. Be concise and helpful.\n` +
          `Your replies are NOT automatically delivered to humans.\n` +
          `To send messages, you MUST call tools like send_group_message or send_direct_message.\n` +
          `If you need to coordinate with other agents, you may use tools like self, list_agents, create, send, list_groups, list_group_members, create_group, send_group_message, send_direct_message, and get_group_messages.\n` +
          `If you need to run shell commands, use the bash tool.` +
          (skillsBlock ? `\n\n${skillsBlock}` : ""),
      });
    } else if (skillsBlock && !hasSkills) {
      history.push({ role: "system", content: skillsBlock });
    }

    const userContent = unreadMessages
      .map((m) => `[group:${groupId}] ${m.senderId}: ${m.content}`)
      .join("\n");
    history.push({ role: "user", content: userContent });

    const lastId = unreadMessages[unreadMessages.length - 1]?.id;
    if (lastId) {
      await store.markGroupReadToMessage({ groupId, readerId: this.agentId, messageId: lastId });
    }

    const { assistantText, assistantThinking, didSend } = await this.runWithTools({
      groupId,
      workspaceId,
      history,
    });

    history.push({
      role: "assistant",
      content: assistantText,
      reasoning_content: assistantThinking || undefined,
    });

    if (!didSend && !this.interruptRequested) {
      history.push({
        role: "user",
        content:
          "Reminder: This round did not call send_* tools. If external output is needed, use send_group_message or send_direct_message.",
      });

      const followup = await this.runWithTools({
        groupId,
        workspaceId,
        history,
      });

      history.push({
        role: "assistant",
        content: followup.assistantText,
        reasoning_content: followup.assistantThinking || undefined,
      });
    }
    await store.setAgentHistory({
      agentId: this.agentId,
      llmHistory: JSON.stringify(history),
      workspaceId,
    });
    try {
      await appendAgentHistorySnapshot({
        agentId: this.agentId,
        workspaceId,
        groupId,
        history,
      });
    } catch {
      // best-effort logging
    }
    getWorkspaceUIBus().emit(workspaceId, {
      event: "ui.agent.history.persisted",
      data: { workspaceId, agentId: this.agentId, groupId, historyLength: history.length },
    });
  }

  private async runWithTools(input: {
    groupId: UUID;
    workspaceId: UUID;
    history: HistoryMessage[];
  }) {
    const maxToolRounds = 3;
    let assistantText = "";
    let assistantThinking = "";
    let didSend = false;

    for (let round = 0; round < maxToolRounds; round++) {
      const res = await this.callLlmStreaming(input.history, {
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        round,
      });
      assistantText = res.assistantText;
      assistantThinking = res.assistantThinking;

      if (res.toolCalls.length === 0) {
        return { assistantText, assistantThinking, didSend };
      }

      input.history.push({
        role: "assistant",
        content: res.assistantText,
        tool_calls: res.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.argumentsText },
        })),
        reasoning_content: res.assistantThinking || undefined,
      });

      for (const call of res.toolCalls) {
        if (call.name && SEND_TOOL_NAMES.has(call.name)) {
          didSend = true;
        }
        const result = await this.executeToolCall({
          groupId: input.groupId,
          call,
        });
        this.bus.emit(this.agentId, {
          event: "agent.stream",
          data: {
            kind: "tool_result",
            delta: JSON.stringify(result),
            tool_call_id: call.id,
            tool_call_name: call.name,
          },
        });
        void appendAgentStreamEvent({
          agentId: this.agentId,
          round,
          kind: "tool_result",
          delta: JSON.stringify(result),
          tool_call_id: call.id,
          tool_call_name: call.name,
        });
        input.history.push({
          role: "tool",
          content: JSON.stringify(result),
          tool_call_id: call.id,
          name: call.name,
        });
      }

    }

    return { assistantText, assistantThinking, didSend };
  }

  private async executeToolCall(input: { groupId: UUID; call: ToolCall }) {
    const name = input.call.name ?? "";
    const workspaceId = await store.getGroupWorkspaceId({ groupId: input.groupId });
    const latestTask = await store.getLatestTaskRun({ workspaceId }).catch(() => null);
    const inRunningRootTask =
      !!latestTask && latestTask.status === "running" && latestTask.rootGroupId === input.groupId;
    const toolMeta = { toolCallId: input.call.id, toolName: input.call.name };

    getWorkspaceUIBus().emit(workspaceId, {
      event: "ui.agent.tool_call.start",
      data: {
        workspaceId,
        agentId: this.agentId,
        groupId: input.groupId,
        toolCallId: toolMeta.toolCallId,
        toolName: toolMeta.toolName,
      },
    });

    const emitToolDone = (ok: boolean) => {
      getWorkspaceUIBus().emit(workspaceId, {
        event: "ui.agent.tool_call.done",
        data: {
          workspaceId,
          agentId: this.agentId,
          groupId: input.groupId,
          toolCallId: toolMeta.toolCallId,
          toolName: toolMeta.toolName,
          ok,
        },
      });
    };

    if (name === "self") {
      const role = await store.getAgentRole({ agentId: this.agentId }).catch(() => null);
      emitToolDone(true);
      return { ok: true, agentId: this.agentId, workspaceId, role };
    }

    if (name === "get_skill") {
      const args = safeJsonParse<{ skill_name?: string; name?: string }>(
        input.call.argumentsText,
        {}
      );
      const skillName = (args.skill_name ?? args.name ?? "").trim();
      if (!skillName) {
        emitToolDone(false);
        return { ok: false, error: "Missing skill_name" };
      }

      const loader = await getSkillLoader();
      const skill = await loader.getSkill(skillName);
      if (!skill) {
        emitToolDone(false);
        return { ok: false, error: `Unknown skill: ${skillName}`, available: await loader.listSkills() };
      }

      emitToolDone(true);
      return { ok: true, content: formatSkillPrompt(skill) };
    }

    if (name === "bash") {
      const args = safeJsonParse<{
        command?: string;
        cwd?: string;
        timeoutMs?: number;
        maxOutputKB?: number;
      }>(input.call.argumentsText, {});
      const command = (args.command ?? "").trim();
      if (!command) {
        emitToolDone(false);
        return { ok: false, error: "Missing command" };
      }

      try {
        const result = await executeShellCommand({
          command,
          cwd: args.cwd,
          timeoutMs: args.timeoutMs,
          maxOutputKB: args.maxOutputKB,
        });
        emitToolDone(result.ok);
        return result;
      } catch (err: unknown) {
        emitToolDone(false);
        return { ok: false, error: String(err) };
      }
    }

    if (name === "create") {
      if (inRunningRootTask) {
        emitToolDone(false);
        return {
          ok: false,
          error:
            "Tool 'create' is disabled during an active task run. Reuse existing participants in the current group.",
        };
      }
      const args = safeJsonParse<{ role?: string; guidance?: string }>(input.call.argumentsText, {});
      const role = (args.role ?? "").trim();
      const guidance = (args.guidance ?? "").trim();
      if (!role) {
        emitToolDone(false);
        return { ok: false, error: "Missing role" };
      }

      const created = await store.createSubAgentWithP2P({
        workspaceId,
        creatorId: this.agentId,
        role,
        guidance,
        autoRunEnabled: false,
      });
      this.ensureRunner(created.agentId);
      getWorkspaceUIBus().emit(workspaceId, {
        event: "ui.agent.created",
        data: { workspaceId, agent: { id: created.agentId, role, parentId: this.agentId } },
      });
      getWorkspaceUIBus().emit(workspaceId, {
        event: "ui.group.created",
        data: {
          workspaceId,
          group: { id: created.groupId, name: role, memberIds: [created.humanAgentId, created.agentId] },
        },
      });
      emitToolDone(true);
      return { ok: true, agentId: created.agentId, role, groupId: created.groupId };
    }

    if (name === "list_agents") {
      const agents = await store.listAgentsMeta({ workspaceId });
      emitToolDone(true);
      return { ok: true, agents };
    }

    if (name === "send") {
      if (inRunningRootTask) {
        emitToolDone(false);
        return {
          ok: false,
          error:
            "Tool 'send' is disabled during an active task run. Use send_group_message in the current task group.",
        };
      }
      const args = safeJsonParse<{ to?: string; content?: string }>(input.call.argumentsText, {});
      const to = (args.to ?? "").trim();
      const content = (args.content ?? "").trim();
      if (!to) {
        emitToolDone(false);
        return { ok: false, error: "Missing to" };
      }
      if (!isUuid(to)) {
        emitToolDone(false);
        return { ok: false, error: "Invalid to: must be agent UUID" };
      }
      if (!content) {
        emitToolDone(false);
        return { ok: false, error: "Missing content" };
      }

      const delivered = await store.sendDirectMessage({
        workspaceId,
        fromId: this.agentId,
        toId: to,
        // Do not auto-add the human into agent-to-agent threads; sidebar only shows human-participant chats.
        content,
        contentType: "text",
        groupName: null,
      });

      const directMembers = await store.listGroupMemberIds({ groupId: delivered.groupId });
      getWorkspaceUIBus().emit(workspaceId, {
        event: "ui.message.created",
        data: {
          workspaceId,
          groupId: delivered.groupId,
          memberIds: directMembers,
          message: {
            id: delivered.messageId,
            senderId: this.agentId,
            sendTime: delivered.sendTime,
            content,
            contentType: "text",
          },
        },
      });
      this.noteTaskMessage({
        workspaceId,
        groupId: delivered.groupId,
        senderId: this.agentId,
        content,
        contentType: "text",
      });

      const toRole = await store.getAgentRole({ agentId: to }).catch(() => null);
      if (toRole && toRole !== "human") {
        this.ensureRunner(to);
        this.wakeAgent(to);
      }

      emitToolDone(true);
      return { ok: true, ...delivered };
    }

    if (name === "list_groups") {
      const groups = await store.listGroups({ workspaceId, agentId: this.agentId });
      emitToolDone(true);
      return { ok: true, groups };
    }

    if (name === "list_group_members") {
      const args = safeJsonParse<{ groupId?: string }>(input.call.argumentsText, {});
      const groupId = (args.groupId ?? "").trim();
      if (!groupId) {
        emitToolDone(false);
        return { ok: false, error: "Missing groupId" };
      }
      const members = await store.listGroupMemberIds({ groupId });
      if (!members.includes(this.agentId)) {
        emitToolDone(false);
        return { ok: false, error: "Access denied" };
      }
      emitToolDone(true);
      return { ok: true, members };
    }

    if (name === "create_group") {
      if (inRunningRootTask) {
        emitToolDone(false);
        return {
          ok: false,
          error:
            "Tool 'create_group' is disabled during an active task run. Continue coordination in the current task group.",
        };
      }
      const args = safeJsonParse<{ memberIds?: string[]; name?: string }>(input.call.argumentsText, {});
      const memberIds = [...new Set((args.memberIds ?? []).map((id) => id.trim()).filter((id) => isUuid(id)))];
      if (memberIds.length < 2) {
        emitToolDone(false);
        return { ok: false, error: "memberIds must have >= 2 valid UUID members" };
      }
      if (!memberIds.includes(this.agentId)) {
        memberIds.push(this.agentId);
      }
      let groupId = "";
      let groupName: string | null = args.name ?? null;
      if (memberIds.length === 2) {
        const existing = await store.findLatestExactP2PGroupId({
          workspaceId,
          memberA: memberIds[0]!,
          memberB: memberIds[1]!,
          preferredName: args.name ?? null,
        });
        groupId =
          (await store.mergeDuplicateExactP2PGroups({
            workspaceId,
            memberA: memberIds[0]!,
            memberB: memberIds[1]!,
            preferredName: args.name ?? null,
          })) ??
          (
            await store.createGroup({
              workspaceId,
              memberIds,
              name: args.name ?? undefined,
            })
          ).id;
        if (!existing) {
          getWorkspaceUIBus().emit(workspaceId, {
            event: "ui.group.created",
            data: { workspaceId, group: { id: groupId, name: groupName, memberIds } },
          });
        }
      } else {
        const created = await store.createGroup({ workspaceId, memberIds, name: args.name ?? undefined });
        groupId = created.id;
        groupName = created.name;
        getWorkspaceUIBus().emit(workspaceId, {
          event: "ui.group.created",
          data: { workspaceId, group: { id: groupId, name: groupName, memberIds } },
        });
      }
      emitToolDone(true);
      return { ok: true, groupId, name: groupName };
    }

    if (name === "send_group_message") {
      const args = safeJsonParse<{ groupId?: string; content?: string; contentType?: string }>(
        input.call.argumentsText,
        {}
      );
      const groupId = (args.groupId ?? "").trim();
      const content = (args.content ?? "").trim();
      if (!groupId) {
        emitToolDone(false);
        return { ok: false, error: "Missing groupId" };
      }
      if (inRunningRootTask && groupId !== input.groupId) {
        emitToolDone(false);
        return {
          ok: false,
          error:
            "Cross-group messaging is disabled during an active task run. Send to the current task group only.",
        };
      }
      if (!content) {
        emitToolDone(false);
        return { ok: false, error: "Missing content" };
      }

      const members = await store.listGroupMemberIds({ groupId });
      if (!members.includes(this.agentId)) {
        emitToolDone(false);
        return { ok: false, error: "Access denied" };
      }

      const result = await store.sendMessage({
        groupId,
        senderId: this.agentId,
        content,
        contentType: args.contentType ?? "text",
      });

      getWorkspaceUIBus().emit(workspaceId, {
        event: "ui.message.created",
        data: {
          workspaceId,
          groupId,
          memberIds: members,
          message: {
            id: result.id,
            senderId: this.agentId,
            sendTime: result.sendTime,
            content,
            contentType: args.contentType ?? "text",
          },
        },
      });
      this.noteTaskMessage({
        workspaceId,
        groupId,
        senderId: this.agentId,
        content,
        contentType: args.contentType ?? "text",
      });

      for (const memberId of members) {
        if (memberId === this.agentId) continue;
        const role = await store.getAgentRole({ agentId: memberId }).catch(() => null);
        if (role === "human" || role === null) continue;
        this.ensureRunner(memberId);
        this.wakeAgent(memberId);
      }

      emitToolDone(true);
      return { ok: true, ...result };
    }

    if (name === "send_direct_message") {
      if (inRunningRootTask) {
        emitToolDone(false);
        return {
          ok: false,
          error:
            "Tool 'send_direct_message' is disabled during an active task run. Use send_group_message in the current task group.",
        };
      }
      const args = safeJsonParse<{ toAgentId?: string; content?: string; contentType?: string }>(
        input.call.argumentsText,
        {}
      );
      const toAgentId = (args.toAgentId ?? "").trim();
      const content = (args.content ?? "").trim();
      if (!toAgentId) {
        emitToolDone(false);
        return { ok: false, error: "Missing toAgentId" };
      }
      if (!content) {
        emitToolDone(false);
        return { ok: false, error: "Missing content" };
      }

      const delivered = await store.sendDirectMessage({
        workspaceId,
        fromId: this.agentId,
        toId: toAgentId,
        content,
        contentType: args.contentType ?? "text",
        groupName: null,
      });
      const groupId = delivered.groupId;
      const channel = delivered.channel;
      const directMembers = await store.listGroupMemberIds({ groupId });
      getWorkspaceUIBus().emit(workspaceId, {
        event: "ui.message.created",
        data: {
          workspaceId,
          groupId,
          memberIds: directMembers,
          message: {
            id: delivered.messageId,
            senderId: this.agentId,
            sendTime: delivered.sendTime,
            content,
            contentType: args.contentType ?? "text",
          },
        },
      });
      this.noteTaskMessage({
        workspaceId,
        groupId,
        senderId: this.agentId,
        content,
        contentType: args.contentType ?? "text",
      });

      this.ensureRunner(toAgentId);
      this.wakeAgent(toAgentId);

      emitToolDone(true);
      return {
        ok: true,
        channel,
        groupId,
        messageId: delivered.messageId,
        sendTime: delivered.sendTime,
      };
    }

    if (name === "get_group_messages") {
      const args = safeJsonParse<{ groupId?: string }>(input.call.argumentsText, {});
      const groupId = (args.groupId ?? "").trim();
      if (!groupId) {
        emitToolDone(false);
        return { ok: false, error: "Missing groupId" };
      }
      const members = await store.listGroupMemberIds({ groupId });
      if (!members.includes(this.agentId)) {
        emitToolDone(false);
        return { ok: false, error: "Access denied" };
      }
      const messages = await store.listMessages({ groupId });
      emitToolDone(true);
      return { ok: true, messages };
    }

    const mcp = await getMcpRegistry(BUILTIN_TOOL_NAMES);
    if (mcp.hasTool(name)) {
      const args = safeJsonParse<Record<string, unknown>>(input.call.argumentsText, {});
      const result = await mcp.callTool(name, args);
      emitToolDone(result.ok);
      return result;
    }

    emitToolDone(false);
    return { ok: false, error: `Unknown tool: ${name}` };
  }

  private async callLlmStreaming(
    history: HistoryMessage[],
    ctx: { workspaceId: UUID; groupId: UUID; round: number }
  ) {
    const llm = await resolveAgentLlmConfig(this.agentId);
    if (llm.provider === "glm") {
      return this.callGlmStreaming(history, ctx, llm);
    }
    return this.callOpenRouterStreaming(history, ctx, llm);
  }

  private async callOpenRouterStreaming(
    history: HistoryMessage[],
    ctx: { workspaceId: UUID; groupId: UUID; round: number },
    llm: ResolvedLlmConfig
  ) {
    getWorkspaceUIBus().emit(ctx.workspaceId, {
      event: "ui.agent.llm.start",
      data: {
        workspaceId: ctx.workspaceId,
        agentId: this.agentId,
        groupId: ctx.groupId,
        round: ctx.round,
        provider: llm.provider,
        model: llm.model,
      },
    });
    void appendAgentStreamEvent({
      agentId: this.agentId,
      round: ctx.round,
      kind: "start",
    });

    const tools = await getAgentTools();
    const payload: Record<string, unknown> = {
      // Preserve reasoning for OpenRouter using the canonical "reasoning" field.
      messages: mapOpenRouterMessages(history),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (llm.model) payload.model = llm.model;
    if (tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
      ...(llm.headers ?? {}),
    };

    const requestBody = JSON.stringify(payload);
    void appendAgentLlmRequestRaw({ agentId: this.agentId, body: requestBody });

    const upstream = await fetch(llm.baseUrl, {
      method: "POST",
      headers,
      body: requestBody,
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      throw new Error(formatUpstreamError(llm.provider, upstream.status, text));
    }

    const assembler = new OpenAIStreamAssembler();
    let prev = assembler.snapshot();
    let assistantText = "";
    let assistantThinking = "";

    for await (const evt of parseSSEJsonLines(upstream.body)) {
      const state = assembler.push(evt as any);

      const reasoningDelta = state.reasoningContent.slice(prev.reasoningContent.length);
      const contentDelta = state.content.slice(prev.content.length);
      const toolCallDeltas = extractToolCallDeltas(evt as any, prev, state);

      if (reasoningDelta) {
        assistantThinking += reasoningDelta;
        this.bus.emit(this.agentId, {
          event: "agent.stream",
          data: { kind: "reasoning", delta: reasoningDelta },
        });
        void appendAgentStreamEvent({
          agentId: this.agentId,
          round: ctx.round,
          kind: "reasoning",
          delta: reasoningDelta,
        });
      }

      if (contentDelta) {
        assistantText += contentDelta;
        this.bus.emit(this.agentId, {
          event: "agent.stream",
          data: { kind: "content", delta: contentDelta },
        });
        void appendAgentStreamEvent({
          agentId: this.agentId,
          round: ctx.round,
          kind: "content",
          delta: contentDelta,
        });
      }

      for (const delta of toolCallDeltas) {
        this.bus.emit(this.agentId, {
          event: "agent.stream",
          data: {
            kind: "tool_calls",
            delta: delta.delta,
            tool_call_id: delta.tool_call_id,
            tool_call_name: delta.tool_call_name,
          },
        });
        void appendAgentStreamEvent({
          agentId: this.agentId,
          round: ctx.round,
          kind: "tool_calls",
          delta: delta.delta,
          tool_call_id: delta.tool_call_id,
          tool_call_name: delta.tool_call_name,
        });
      }

      prev = state;
    }

    this.bus.emit(this.agentId, {
      event: "agent.done",
      data: { finishReason: prev.finishReason ?? undefined },
    });
    void appendAgentStreamEvent({
      agentId: this.agentId,
      round: ctx.round,
      kind: "done",
      finishReason: prev.finishReason ?? null,
    });
    getWorkspaceUIBus().emit(ctx.workspaceId, {
      event: "ui.agent.llm.done",
      data: {
        workspaceId: ctx.workspaceId,
        agentId: this.agentId,
        groupId: ctx.groupId,
        round: ctx.round,
        finishReason: prev.finishReason ?? undefined,
        provider: llm.provider,
        model: llm.model,
      },
    });
    this.noteTaskTurn({
      workspaceId: ctx.workspaceId,
      groupId: ctx.groupId,
      agentId: this.agentId,
      finishReason: prev.finishReason ?? null,
    });

    const finalState = assembler.snapshot();

    if (finalState.usage && finalState.usage.totalTokens > 0) {
      try {
        await store.setGroupContextTokens({
          groupId: ctx.groupId,
          tokens: finalState.usage.totalTokens,
        });
      } catch {
        // Best effort - don't fail if token tracking fails
      }
    }

    return {
      assistantText,
      assistantThinking,
      toolCalls: (finalState.toolCalls ?? []) as ToolCall[],
      finishReason: finalState.finishReason,
    };
  }

  private async callGlmStreaming(
    history: HistoryMessage[],
    ctx: { workspaceId: UUID; groupId: UUID; round: number },
    llm: ResolvedLlmConfig
  ) {
    getWorkspaceUIBus().emit(ctx.workspaceId, {
      event: "ui.agent.llm.start",
      data: {
        workspaceId: ctx.workspaceId,
        agentId: this.agentId,
        groupId: ctx.groupId,
        round: ctx.round,
        provider: llm.provider,
        model: llm.model,
      },
    });
    void appendAgentStreamEvent({
      agentId: this.agentId,
      round: ctx.round,
      kind: "start",
    });

    const glmPayload: Record<string, unknown> = {
      model: llm.model,
      messages: history,
      tools: await getAgentTools(),
      tool_choice: "auto",
      stream: true,
      tool_stream: true,
    };
    const requestBody = JSON.stringify(glmPayload);
    void appendAgentLlmRequestRaw({ agentId: this.agentId, body: requestBody });

    const upstream = await fetch(llm.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        "Content-Type": "application/json",
        ...(llm.headers ?? {}),
      },
      body: requestBody,
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      throw new Error(formatUpstreamError("GLM", upstream.status, text));
    }

    const assembler = new GLMStreamAssembler();
    let prev = assembler.snapshot();
    let assistantText = "";
    let assistantThinking = "";

    for await (const evt of parseSSEJsonLines(upstream.body)) {
      const state = assembler.push(evt as any);

      const reasoningDelta = state.reasoningContent.slice(prev.reasoningContent.length);
      const contentDelta = state.content.slice(prev.content.length);
      const toolCallDeltas = extractToolCallDeltas(evt as any, prev, state);

      if (reasoningDelta) {
        assistantThinking += reasoningDelta;
        this.bus.emit(this.agentId, {
          event: "agent.stream",
          data: { kind: "reasoning", delta: reasoningDelta },
        });
        void appendAgentStreamEvent({
          agentId: this.agentId,
          round: ctx.round,
          kind: "reasoning",
          delta: reasoningDelta,
        });
      }

      if (contentDelta) {
        assistantText += contentDelta;
        this.bus.emit(this.agentId, {
          event: "agent.stream",
          data: { kind: "content", delta: contentDelta },
        });
        void appendAgentStreamEvent({
          agentId: this.agentId,
          round: ctx.round,
          kind: "content",
          delta: contentDelta,
        });
      }

      for (const delta of toolCallDeltas) {
        this.bus.emit(this.agentId, {
          event: "agent.stream",
          data: {
            kind: "tool_calls",
            delta: delta.delta,
            tool_call_id: delta.tool_call_id,
            tool_call_name: delta.tool_call_name,
          },
        });
        void appendAgentStreamEvent({
          agentId: this.agentId,
          round: ctx.round,
          kind: "tool_calls",
          delta: delta.delta,
          tool_call_id: delta.tool_call_id,
          tool_call_name: delta.tool_call_name,
        });
      }

      prev = state;
    }

    this.bus.emit(this.agentId, {
      event: "agent.done",
      data: { finishReason: prev.finishReason ?? undefined },
    });
    void appendAgentStreamEvent({
      agentId: this.agentId,
      round: ctx.round,
      kind: "done",
      finishReason: prev.finishReason ?? null,
    });
    getWorkspaceUIBus().emit(ctx.workspaceId, {
      event: "ui.agent.llm.done",
      data: {
        workspaceId: ctx.workspaceId,
        agentId: this.agentId,
        groupId: ctx.groupId,
        round: ctx.round,
        finishReason: prev.finishReason ?? undefined,
        provider: llm.provider,
        model: llm.model,
      },
    });
    this.noteTaskTurn({
      workspaceId: ctx.workspaceId,
      groupId: ctx.groupId,
      agentId: this.agentId,
      finishReason: prev.finishReason ?? null,
    });

    const finalState = assembler.snapshot();

    // Save token usage (current context window size)
    if (finalState.usage && finalState.usage.totalTokens > 0) {
      try {
        await store.setGroupContextTokens({
          groupId: ctx.groupId,
          tokens: finalState.usage.totalTokens,
        });
      } catch {
        // Best effort - don't fail if token tracking fails
      }
    }

    return {
      assistantText,
      assistantThinking,
      toolCalls: (finalState.toolCalls ?? []) as ToolCall[],
      finishReason: finalState.finishReason,
    };
  }
}

function extractToolCallDeltas(
  chunk: {
    choices?: Array<{
      delta?: {
        tool_calls?: Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  },
  prevState: { toolCalls: Array<{ index: number; id?: string; name?: string; argumentsText: string }> },
  nextState: { toolCalls: Array<{ index: number; id?: string; name?: string; argumentsText: string }> }
): Array<{ delta: string; tool_call_id?: string; tool_call_name?: string }> {
  const deltas: Array<{ delta: string; tool_call_id?: string; tool_call_name?: string }> = [];
  const toolCalls = chunk.choices?.[0]?.delta?.tool_calls ?? [];
  if (toolCalls.length === 0) return deltas;

  const prevByIndex = new Map(prevState.toolCalls.map((call) => [call.index, call]));
  const nextByIndex = new Map(nextState.toolCalls.map((call) => [call.index, call]));

  for (const call of toolCalls) {
    const index = call.index ?? 0;
    const prev = prevByIndex.get(index);
    const next = nextByIndex.get(index);
    const name = call.function?.name ?? next?.name;
    const id = call.id ?? next?.id;
    const argsChunk = call.function?.arguments ?? "";

    if (argsChunk) {
      deltas.push({ delta: argsChunk, tool_call_id: id, tool_call_name: name });
      continue;
    }

    if (name && name !== prev?.name) {
      deltas.push({ delta: "", tool_call_id: id, tool_call_name: name });
    }
  }

  return deltas;
}

export class AgentRuntime {
  private readonly runners = new Map<UUID, AgentRunner>();
  private readonly taskRuns = new Map<UUID, TaskRun>();
  public readonly bus = new AgentEventBus();
  private bootstrapped = false;
  static readonly VERSION = 3;
  private static readonly DEFAULT_TASK_DURATION_MS = 5 * 60 * 1000;
  private static readonly DEFAULT_TASK_MAX_TURNS = 40;
  private static readonly DEFAULT_TASK_MAX_TOKEN_DELTA = 20_000;
  private static readonly NO_PROGRESS_WINDOW_MS = 90 * 1000;
  private static readonly TASK_TICK_MS = 10 * 1000;

  private normalizeForSimilarity(input: string) {
    return (input || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private calcSimilarity(a: string, b: string) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const as = new Set(this.normalizeForSimilarity(a).split(" ").filter(Boolean));
    const bs = new Set(this.normalizeForSimilarity(b).split(" ").filter(Boolean));
    if (as.size === 0 || bs.size === 0) return 0;
    let inter = 0;
    for (const t of as) if (bs.has(t)) inter++;
    return inter / Math.max(as.size, bs.size);
  }

  private toBudgetJson(task: TaskRun) {
    return JSON.stringify({
      maxDurationMs: task.maxDurationMs,
      maxTurns: task.maxTurns,
      maxTokenDelta: task.maxTokenDelta,
      startGroupTokens: task.startGroupTokens,
    });
  }

  private toMetricsJson(task: TaskRun) {
    return JSON.stringify({
      totalTurns: task.totalTurns,
      totalMessages: task.totalMessages,
      repeatedRatio: task.repeatedRatio,
      lastMessageAt: task.lastMessageAt,
      participants: [...task.participants],
    });
  }

  private emitTaskProgress(task: TaskRun) {
    const nowMs = Date.now();
    const remainingMs = Math.max(0, task.deadlineAt - nowMs);
    const idleMs = Math.max(0, nowMs - task.lastMessageAt);
    getWorkspaceUIBus().emit(task.workspaceId, {
      event: "ui.task.progress",
      data: {
        workspaceId: task.workspaceId,
        taskId: task.id,
        totalTurns: task.totalTurns,
        totalMessages: task.totalMessages,
        repeatedRatio: Number(task.repeatedRatio.toFixed(3)),
        idleMs,
        remainingMs,
      },
    });
  }

  private async calcRepeatedRatio(groupId: UUID) {
    const rows = await store.listMessages({ groupId }).catch(() => []);
    const recent = rows.slice(-8).map((m) => String(m.content ?? "").trim()).filter(Boolean);
    if (recent.length < 2) return 0;
    let pairs = 0;
    let high = 0;
    for (let i = 1; i < recent.length; i++) {
      pairs++;
      if (this.calcSimilarity(recent[i - 1]!, recent[i]!) >= 0.9) high++;
    }
    return pairs === 0 ? 0 : high / pairs;
  }

  private clampScore(n: number) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  private parseReviewJson(raw: string): TaskQualityReview | null {
    const text = String(raw ?? "").trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1] ?? text;
    const parsed = safeJsonParse<any>(candidate, null);
    if (!parsed || typeof parsed !== "object") return null;
    const score = parsed.score ?? {};
    const review: TaskQualityReview = {
      score: {
        completion: this.clampScore(Number(score.completion ?? 0)),
        relevance: this.clampScore(Number(score.relevance ?? 0)),
        clarity: this.clampScore(Number(score.clarity ?? 0)),
        nonRedundancy: this.clampScore(Number(score.nonRedundancy ?? 0)),
        safety: this.clampScore(Number(score.safety ?? 0)),
        overall: this.clampScore(Number(score.overall ?? 0)),
      },
      verdict:
        parsed.verdict === "pass" || parsed.verdict === "borderline" || parsed.verdict === "fail"
          ? parsed.verdict
          : "borderline",
      highlights: Array.isArray(parsed.highlights)
        ? parsed.highlights.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 6)
        : [],
      issues: Array.isArray(parsed.issues)
        ? parsed.issues
            .map((x: any) => ({
              severity:
                x?.severity === "high" || x?.severity === "medium" || x?.severity === "low"
                  ? x.severity
                  : "medium",
              detail: String(x?.detail ?? "").trim(),
            }))
            .filter((x: { detail: string }) => !!x.detail)
            .slice(0, 8)
        : [],
      nextActions: Array.isArray(parsed.nextActions)
        ? parsed.nextActions.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 8)
        : [],
    };
    if (review.score.overall === 0) {
      review.score.overall = this.clampScore(
        (review.score.completion +
          review.score.relevance +
          review.score.clarity +
          review.score.nonRedundancy +
          review.score.safety) /
          5
      );
    }
    return review;
  }

  private fallbackReview(task: TaskRun, reason: TaskStopReason): { review: TaskQualityReview; narrative: string } {
    const repeatPenalty = Math.round(task.repeatedRatio * 45);
    const completionBase = reason === "goal_reached" ? 82 : reason === "manual" ? 68 : 60;
    const completion = this.clampScore(completionBase - repeatPenalty);
    const relevance = this.clampScore(70 - repeatPenalty);
    const clarity = this.clampScore(72 - Math.round(task.repeatedRatio * 35));
    const nonRedundancy = this.clampScore(78 - Math.round(task.repeatedRatio * 65));
    const safety = 85;
    const overall = this.clampScore((completion + relevance + clarity + nonRedundancy + safety) / 5);
    const verdict: TaskQualityReview["verdict"] = overall >= 75 ? "pass" : overall >= 55 ? "borderline" : "fail";
    return {
      review: {
        score: { completion, relevance, clarity, nonRedundancy, safety, overall },
        verdict,
        highlights: ["Task stopped with summary generated.", `Stop reason: ${reason}.`],
        issues: task.repeatedRatio > 0.4 ? [{ severity: "medium", detail: "Output repetition ratio is high." }] : [],
        nextActions: ["Refine task goal with clearer constraints.", "Reduce repetition by adding concrete checkpoints."],
      },
      narrative: "Fallback heuristic review generated because model review was unavailable.",
    };
  }

  private async generateTaskReview(
    task: TaskRun,
    reason: TaskStopReason,
    groupMessages: Array<{ senderId: string; content: string }>
  ): Promise<{ review: TaskQualityReview; narrative: string }> {
    const recent = groupMessages.slice(-30);
    const logs = recent
      .map((m) => `- ${m.senderId.slice(0, 8)}: ${String(m.content ?? "").replace(/\s+/g, " ").slice(0, 180)}`)
      .join("\n");
    const systemPrompt =
      "You are a strict task quality evaluator. Return only valid JSON without markdown fences.";
    const userPrompt =
      `Evaluate this multi-agent task.\n` +
      `Goal: ${task.goal}\n` +
      `Stop reason: ${reason}\n` +
      `DurationSec: ${Math.round((Date.now() - task.startAt) / 1000)}\n` +
      `Turns: ${task.totalTurns}\n` +
      `Messages: ${task.totalMessages}\n` +
      `RepeatRatio: ${Number(task.repeatedRatio.toFixed(3))}\n` +
      `RecentLogs:\n${logs || "- (no logs)"}\n\n` +
      `Output JSON schema:\n` +
      `{"score":{"completion":0-100,"relevance":0-100,"clarity":0-100,"nonRedundancy":0-100,"safety":0-100,"overall":0-100},"verdict":"pass|borderline|fail","highlights":["..."],"issues":[{"severity":"high|medium|low","detail":"..."}],"nextActions":["..."],"narrative":"..."}`;

    try {
      const raw = await chatJsonByAgent({
        agentId: task.ownerAgentId,
        systemPrompt,
        userPrompt,
        decode: { temperature: 0.2, topP: 0.9, maxTokens: 700 },
      });
      const review = this.parseReviewJson(raw);
      if (!review) return this.fallbackReview(task, reason);
      const parsed = safeJsonParse<any>(raw, {});
      const narrative = String(parsed?.narrative ?? "").trim() || "Model-generated quality review.";
      return { review, narrative };
    } catch {
      return this.fallbackReview(task, reason);
    }
  }

  private async tryStopTask(task: TaskRun, reason: TaskStopReason) {
    if (task.status !== "running") return;
    task.status = "stopping";
    task.stopReason = reason;
    task.stoppedAt = Date.now();
    await store
      .updateTaskRun({
        taskId: task.id,
        workspaceId: task.workspaceId,
        status: "stopping",
        stopReason: reason,
        metricsJson: this.toMetricsJson(task),
      })
      .catch(() => undefined);
    if (task.timer) {
      clearInterval(task.timer);
      task.timer = null;
    }

    getWorkspaceUIBus().emit(task.workspaceId, {
      event: "ui.task.stopping",
      data: { workspaceId: task.workspaceId, taskId: task.id, reason },
    } as any);

    const participantIds = [...task.participants];
    for (const id of participantIds) {
      this.ensureRunner(id).requestInterrupt();
    }
    for (const id of participantIds) {
      const agent = await store.getAgent({ agentId: id }).catch(() => null);
      if (!agent || agent.role === "human") continue;
      if (id === task.ownerAgentId) continue;
      await store.setAgentAutoRun({ agentId: id, autoRunEnabled: false }).catch(() => undefined);
    }
    // Hard stop all non-human agents in workspace to prevent tail chatter across groups.
    const pausedAll = await store
      .bulkPauseAgents({
        workspaceId: task.workspaceId,
        excludeKinds: ["system_human"],
      })
      .catch(() => ({ agentIds: [] as UUID[], paused: 0 }));
    for (const id of pausedAll.agentIds) {
      this.ensureRunner(id).requestInterrupt();
    }

    const stoppedAtIso = new Date(task.stoppedAt).toISOString();
    getWorkspaceUIBus().emit(task.workspaceId, {
      event: "ui.task.stopped",
      data: {
        workspaceId: task.workspaceId,
        taskId: task.id,
        reason,
        stoppedAt: stoppedAtIso,
      },
    });

    const groupMessages = await store.listMessages({ groupId: task.rootGroupId }).catch(() => []);
    const recent = groupMessages.slice(-20);
    const summaryLines = recent.map((m) => {
      const text = String(m.content ?? "").replace(/\s+/g, " ").trim();
      return `- ${m.senderId.slice(0, 8)}: ${text.slice(0, 120)}`;
    });
    const summary =
      `## Task Summary\n` +
      `- Goal: ${task.goal}\n` +
      `- Stop reason: ${reason}\n` +
      `- Duration: ${Math.round((task.stoppedAt - task.startAt) / 1000)}s\n` +
      `- Turns: ${task.totalTurns}\n` +
      `- Messages: ${task.totalMessages}\n` +
      `- Repeat ratio: ${Number(task.repeatedRatio.toFixed(2))}\n\n` +
      `### Recent key logs\n` +
      `${summaryLines.length > 0 ? summaryLines.join("\n") : "- (no recent logs)"}`;

    const sent = await store
      .sendMessage({
        groupId: task.rootGroupId,
        senderId: task.ownerAgentId,
        contentType: "text",
        content: summary,
      })
      .catch(() => null);

    if (sent) {
      const memberIds = await store.listGroupMemberIds({ groupId: task.rootGroupId }).catch(() => []);
      getWorkspaceUIBus().emit(task.workspaceId, {
        event: "ui.message.created",
        data: {
          workspaceId: task.workspaceId,
          groupId: task.rootGroupId,
          memberIds,
          message: {
            id: sent.id,
            senderId: task.ownerAgentId,
            sendTime: sent.sendTime,
            content: summary,
            contentType: "text",
          },
        },
      });
      getWorkspaceUIBus().emit(task.workspaceId, {
        event: "ui.task.summary.created",
        data: { workspaceId: task.workspaceId, taskId: task.id, summaryMessageId: sent.id },
      } as any);
    }

    const reviewGenerated = await this.generateTaskReview(task, reason, groupMessages).catch(() => null);
    let reviewMessageId: string | undefined;
    if (reviewGenerated) {
      await store
        .createTaskReview({
          taskId: task.id,
          workspaceId: task.workspaceId,
          reviewJson: JSON.stringify(reviewGenerated.review),
          narrativeText: reviewGenerated.narrative,
        })
        .catch(() => undefined);

      const reviewText =
        `## Quality Review\n` +
        `- Verdict: ${reviewGenerated.review.verdict}\n` +
        `- Overall: ${reviewGenerated.review.score.overall}\n` +
        `- Completion: ${reviewGenerated.review.score.completion}\n` +
        `- Relevance: ${reviewGenerated.review.score.relevance}\n` +
        `- Clarity: ${reviewGenerated.review.score.clarity}\n` +
        `- Non-Redundancy: ${reviewGenerated.review.score.nonRedundancy}\n` +
        `- Safety: ${reviewGenerated.review.score.safety}\n\n` +
        `### Highlights\n` +
        `${reviewGenerated.review.highlights.map((x) => `- ${x}`).join("\n") || "- (none)"}\n\n` +
        `### Issues\n` +
        `${
          reviewGenerated.review.issues.map((x) => `- [${x.severity}] ${x.detail}`).join("\n") || "- (none)"
        }\n\n` +
        `### Next Actions\n` +
        `${reviewGenerated.review.nextActions.map((x) => `- ${x}`).join("\n") || "- (none)"}\n\n` +
        `Narrative: ${reviewGenerated.narrative}`;

      const reviewSent = await store
        .sendMessage({
          groupId: task.rootGroupId,
          senderId: task.ownerAgentId,
          contentType: "text",
          content: reviewText,
        })
        .catch(() => null);
      if (reviewSent) {
        reviewMessageId = reviewSent.id;
        const memberIds = await store.listGroupMemberIds({ groupId: task.rootGroupId }).catch(() => []);
        getWorkspaceUIBus().emit(task.workspaceId, {
          event: "ui.message.created",
          data: {
            workspaceId: task.workspaceId,
            groupId: task.rootGroupId,
            memberIds,
            message: {
              id: reviewSent.id,
              senderId: task.ownerAgentId,
              sendTime: reviewSent.sendTime,
              content: reviewText,
              contentType: "text",
            },
          },
        });
      }
      getWorkspaceUIBus().emit(task.workspaceId, {
        event: "ui.task.review.created",
        data: {
          workspaceId: task.workspaceId,
          taskId: task.id,
          reviewMessageId,
        },
      } as any);
    }

    task.status = "stopped";
    await store
      .updateTaskRun({
        taskId: task.id,
        workspaceId: task.workspaceId,
        status: "stopped",
        stopReason: reason,
        metricsJson: this.toMetricsJson(task),
        summaryMessageId: sent?.id ?? null,
        stoppedAt: task.stoppedAt ? new Date(task.stoppedAt) : new Date(),
      })
      .catch(() => undefined);
    this.taskRuns.delete(task.workspaceId);
  }

  private async evaluateTask(task: TaskRun) {
    if (task.status !== "running") return;
    task.repeatedRatio = await this.calcRepeatedRatio(task.rootGroupId);
    this.emitTaskProgress(task);

    const nowMs = Date.now();
    if (nowMs >= task.deadlineAt) {
      await this.tryStopTask(task, "timeout");
      return;
    }
    if (task.totalTurns >= task.maxTurns) {
      await this.tryStopTask(task, "max_turns");
      return;
    }
    const idleMs = nowMs - task.lastMessageAt;
    if (idleMs >= AgentRuntime.NO_PROGRESS_WINDOW_MS) {
      await this.tryStopTask(task, "no_progress");
      return;
    }
    if (task.repeatedRatio >= 0.6) {
      await this.tryStopTask(task, "repeated_output");
      return;
    }

    const currentGroup = (await store.listGroups({ workspaceId: task.workspaceId })).find(
      (g) => g.id === task.rootGroupId
    );
    const tokenDelta = (currentGroup?.contextTokens ?? task.startGroupTokens) - task.startGroupTokens;
    if (tokenDelta >= task.maxTokenDelta) {
      await this.tryStopTask(task, "token_delta_exceeded" as TaskStopReason);
      return;
    }

    await store
      .updateTaskRun({
        taskId: task.id,
        workspaceId: task.workspaceId,
        status: "running",
        metricsJson: this.toMetricsJson(task),
      })
      .catch(() => undefined);
  }

  async bootstrap() {
    if (this.bootstrapped) return;
    this.bootstrapped = true;

    const agents = await store.listAgents();
    for (const a of agents) {
      if (a.role === "human" || !a.autoRunEnabled) continue;
      this.ensureRunner(a.id);
    }

    const runningTasks = await store.listRunningTaskRuns().catch(() => []);
    for (const row of runningTasks) {
      const budget = safeJsonParse<{
        maxDurationMs?: number;
        maxTurns?: number;
        maxTokenDelta?: number;
        startGroupTokens?: number;
      }>(row.budgetJson, {});
      const metrics = safeJsonParse<{
        totalTurns?: number;
        totalMessages?: number;
        repeatedRatio?: number;
        lastMessageAt?: number;
        participants?: string[];
      }>(row.metricsJson, {});
      const task: TaskRun = {
        id: row.id,
        workspaceId: row.workspaceId,
        rootGroupId: row.rootGroupId,
        ownerAgentId: row.ownerAgentId,
        goal: row.goal,
        status: "running",
        startAt: new Date(row.startAt).getTime(),
        deadlineAt: new Date(row.deadlineAt).getTime(),
        maxDurationMs: budget.maxDurationMs ?? AgentRuntime.DEFAULT_TASK_DURATION_MS,
        maxTurns: budget.maxTurns ?? AgentRuntime.DEFAULT_TASK_MAX_TURNS,
        maxTokenDelta: budget.maxTokenDelta ?? AgentRuntime.DEFAULT_TASK_MAX_TOKEN_DELTA,
        totalTurns: metrics.totalTurns ?? 0,
        totalMessages: metrics.totalMessages ?? 0,
        startGroupTokens: budget.startGroupTokens ?? 0,
        lastMessageAt: metrics.lastMessageAt ?? Date.now(),
        repeatedRatio: metrics.repeatedRatio ?? 0,
        participants: new Set((metrics.participants ?? []) as UUID[]),
        timer: null,
      };
      if (!task.participants.has(task.ownerAgentId)) task.participants.add(task.ownerAgentId);
      task.timer = setInterval(() => {
        void this.evaluateTask(task);
      }, AgentRuntime.TASK_TICK_MS);
      this.taskRuns.set(task.workspaceId, task);
    }
  }

  async getActiveTaskRun(workspaceId: UUID) {
    const task = this.taskRuns.get(workspaceId);
    if (task) {
      return {
        taskId: task.id,
        workspaceId: task.workspaceId,
        rootGroupId: task.rootGroupId,
        ownerAgentId: task.ownerAgentId,
        goal: task.goal,
        status: task.status,
        startAt: new Date(task.startAt).toISOString(),
        deadlineAt: new Date(task.deadlineAt).toISOString(),
        stopReason: task.stopReason ?? null,
        totalTurns: task.totalTurns,
        totalMessages: task.totalMessages,
        repeatedRatio: task.repeatedRatio,
        remainingMs: Math.max(0, task.deadlineAt - Date.now()),
      };
    }
    const latest = await store.getLatestTaskRun({ workspaceId }).catch(() => null);
    if (!latest) return null;
    const metrics = safeJsonParse<{
      totalTurns?: number;
      totalMessages?: number;
      repeatedRatio?: number;
    }>(latest.metricsJson, {});
    return {
      taskId: latest.id,
      workspaceId: latest.workspaceId,
      rootGroupId: latest.rootGroupId,
      ownerAgentId: latest.ownerAgentId,
      goal: latest.goal,
      status: latest.status,
      startAt: latest.startAt,
      deadlineAt: latest.deadlineAt,
      stopReason: latest.stopReason ?? null,
      totalTurns: metrics.totalTurns ?? 0,
      totalMessages: metrics.totalMessages ?? 0,
      repeatedRatio: metrics.repeatedRatio ?? 0,
      remainingMs: Math.max(0, new Date(latest.deadlineAt).getTime() - Date.now()),
    };
  }

  async startTaskRun(input: {
    workspaceId: UUID;
    rootGroupId?: UUID;
    ownerAgentId: UUID;
    goal: string;
    maxDurationMs?: number;
    maxTurns?: number;
    maxTokenDelta?: number;
  }) {
    await this.bootstrap();
    const existing = this.taskRuns.get(input.workspaceId);
    if (existing && existing.status === "running") {
      await this.tryStopTask(existing, "manual_replaced" as TaskStopReason);
    }

    const startAt = Date.now();
    const maxDurationMs = Math.max(15_000, input.maxDurationMs ?? AgentRuntime.DEFAULT_TASK_DURATION_MS);
    const deadlineAt = startAt + maxDurationMs;
    const resolvedRootGroupId =
      input.rootGroupId ??
      (await store.ensureWorkspaceDefaults({ workspaceId: input.workspaceId })).defaultGroupId;
    const group = (await store.listGroups({ workspaceId: input.workspaceId })).find(
      (g) => g.id === resolvedRootGroupId
    );
    if (!group) throw new Error("group not found");
    // Isolate a task run: pause all non-human agents first, then enable only root-group members.
    await store
      .bulkPauseAgents({
        workspaceId: input.workspaceId,
        excludeKinds: ["system_human"],
      })
      .catch(() => undefined);
    const rootMemberIds = await store.listGroupMemberIds({ groupId: resolvedRootGroupId }).catch(() => []);
    const enableIds = [...new Set([input.ownerAgentId, ...rootMemberIds])];
    for (const agentId of enableIds) {
      const agent = await store.getAgent({ agentId }).catch(() => null);
      if (!agent || agent.role === "human") continue;
      await store.setAgentAutoRun({ agentId, autoRunEnabled: true }).catch(() => undefined);
    }
    const startGroupTokens = group.contextTokens ?? 0;

    const task: TaskRun = {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      rootGroupId: resolvedRootGroupId,
      ownerAgentId: input.ownerAgentId,
      goal: input.goal.trim() || "Complete the assigned task",
      status: "running",
      startAt,
      deadlineAt,
      maxDurationMs,
      maxTurns: Math.max(1, input.maxTurns ?? AgentRuntime.DEFAULT_TASK_MAX_TURNS),
      maxTokenDelta: Math.max(1000, input.maxTokenDelta ?? AgentRuntime.DEFAULT_TASK_MAX_TOKEN_DELTA),
      totalTurns: 0,
      totalMessages: 0,
      startGroupTokens,
      lastMessageAt: startAt,
      repeatedRatio: 0,
      participants: new Set<UUID>([input.ownerAgentId]),
      timer: null,
    };

    task.timer = setInterval(() => {
      void this.evaluateTask(task);
    }, AgentRuntime.TASK_TICK_MS);

    this.taskRuns.set(input.workspaceId, task);
    const createdTask = await store
      .createTaskRun({
        workspaceId: task.workspaceId,
        rootGroupId: task.rootGroupId,
        ownerAgentId: task.ownerAgentId,
        goal: task.goal,
        status: "running",
        budgetJson: this.toBudgetJson(task),
        metricsJson: this.toMetricsJson(task),
        startAt: new Date(task.startAt),
        deadlineAt: new Date(task.deadlineAt),
      })
      .catch(() => null);
    if (createdTask?.id) {
      task.id = createdTask.id;
    }
    getWorkspaceUIBus().emit(input.workspaceId, {
      event: "ui.task.started",
      data: {
        workspaceId: input.workspaceId,
        taskId: task.id,
        rootGroupId: task.rootGroupId,
        ownerAgentId: task.ownerAgentId,
        goal: task.goal,
        startAt: new Date(task.startAt).toISOString(),
        deadlineAt: new Date(task.deadlineAt).toISOString(),
        effectiveGroupId: task.rootGroupId,
      },
    } as any);

    return await this.getActiveTaskRun(input.workspaceId);
  }

  async stopTaskRun(input: { workspaceId: UUID; reason?: TaskStopReason }) {
    let task = this.taskRuns.get(input.workspaceId);
    if (!task) {
      await this.bootstrap();
      task = this.taskRuns.get(input.workspaceId);
    }
    if (!task) {
      const latest = await store.getLatestTaskRun({ workspaceId: input.workspaceId }).catch(() => null);
      return latest
        ? {
            taskId: latest.id,
            workspaceId: latest.workspaceId,
            stopReason: latest.stopReason ?? "manual",
            stoppedAt: latest.stoppedAt ?? latest.updatedAt,
          }
        : null;
    }
    await this.tryStopTask(task, input.reason ?? "manual");
    return {
      taskId: task.id,
      workspaceId: task.workspaceId,
      stopReason: task.stopReason ?? "manual",
      stoppedAt: new Date(task.stoppedAt ?? Date.now()).toISOString(),
    };
  }

  private noteTaskTurn(input: {
    workspaceId: UUID;
    groupId: UUID;
    agentId: UUID;
    finishReason?: string | null;
  }) {
    const task = this.taskRuns.get(input.workspaceId);
    if (!task || task.status !== "running") return;
    if (input.groupId !== task.rootGroupId) return;
    task.totalTurns += 1;
    task.participants.add(input.agentId);
    void this.evaluateTask(task);
  }

  private noteTaskMessage(input: {
    workspaceId: UUID;
    groupId: UUID;
    senderId: UUID;
    content: string;
    contentType: string;
  }) {
    const task = this.taskRuns.get(input.workspaceId);
    if (!task || task.status !== "running") return;
    if (input.groupId !== task.rootGroupId) return;
    task.totalMessages += 1;
    task.lastMessageAt = Date.now();
    task.participants.add(input.senderId);

    const text = String(input.content ?? "").toLowerCase();
    if (
      text.includes("最终总结") ||
      text.includes("最终结果") ||
      text.includes("任务完成") ||
      text.includes("final summary") ||
      text.includes("辩论结束") ||
      text.includes("本场辩论圆满结束") ||
      text.includes("debate concluded") ||
      text.includes("debate finished")
    ) {
      void this.tryStopTask(task, "goal_reached");
      return;
    }
    void this.evaluateTask(task);
  }

  ensureRunner(agentId: UUID) {
    const existing = this.runners.get(agentId);
    if (existing) return existing;
    const runner = new AgentRunner(
      agentId,
      this.bus,
      (id) => {
        this.ensureRunner(id);
      },
      (id) => {
        this.ensureRunner(id).wakeup("manual");
      },
      (evt) => this.noteTaskTurn(evt),
      (evt) => this.noteTaskMessage(evt)
    );
    this.runners.set(agentId, runner);
    runner.start();
    return runner;
  }

  async wakeAgentsForGroup(
    groupId: UUID,
    senderId: UUID,
    message?: { content?: string; contentType?: string }
  ) {
    await this.bootstrap();
    const groupKind = await store.getGroupKind({ groupId });
    if (groupKind === "game_undercover" || groupKind === "game_werewolf") return;
    const workspaceId = await store.getGroupWorkspaceId({ groupId }).catch(() => null);
    if (workspaceId && message?.content) {
      this.noteTaskMessage({
        workspaceId,
        groupId,
        senderId,
        content: message.content,
        contentType: message.contentType ?? "text",
      });
    }
    const memberIds = await store.listGroupMemberIds({ groupId });

    for (const memberId of memberIds) {
      if (memberId === senderId) continue;
      const agent = await store.getAgent({ agentId: memberId }).catch(() => null);
      if (!agent || agent.role === "human" || !agent.autoRunEnabled) continue;
      this.ensureRunner(memberId).wakeup("group_message");
    }
  }

  async wakeAgent(agentId: UUID, reason: "direct_message" | "context_stream" = "direct_message") {
    await this.bootstrap();
    const agent = await store.getAgent({ agentId }).catch(() => null);
    if (!agent || agent.role === "human" || !agent.autoRunEnabled) return;
    this.ensureRunner(agentId).wakeup(reason);
  }

  async interruptAll(input?: { workspaceId?: UUID }) {
    await this.bootstrap();
    const workspaceId = input?.workspaceId?.trim();
    const agents = await store.listAgents(workspaceId ? { workspaceId } : undefined);
    const agentIds = agents.filter((agent) => agent.role !== "human").map((agent) => agent.id);

    for (const agentId of agentIds) {
      this.ensureRunner(agentId).requestInterrupt();
    }

    return { interrupted: agentIds.length, agentIds };
  }

  async interruptAgents(agentIds: UUID[]) {
    await this.bootstrap();
    const unique = [...new Set(agentIds)].filter(Boolean);
    for (const agentId of unique) {
      this.ensureRunner(agentId).requestInterrupt();
    }
    return { interrupted: unique.length, agentIds: unique };
  }

  async terminateAll(input: {
    workspaceId: UUID;
    includeKinds?: Array<"system_human" | "system_assistant" | "worker" | "game_ephemeral">;
    excludeKinds?: Array<"system_human" | "system_assistant" | "worker" | "game_ephemeral">;
  }) {
    await this.bootstrap();
    const paused = await store.bulkPauseAgents({
      workspaceId: input.workspaceId,
      includeKinds: input.includeKinds,
      excludeKinds: input.excludeKinds,
    });
    for (const agentId of paused.agentIds) {
      this.ensureRunner(agentId).requestInterrupt();
    }
    return { interrupted: paused.agentIds.length, paused: paused.paused, agentIds: paused.agentIds };
  }

  async softDeleteAll(input: {
    workspaceId: UUID;
    includeKinds?: Array<"system_human" | "system_assistant" | "worker" | "game_ephemeral">;
    excludeKinds?: Array<"system_human" | "system_assistant" | "worker" | "game_ephemeral">;
  }) {
    await this.bootstrap();
    const deleted = await store.bulkSoftDeleteAgents({
      workspaceId: input.workspaceId,
      includeKinds: input.includeKinds,
      excludeKinds: input.excludeKinds,
    });
    for (const agentId of deleted.agentIds) {
      this.ensureRunner(agentId).requestInterrupt();
    }
    const cleanedOrphans = await store.softDeleteOrphanGroups({ workspaceId: input.workspaceId });
    const cleanedSystem = await store.softDeleteRedundantSystemGroups({ workspaceId: input.workspaceId });
    const groupIds = [...new Set([...cleanedOrphans.groupIds, ...cleanedSystem.groupIds])];
    return {
      deleted: deleted.deleted,
      interrupted: deleted.agentIds.length,
      cleanedGroups: groupIds.length,
      agentIds: deleted.agentIds,
      groupIds,
    };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __agentWechatRuntime: AgentRuntime | undefined;
  // eslint-disable-next-line no-var
  var __agentWechatRuntimeVersion: number | undefined;
}

export function getAgentRuntime() {
  if (
    globalThis.__agentWechatRuntime &&
    globalThis.__agentWechatRuntimeVersion === AgentRuntime.VERSION
  ) {
    return globalThis.__agentWechatRuntime;
  }

  globalThis.__agentWechatRuntime = new AgentRuntime();
  globalThis.__agentWechatRuntimeVersion = AgentRuntime.VERSION;
  return globalThis.__agentWechatRuntime;
}




