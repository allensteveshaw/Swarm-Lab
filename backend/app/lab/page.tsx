"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  Bot,
  BrainCircuit,
  Boxes,
  FlaskConical,
  Gamepad2,
  GitFork,
  Languages,
  LayoutDashboard,
  MessageSquareText,
  Network,
  Swords,
  Users,
} from "lucide-react";

type Range = "24h" | "7d";
type Locale = "zh" | "en";

type Overview = {
  workspaceId: string | null;
  range: Range;
  kpi: {
    activeAgents: number;
    runningTasks: number;
    messages: number;
    tokenDelta: number;
  };
  charts: {
    messageSeries: Array<{ bucket: string; count: number }>;
    taskStopReasons: Array<{ reason: string; count: number }>;
    modelUsage: Array<{ model: string; count: number }>;
    gameMatches: Array<{ game: "undercover" | "werewolf"; count: number }>;
  };
  topWorkspaces: Array<{ id: string; name: string; lastActiveAt: string }>;
};

const I18N = {
  zh: {
    brand: "Swarm Lab 蜂群实验室",
    subtitle: "开源多智能体实验平台：组织架构重组、任务协作与游戏化实验",
    range24: "近24小时",
    range7: "近7天",
    openIm: "消息协作中心",
    openGraph: "组织图谱",
    openUndercover: "谁是卧底",
    openWerewolf: "狼人杀",
    openBlueprints: "案例蓝图",
    openHome: "经典首页",
    kpiActiveAgents: "活跃 Agent",
    kpiRunningTasks: "运行中任务",
    kpiMessages: "消息吞吐",
    kpiTokenDelta: "Token 载荷",
    secSeries: "消息趋势",
    secStopReasons: "任务终止原因",
    secModelUsage: "模型使用占比",
    secGames: "游戏实验场次",
    secWorkspaces: "近期工作区",
    secValue: "项目价值",
    value1: "组织编排实验：自由创建、终止、重组 Agent 结构。",
    value2: "任务协作实验：目标驱动 + 自动停止，防止无限循环烧 token。",
    value3: "博弈实验：卧底/狼人杀用于多智能体策略差异验证。",
    noData: "暂无数据",
    wsHint: "点击进入该工作区消息协作中心",
  },
  en: {
    brand: "Swarm Lab",
    subtitle: "Open-source multi-agent experimentation for org design and game-like simulations",
    range24: "Last 24h",
    range7: "Last 7d",
    openIm: "Collaboration Center",
    openGraph: "Open Graph",
    openUndercover: "Undercover",
    openWerewolf: "Werewolf",
    openBlueprints: "Case Blueprints",
    openHome: "Classic Home",
    kpiActiveAgents: "Active Agents",
    kpiRunningTasks: "Running Tasks",
    kpiMessages: "Message Throughput",
    kpiTokenDelta: "Token Footprint",
    secSeries: "Message Trend",
    secStopReasons: "Task Stop Reasons",
    secModelUsage: "Model Usage",
    secGames: "Game Experiments",
    secWorkspaces: "Recent Workspaces",
    secValue: "Project Value",
    value1: "Org orchestration experiments: create/terminate/restructure agent trees.",
    value2: "Task collaboration experiments: goal-driven runtime with auto-stop safeguards.",
    value3: "Game experiments: Undercover/Werewolf for strategy divergence validation.",
    noData: "No data",
    wsHint: "Open this workspace in Collaboration Center",
  },
} as const;

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export default function LabPage() {
  const [locale, setLocale] = useState<Locale>("zh");
  const [range, setRange] = useState<Range>("24h");
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const t = I18N[locale];

  useEffect(() => {
    try {
      const savedLocale = localStorage.getItem("swarm-lab.locale");
      if (savedLocale === "zh" || savedLocale === "en") setLocale(savedLocale);
      const raw = localStorage.getItem("agent-wechat.session.v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { workspaceId?: string };
      if (parsed.workspaceId) setWorkspaceId(parsed.workspaceId);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("swarm-lab.locale", locale);
  }, [locale]);

  useEffect(() => {
    const q = new URLSearchParams({ range });
    if (workspaceId) q.set("workspaceId", workspaceId);
    setLoading(true);
    setError(null);
    api<Overview>(`/api/lab/overview?${q.toString()}`)
      .then((res) => {
        setData(res);
        if (!workspaceId && res.workspaceId) setWorkspaceId(res.workspaceId);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [range, workspaceId]);

  const modelPieData = useMemo(() => data?.charts.modelUsage ?? [], [data]);
  const COLORS = ["#22d3ee", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6", "#3b82f6", "#eab308"];

  return (
    <div className="lab-root">
      <div className="lab-hero">
        <div>
          <div className="lab-brand"><FlaskConical size={20} /> {t.brand}</div>
          <div className="lab-subtitle">{t.subtitle}</div>
        </div>
        <div className="lab-controls">
          <button className="btn" onClick={() => setLocale(locale === "zh" ? "en" : "zh")}><Languages size={14} /> {locale.toUpperCase()}</button>
          <button className={range === "24h" ? "btn btn-primary" : "btn"} onClick={() => setRange("24h")}>{t.range24}</button>
          <button className={range === "7d" ? "btn btn-primary" : "btn"} onClick={() => setRange("7d")}>{t.range7}</button>
        </div>
      </div>

      <div className="lab-actions">
        <Link className="btn" href={workspaceId ? `/im?workspaceId=${encodeURIComponent(workspaceId)}` : "/im"}><MessageSquareText size={14} /> {t.openIm}</Link>
        <Link className="btn" href="/graph"><Network size={14} /> {t.openGraph}</Link>
        <Link className="btn" href="/undercover"><Gamepad2 size={14} /> {t.openUndercover}</Link>
        <Link className="btn" href="/werewolf"><Swords size={14} /> {t.openWerewolf}</Link>
        <Link className="btn" href={workspaceId ? `/blueprints?workspaceId=${encodeURIComponent(workspaceId)}` : "/blueprints"}><Boxes size={14} /> {t.openBlueprints}</Link>
        <Link className="btn" href="/"><LayoutDashboard size={14} /> {t.openHome}</Link>
      </div>

      <div className="lab-kpis">
        <KpiCard icon={<Bot size={18} />} label={t.kpiActiveAgents} value={data?.kpi.activeAgents ?? 0} />
        <KpiCard icon={<Activity size={18} />} label={t.kpiRunningTasks} value={data?.kpi.runningTasks ?? 0} />
        <KpiCard icon={<Users size={18} />} label={t.kpiMessages} value={data?.kpi.messages ?? 0} />
        <KpiCard icon={<BrainCircuit size={18} />} label={t.kpiTokenDelta} value={data?.kpi.tokenDelta ?? 0} />
      </div>

      {error ? <div className="toast">Lab API error: {error}</div> : null}
      {loading ? (
        <div style={{ padding: "4px 0 12px 0", display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            <div className="skeleton skeleton-card" style={{ height: 80 }} />
            <div className="skeleton skeleton-card" style={{ height: 80 }} />
            <div className="skeleton skeleton-card" style={{ height: 80 }} />
            <div className="skeleton skeleton-card" style={{ height: 80 }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="skeleton skeleton-card" style={{ height: 200 }} />
            <div className="skeleton skeleton-card" style={{ height: 200 }} />
          </div>
        </div>
      ) : null}

      <div className="lab-grid">
        <section className="lab-card">
          <div className="lab-card-title">{t.secSeries}</div>
          {data?.charts.messageSeries?.length ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={data.charts.messageSeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="bucket" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="count" stroke="#22d3ee" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: "#22d3ee" }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="lab-empty">
              <div className="lab-empty-icon"><Activity size={20} /></div>
              <div className="muted" style={{ fontSize: 13 }}>{t.noData}</div>
            </div>
          )}
        </section>

        <section className="lab-card">
          <div className="lab-card-title">{t.secStopReasons}</div>
          {data?.charts.taskStopReasons?.length ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={data.charts.taskStopReasons}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="reason" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="count" fill="#10b981" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="lab-empty">
              <div className="lab-empty-icon"><GitFork size={20} /></div>
              <div className="muted" style={{ fontSize: 13 }}>{t.noData}</div>
            </div>
          )}
        </section>

        <section className="lab-card">
          <div className="lab-card-title">{t.secModelUsage}</div>
          {modelPieData.length ? (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={modelPieData} dataKey="count" nameKey="model" outerRadius={82} innerRadius={44} label>
                  {modelPieData.map((entry, idx) => (
                    <Cell key={`${entry.model}-${idx}`} fill={COLORS[idx % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, fontSize: 12 }} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="lab-empty">
              <div className="lab-empty-icon"><BrainCircuit size={20} /></div>
              <div className="muted" style={{ fontSize: 13 }}>{t.noData}</div>
            </div>
          )}
        </section>

        <section className="lab-card">
          <div className="lab-card-title">{t.secGames}</div>
          {data?.charts.gameMatches?.length ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={data.charts.gameMatches}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="game" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="count" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="lab-empty">
              <div className="lab-empty-icon"><Gamepad2 size={20} /></div>
              <div className="muted" style={{ fontSize: 13 }}>{t.noData}</div>
            </div>
          )}
        </section>

        <section className="lab-card">
          <div className="lab-card-title"><GitFork size={16} /> {t.secValue}</div>
          <ul className="lab-list">
            <li>{t.value1}</li>
            <li>{t.value2}</li>
            <li>{t.value3}</li>
          </ul>
        </section>

        <section className="lab-card">
          <div className="lab-card-title">{t.secWorkspaces}</div>
          <div className="lab-list">
            {(data?.topWorkspaces ?? []).map((w) => (
              <Link
                key={w.id}
                href={`/im?workspaceId=${encodeURIComponent(w.id)}`}
                className="lab-ws-row"
                title={t.wsHint}
              >
                <div>{w.name}</div>
                <div className="muted mono" style={{ fontSize: 11 }}>{new Date(w.lastActiveAt).toLocaleString()}</div>
              </Link>
            ))}
            {!data?.topWorkspaces?.length ? (
              <div className="lab-empty" style={{ padding: 16 }}>
                <div className="lab-empty-icon"><Boxes size={18} /></div>
                <div className="muted" style={{ fontSize: 13 }}>{t.noData}</div>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function KpiCard({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="lab-kpi-card">
      <div className="lab-kpi-label">{icon} {label}</div>
      <div className="lab-kpi-value">{value.toLocaleString()}</div>
    </div>
  );
}
