export const runtime = "nodejs";

import { and, desc, eq, gte, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import { groups, taskRuns, undercoverGames, werewolfGames } from "@/db/schema";
import { store } from "@/lib/storage";

type Range = "24h" | "7d";

function getRange(raw: string | null): Range {
  return raw === "7d" ? "7d" : "24h";
}

function getSince(range: Range): Date {
  const now = Date.now();
  const deltaMs = range === "7d" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return new Date(now - deltaMs);
}

function getBucketKey(iso: string, range: Range) {
  const d = new Date(iso);
  if (range === "7d") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate()
    ).padStart(2, "0")}`;
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:00`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceIdQuery = url.searchParams.get("workspaceId");
  const range = getRange(url.searchParams.get("range"));
  const since = getSince(range);

  let workspaceId = workspaceIdQuery?.trim() || "";
  if (!workspaceId) {
    const workspaces = await store.listWorkspaces();
    workspaceId = workspaces[0]?.id ?? "";
  }
  if (!workspaceId) {
    return Response.json(
      {
        workspaceId: null,
        range,
        kpi: { activeAgents: 0, runningTasks: 0, messages: 0, tokenDelta: 0 },
        charts: { messageSeries: [], taskStopReasons: [], modelUsage: [], gameMatches: [] },
        topWorkspaces: [],
      },
      { status: 200 }
    );
  }

  const db = getDb();
  const [agents, runningTasks, recentMessages, workspaceRows, taskRows, undercoverRows, werewolfRows] =
    await Promise.all([
      store.listAgentsMeta({ workspaceId }),
      store.listRunningTaskRuns(),
      store.listRecentWorkspaceMessages({ workspaceId, limit: range === "7d" ? 5000 : 2500 }),
      db
        .select({ contextTokens: groups.contextTokens })
        .from(groups)
        .where(and(eq(groups.workspaceId, workspaceId), isNull(groups.deletedAt))),
      db
        .select({ stopReason: taskRuns.stopReason, createdAt: taskRuns.createdAt })
        .from(taskRuns)
        .where(and(eq(taskRuns.workspaceId, workspaceId), gte(taskRuns.createdAt, since)))
        .orderBy(desc(taskRuns.createdAt)),
      db
        .select({ createdAt: undercoverGames.createdAt })
        .from(undercoverGames)
        .where(and(eq(undercoverGames.workspaceId, workspaceId), gte(undercoverGames.createdAt, since))),
      db
        .select({ createdAt: werewolfGames.createdAt })
        .from(werewolfGames)
        .where(and(eq(werewolfGames.workspaceId, workspaceId), gte(werewolfGames.createdAt, since))),
    ]);

  const activeAgents = agents.filter((a) => a.role !== "human" && !a.deletedAt && a.autoRunEnabled).length;
  const runningTasksCount = runningTasks.filter((t) => t.workspaceId === workspaceId).length;

  const filteredMessages = recentMessages.filter((m) => new Date(m.sendTime).getTime() >= since.getTime());
  const messageSeriesMap = new Map<string, number>();
  for (const m of filteredMessages) {
    const key = getBucketKey(m.sendTime, range);
    messageSeriesMap.set(key, (messageSeriesMap.get(key) ?? 0) + 1);
  }
  const messageSeries = [...messageSeriesMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, count]) => ({ bucket, count }));

  const stopReasonMap = new Map<string, number>();
  for (const row of taskRows) {
    const reason = (row.stopReason ?? "unknown").trim();
    stopReasonMap.set(reason, (stopReasonMap.get(reason) ?? 0) + 1);
  }
  const taskStopReasons = [...stopReasonMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const modelLabelByAgentId = new Map<string, string>();
  for (const a of agents) {
    modelLabelByAgentId.set(a.id, a.role === "human" ? "human" : a.modelLabel ?? "legacy-env");
  }
  const modelUsageMap = new Map<string, number>();
  for (const m of filteredMessages) {
    const label = modelLabelByAgentId.get(m.senderId) ?? "unknown";
    modelUsageMap.set(label, (modelUsageMap.get(label) ?? 0) + 1);
  }
  const modelUsage = [...modelUsageMap.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const tokenDelta = workspaceRows.reduce((sum, row) => sum + Number(row.contextTokens ?? 0), 0);

  const gameMatches = [
    { game: "undercover" as const, count: undercoverRows.length },
    { game: "werewolf" as const, count: werewolfRows.length },
  ];

  const topWorkspaces = (await store.listWorkspaces()).slice(0, 8).map((w) => ({
    id: w.id,
    name: w.name,
    lastActiveAt: w.createdAt,
  }));

  return Response.json({
    workspaceId,
    range,
    kpi: {
      activeAgents,
      runningTasks: runningTasksCount,
      messages: filteredMessages.length,
      tokenDelta,
    },
    charts: {
      messageSeries,
      taskStopReasons,
      modelUsage,
      gameMatches,
    },
    topWorkspaces,
  });
}

