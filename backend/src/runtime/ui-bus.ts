export type UIEvent =
  | {
      id: number;
      at: number;
      event: "ui.agent.created";
      data: { workspaceId: string; agent: { id: string; role: string; parentId: string | null } };
    }
  | {
      id: number;
      at: number;
      event: "ui.group.created";
      data: { workspaceId: string; group: { id: string; name: string | null; memberIds: string[] } };
    }
  | {
      id: number;
      at: number;
      event: "ui.message.created";
      data: {
        workspaceId: string;
        groupId: string;
        memberIds?: string[];
        message: {
          id: string;
          senderId: string;
          sendTime: string;
          content?: string;
          contentType?: string;
        };
      };
    }
  | {
      id: number;
      at: number;
      event: "ui.agent.llm.start";
      data: {
        workspaceId: string;
        agentId: string;
        groupId: string;
        round: number;
        provider?: string;
        model?: string;
      };
    }
  | {
      id: number;
      at: number;
      event: "ui.agent.llm.done";
      data: {
        workspaceId: string;
        agentId: string;
        groupId: string;
        round: number;
        finishReason?: string | null;
        provider?: string;
        model?: string;
      };
    }
  | {
      id: number;
      at: number;
      event: "ui.agent.history.persisted";
      data: { workspaceId: string; agentId: string; groupId: string; historyLength: number };
    }
  | {
      id: number;
      at: number;
      event: "ui.agent.tool_call.start";
      data: { workspaceId: string; agentId: string; groupId: string; toolCallId?: string; toolName?: string };
    }
  | {
      id: number;
      at: number;
      event: "ui.agent.tool_call.done";
      data: {
        workspaceId: string;
        agentId: string;
        groupId: string;
        toolCallId?: string;
        toolName?: string;
        ok: boolean;
      };
    }
  | {
      id: number;
      at: number;
      event: "ui.agent.interrupt_all";
      data: { workspaceId: string; interrupted: number; agentIds: string[] };
    }
  | {
      id: number;
      at: number;
      event: "ui.agent.terminate_all";
      data: { workspaceId: string; interrupted: number; paused: number; agentIds: string[] };
    }
  | {
      id: number;
      at: number;
      event: "ui.agent.delete_all";
      data: {
        workspaceId: string;
        deleted: number;
        cleanedGroups: number;
        agentIds: string[];
        groupIds: string[];
      };
    }
  | {
      id: number;
      at: number;
      event: "ui.task.started";
      data: {
        workspaceId: string;
        taskId: string;
        rootGroupId: string;
        ownerAgentId: string;
        goal: string;
        startAt: string;
        deadlineAt: string;
      };
    }
  | {
      id: number;
      at: number;
      event: "ui.task.progress";
      data: {
        workspaceId: string;
        taskId: string;
        totalTurns: number;
        totalMessages: number;
        repeatedRatio: number;
        idleMs: number;
        remainingMs: number;
      };
    }
  | {
      id: number;
      at: number;
      event: "ui.task.stopping";
      data: {
        workspaceId: string;
        taskId: string;
        reason:
          | "manual"
          | "timeout"
          | "no_progress"
          | "repeated_output"
          | "goal_reached"
          | "max_turns"
          | "manual_replaced"
          | "token_delta_exceeded";
      };
    }
  | {
      id: number;
      at: number;
      event: "ui.task.stopped";
      data: {
        workspaceId: string;
        taskId: string;
        reason:
          | "manual"
          | "timeout"
          | "no_progress"
          | "repeated_output"
          | "goal_reached"
          | "max_turns"
          | "manual_replaced"
          | "token_delta_exceeded";
        stoppedAt: string;
      };
    }
  | {
      id: number;
      at: number;
      event: "ui.task.summary.created";
      data: {
        workspaceId: string;
        taskId: string;
        summaryMessageId: string;
      };
    }
  | {
      id: number;
      at: number;
      event: "ui.task.review.created";
      data: {
        workspaceId: string;
        taskId: string;
        reviewMessageId?: string;
      };
    }
  | {
      id: number;
      at: number;
      event: "ui.agent.autorun.changed";
      data: { workspaceId: string; agentId: string; autoRunEnabled: boolean };
    }
  | {
      id: number;
      at: number;
      event: "ui.agent.deleted";
      data: { workspaceId: string; agentId: string };
    }
  | {
      id: number;
      at: number;
      event: "ui.db.write";
      data: {
        workspaceId: string;
        table: string;
        action: "insert" | "update" | "delete";
        recordId?: string | null;
      };
    };

type Listener = (evt: UIEvent) => void;

type ChannelState = {
  nextId: number;
  buffer: UIEvent[];
  listeners: Set<Listener>;
};

const DEFAULT_MAX_BUFFER = 2000;

export class WorkspaceUIBus {
  private readonly channels = new Map<string, ChannelState>();
  constructor(private readonly maxBuffer = DEFAULT_MAX_BUFFER) {}

  private getChannel(workspaceId: string): ChannelState {
    const existing = this.channels.get(workspaceId);
    if (existing) return existing;

    const created: ChannelState = {
      nextId: 1,
      buffer: [],
      listeners: new Set(),
    };
    this.channels.set(workspaceId, created);
    return created;
  }

  emit(workspaceId: string, event: Omit<UIEvent, "id" | "at">) {
    const channel = this.getChannel(workspaceId);
    const evt = { ...event, id: channel.nextId++, at: Date.now() } as UIEvent;

    channel.buffer.push(evt);
    if (channel.buffer.length > this.maxBuffer) {
      channel.buffer.splice(0, channel.buffer.length - this.maxBuffer);
    }

    // Best-effort persistence for cross-process/history replay (optional).
    void persistUIEvent(workspaceId, evt);

    for (const listener of channel.listeners) {
      listener(evt);
    }
  }

  subscribe(workspaceId: string, listener: Listener): () => void {
    const channel = this.getChannel(workspaceId);
    channel.listeners.add(listener);
    return () => channel.listeners.delete(listener);
  }

  getSince(workspaceId: string, afterId: number): UIEvent[] {
    const channel = this.getChannel(workspaceId);
    return channel.buffer.filter((e) => e.id > afterId);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __agentWechatUIBus: WorkspaceUIBus | undefined;
}

export function getWorkspaceUIBus() {
  if (globalThis.__agentWechatUIBus) return globalThis.__agentWechatUIBus;
  globalThis.__agentWechatUIBus = new WorkspaceUIBus();
  return globalThis.__agentWechatUIBus;
}

async function persistUIEvent(workspaceId: string, evt: UIEvent) {
  const { isUpstashRealtimeConfigured, getUpstashRealtime } = await import("./upstash-realtime");
  if (!isUpstashRealtimeConfigured()) return;
  try {
    await getUpstashRealtime().channel(`ui:${workspaceId}`).emit(evt.event, {
      id: evt.id,
      at: evt.at,
      data: evt.data,
    });
  } catch {
    // ignore
  }
}
