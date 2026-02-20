import Link from "next/link";
import { FlaskConical, MessageSquareText, Network, Gamepad2, Swords, Boxes, Plus, Trash2 } from "lucide-react";

import { store } from "@/lib/storage";

import ClearDbButton from "./_components/clear-db";
import CreateWorkspace from "./_components/create-workspace";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function HomePage() {
  let workspaces:
    | Array<{ id: string; name: string; createdAt: string }>
    | null = null;
  let dbError: string | null = null;

  try {
    workspaces = await store.listWorkspaces();
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="home-root">
      <div className="home-container">
        <div className="home-hero">
          <h1 className="home-brand"><FlaskConical size={24} /> Swarm Lab 蜂群实验室</h1>
          <p className="home-subtitle">
            开源多智能体实验平台：组织协作、策略博弈、架构编排与可视化观测。
          </p>
        </div>

        <section className="home-section featured">
          <div className="home-section-title"><FlaskConical size={16} /> Swarm Lab Dashboard</div>
          <div className="home-btn-row">
            <Link className="btn btn-primary" href="/lab">
              Enter Swarm Lab
            </Link>
            <Link className="btn" href="/blueprints">
              <Boxes size={14} /> 案例蓝图工坊
            </Link>
          </div>
          <p className="home-section-desc">
            新版大厅：多面板仪表盘、实验指标、双语入口与统一导航。
          </p>
        </section>

        {dbError ? (
          <div className="toast">
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Database not ready</div>
            <div className="mono" style={{ whiteSpace: "pre-wrap" }}>
              {dbError}
            </div>
            <div style={{ marginTop: 10 }} className="mono">
              Try:<br />
              1) `cd backend && docker compose up -d`<br />
              2) `curl -X POST http://localhost:3017/api/admin/init-db`<br />
              3) refresh
            </div>
          </div>
        ) : null}

        <section className="home-section">
          <div className="home-section-title"><MessageSquareText size={16} /> Swarm 原始模式</div>
          <div className="home-btn-row">
            <Link className="btn btn-primary" href="/im">
              <MessageSquareText size={14} /> 消息协作中心
            </Link>
            <Link className="btn" href="/graph">
              <Network size={14} /> Open Graph
            </Link>
          </div>
          <p className="home-section-desc">
            用于原始 swarm 协作与可视化图谱。
          </p>
        </section>

        <section className="home-section">
          <div className="home-section-title"><Gamepad2 size={16} /> 游戏模式</div>
          <div className="home-btn-row">
            <Link className="btn" href="/undercover">
              <Gamepad2 size={14} /> 谁是卧底
            </Link>
            <Link className="btn" href="/werewolf">
              <Swords size={14} /> 狼人杀
            </Link>
          </div>
          <p className="home-section-desc">
            多智能体博弈玩法入口（沉浸可视化界面）。
          </p>
        </section>

        <section className="home-section">
          <div className="home-section-title"><Plus size={16} /> Create Workspace</div>
          <CreateWorkspace />
        </section>

        <section className="home-section">
          <div className="home-section-title"><Trash2 size={16} /> Admin</div>
          <ClearDbButton />
        </section>

        <section className="home-section">
          <div className="home-section-title">Workspaces</div>
          <p className="home-section-desc" style={{ marginTop: 0, marginBottom: 12 }}>
            点击进入所选工作区的消息协作中心。
          </p>
          <WorkspacesList workspaces={workspaces ?? []} />
        </section>
      </div>
    </div>
  );
}

function WorkspacesList({ workspaces }: { workspaces: Array<{ id: string; name: string; createdAt: string }> }) {
  if (workspaces.length === 0) {
    return (
      <div className="lab-empty">
        <div className="lab-empty-icon"><FlaskConical size={20} /></div>
        <div>还没有工作区。先进入消息协作中心创建一个。</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {workspaces.map((w) => (
        <Link
          key={w.id}
          href={`/im?workspaceId=${encodeURIComponent(w.id)}`}
          className="game-lobby-card"
          style={{ textDecoration: "none" }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>{w.name}</div>
            <div className="muted mono" style={{ fontSize: 12, marginTop: 4 }}>
              {w.id.slice(0, 8)}...
            </div>
          </div>
          <div className="muted mono" style={{ fontSize: 12 }}>
            {new Date(w.createdAt).toLocaleString()}
          </div>
        </Link>
      ))}
    </div>
  );
}
