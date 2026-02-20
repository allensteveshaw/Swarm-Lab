"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Languages, LayoutDashboard, MessageSquareText, PlayCircle } from "lucide-react";

type BlueprintCase = {
  id: "debate" | "paper" | "code_review" | "product_design";
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  previewNodes: Array<{
    id: string;
    role: string;
    labelZh: string;
    labelEn: string;
    x: number;
    y: number;
    kind: "human" | "assistant" | "worker";
  }>;
  previewEdges: Array<{ from: string; to: string; type: "command" | "collab" | "review" }>;
};

type WorkspaceDefaults = {
  workspaceId: string;
  humanAgentId: string;
  assistantAgentId: string;
  defaultGroupId: string;
};

type Locale = "zh" | "en";
const SESSION_KEY = "agent-wechat.session.v1";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

function saveSession(session: WorkspaceDefaults) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

const I18N = {
  zh: {
    title: "案例蓝图工坊",
    subtitle: "四个预置蜂群架构。每次使用都会创建独立工作区，进入后先问主题再执行。",
    backLab: "返回大厅",
    openIm: "打开消息协作中心",
    useCase: "使用此案例",
    using: "创建中...",
    newWorkspaceHint: "点击案例后会自动创建全新工作区。",
  },
  en: {
    title: "Case Blueprints",
    subtitle: "Four prebuilt swarm structures. Each run gets an isolated workspace.",
    backLab: "Back to Lab",
    openIm: "Open Collaboration",
    useCase: "Use This Case",
    using: "Creating...",
    newWorkspaceHint: "A brand-new workspace will be created on each launch.",
  },
} as const;

export default function BlueprintsPage() {
  const [locale, setLocale] = useState<Locale>("zh");
  const [cases, setCases] = useState<BlueprintCase[]>([]);
  const [busyCaseId, setBusyCaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const savedLocale = localStorage.getItem("swarm-lab.locale");
      if (savedLocale === "zh" || savedLocale === "en") setLocale(savedLocale);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("swarm-lab.locale", locale);
  }, [locale]);

  useEffect(() => {
    void api<{ ok: boolean; cases: BlueprintCase[] }>("/api/blueprints/cases")
      .then((res) => setCases(res.cases ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const t = I18N[locale];
  const titleLine = useMemo(() => `${t.title} · Swarm Lab`, [t.title]);

  const onUseCase = async (blueprintId: string) => {
    setBusyCaseId(blueprintId);
    setError(null);
    try {
      const created = await api<WorkspaceDefaults>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: `Blueprint · ${blueprintId} · ${new Date().toLocaleString()}` }),
      });
      saveSession(created);
      const res = await api<{ ok: boolean; workspaceId: string; groupId: string; blueprintId: string }>(
        "/api/blueprints/instantiate",
        {
          method: "POST",
          body: JSON.stringify({
            workspaceId: created.workspaceId,
            blueprintId,
            locale,
          }),
        }
      );
      window.location.href = `/im?workspaceId=${encodeURIComponent(res.workspaceId)}&groupId=${encodeURIComponent(res.groupId)}&blueprintId=${encodeURIComponent(res.blueprintId)}&bpLocale=${locale}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyCaseId(null);
    }
  };

  return (
    <div className="blueprints-root">
      <div className="blueprints-hero">
        <div>
          <div className="blueprints-brand">
            <FlaskConical size={20} /> {titleLine}
          </div>
          <div className="blueprints-subtitle">{t.subtitle}</div>
        </div>
        <div className="blueprints-actions">
          <button className="btn" onClick={() => setLocale(locale === "zh" ? "en" : "zh")}>
            <Languages size={14} /> {locale.toUpperCase()}
          </button>
          <Link className="btn" href="/lab">
            <LayoutDashboard size={14} /> {t.backLab}
          </Link>
          <Link className="btn" href="/im">
            <MessageSquareText size={14} /> {t.openIm}
          </Link>
        </div>
      </div>

      <div className="blueprints-toolbar">
        <span className="muted">{t.newWorkspaceHint}</span>
      </div>

      {error ? <div className="toast" style={{ margin: "8px 0 0 0" }}>{error}</div> : null}

      <div className="blueprints-grid">
        {cases.map((c) => (
          <section key={c.id} className="blueprint-card">
            <div className="blueprint-card-header">
              <div className="blueprint-title">{locale === "zh" ? c.nameZh : c.nameEn}</div>
              <div className="blueprint-subtitle">{locale === "zh" ? c.descriptionZh : c.descriptionEn}</div>
            </div>

            <BlueprintMiniMap locale={locale} nodes={c.previewNodes} edges={c.previewEdges} />

            <button
              className="btn btn-primary blueprint-use-btn"
              disabled={busyCaseId !== null}
              onClick={() => void onUseCase(c.id)}
            >
              <PlayCircle size={14} />
              {busyCaseId === c.id ? t.using : t.useCase}
            </button>
          </section>
        ))}
      </div>
    </div>
  );
}

function BlueprintMiniMap({
  locale,
  nodes,
  edges,
}: {
  locale: "zh" | "en";
  nodes: Array<{
    id: string;
    role: string;
    labelZh: string;
    labelEn: string;
    x: number;
    y: number;
    kind: "human" | "assistant" | "worker";
  }>;
  edges: Array<{ from: string; to: string; type: "command" | "collab" | "review" }>;
}) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const colorOfEdge = (type: "command" | "collab" | "review") => {
    if (type === "command") return "rgba(56, 189, 248, 0.9)";
    if (type === "review") return "rgba(251, 191, 36, 0.85)";
    return "rgba(52, 211, 153, 0.85)";
  };

  return (
    <div className="blueprint-map">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <marker id="bpArrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="rgba(148,163,184,0.95)" />
          </marker>
        </defs>
        {edges.map((edge, idx) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to) return null;
          const cx = (from.x + to.x) / 2 + 4;
          const cy = (from.y + to.y) / 2 - 5;
          return (
            <path
              key={`${edge.from}-${edge.to}-${idx}`}
              d={`M${from.x},${from.y} Q${cx},${cy} ${to.x},${to.y}`}
              fill="none"
              stroke={colorOfEdge(edge.type)}
              strokeWidth="1.6"
              markerEnd="url(#bpArrow)"
            />
          );
        })}
        {nodes.map((node) => {
          const w = node.kind === "worker" ? 14 : 16;
          const h = 9;
          const x = node.x - w / 2;
          const y = node.y - h / 2;
          const border =
            node.kind === "human" ? "#38bdf8" : node.kind === "assistant" ? "#f59e0b" : "#34d399";
          const bg =
            node.kind === "human"
              ? "rgba(14,165,233,0.18)"
              : node.kind === "assistant"
              ? "rgba(245,158,11,0.18)"
              : "rgba(16,185,129,0.18)";
          return (
            <g key={node.id}>
              <rect x={x} y={y} rx={2.5} ry={2.5} width={w} height={h} fill={bg} stroke={border} strokeWidth="1.1" />
              <text x={node.x} y={node.y + 1.7} fill="#e2e8f0" fontSize="3.8" textAnchor="middle" fontWeight="700">
                {locale === "zh" ? node.labelZh : node.labelEn}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
