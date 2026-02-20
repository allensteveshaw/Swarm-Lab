"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Gamepad2, MessageSquareText, LayoutDashboard } from "lucide-react";

type Workspace = { id: string; name: string; createdAt: string };
type GameSummary = {
  id: string;
  status: string;
  phase: string;
  roundNo: number;
  winnerSide: string | null;
  createdAt: string;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(await res.text().catch(() => `${res.status}`));
  }
  return (await res.json()) as T;
}

export default function UndercoverLobbyPage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [games, setGames] = useState<GameSummary[]>([]);
  const [loadingGames, setLoadingGames] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ workspaces: Workspace[] }>("/api/workspaces");
        setWorkspaces(data.workspaces);
        if (data.workspaces[0]) setWorkspaceId(data.workspaces[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    setLoadingGames(true);
    void (async () => {
      try {
        const data = await api<{ games: GameSummary[] }>(
          `/api/undercover/games?workspaceId=${encodeURIComponent(workspaceId)}`
        );
        setGames(data.games);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingGames(false);
      }
    })();
  }, [workspaceId]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === workspaceId) ?? null,
    [workspaces, workspaceId]
  );

  async function createGame() {
    if (!workspaceId || creating) return;
    setCreating(true);
    setError(null);
    try {
      const data = await api<{ game: { id: string } }>("/api/undercover/games", {
        method: "POST",
        body: JSON.stringify({ workspaceId }),
      });
      router.push(`/undercover/${data.game.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="game-root undercover">
      <div className="game-container" style={{ maxWidth: 1100 }}>
        <section className="game-header">
          <div>
            <h1 style={{ margin: 0, fontSize: 28, display: "flex", alignItems: "center", gap: 8 }}>
              <Gamepad2 size={24} /> 谁是卧底 · Swarm Arena
            </h1>
            <div className="muted" style={{ marginTop: 8 }}>
              1 人类 + 5 AI 多模型蜂群对局（6 人局，完整回合制）
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link className="btn" href="/">
              <LayoutDashboard size={14} /> 返回首页
            </Link>
            <Link className="btn" href="/im">
              <MessageSquareText size={14} /> 消息协作中心
            </Link>
          </div>
        </section>

        <section className="game-actions">
          <div style={{ fontWeight: 700 }}>开局设置</div>
          <label style={{ display: "grid", gap: 8, maxWidth: 520 }}>
            <span className="muted">Workspace</span>
            <select className="input" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <div className="muted" style={{ fontSize: 13 }}>
            当前：{selectedWorkspace ? `${selectedWorkspace.name} (${selectedWorkspace.id.slice(0, 8)}...)` : "未选择"}
          </div>
          <div>
            <button className="btn btn-primary" onClick={createGame} disabled={!workspaceId || creating}>
              {creating ? "正在创建..." : "开始新对局"}
            </button>
          </div>
          {error ? (
            <div className="toast" style={{ margin: 0 }}>
              <div style={{ fontWeight: 700 }}>错误</div>
              <div className="mono" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
                {error}
              </div>
            </div>
          ) : null}
        </section>

        <section className="game-actions">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 700 }}>最近对局</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {loadingGames ? "刷新中..." : `${games.length} 局`}
            </div>
          </div>
          {games.length === 0 ? (
            <div className="lab-empty">
              <div className="lab-empty-icon"><Gamepad2 size={20} /></div>
              <div>还没有对局，先创建一局。</div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {games.map((g) => (
                <button
                  key={g.id}
                  onClick={() => router.push(`/undercover/${g.id}`)}
                  className="game-lobby-card"
                  style={{ cursor: "pointer", border: "1px solid var(--border-default)" }}
                >
                  <div>
                    <div style={{ fontWeight: 700 }}>Game {g.id.slice(0, 8)}</div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      {new Date(g.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span className={`game-status ${g.status === "finished" ? "finished" : "running"}`}>
                      {g.status === "finished" ? "已结束" : "进行中"}
                    </span>
                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      Round {g.roundNo} · {g.phase}
                    </div>
                    {g.winnerSide ? (
                      <div style={{ marginTop: 6, fontSize: 12, color: g.winnerSide === "civilian" ? "#22c55e" : "#fb7185" }}>
                        胜方：{g.winnerSide === "civilian" ? "平民" : "卧底"}
                      </div>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
