"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Game = {
  id: string;
  workspaceId: string;
  status: "running" | "finished";
  phase:
    | "night_wolf"
    | "night_seer"
    | "night_witch"
    | "day_announce"
    | "day_speaking"
    | "day_voting"
    | "day_tiebreak_speaking"
    | "day_tiebreak_voting"
    | "day_elimination"
    | "game_over";
  roundNo: number;
  humanAgentId: string;
  currentTurnPlayerId: string | null;
  winnerSide: "werewolf_side" | "good_side" | null;
  state: { tieCandidates: string[] };
};

type Player = {
  agentId: string;
  isHuman: boolean;
  role: "werewolf" | "seer" | "witch" | "villager";
  alive: boolean;
  seatNo: number;
};

type EventItem = {
  id: string;
  roundNo: number;
  phase: string;
  eventType: string;
  actorAgentId: string | null;
  targetAgentId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

type GameDetail = {
  game: Game;
  players: Player[];
  humanRole: "werewolf" | "seer" | "witch" | "villager";
  humanNightInfo: {
    canAct: boolean;
    seerResult: { targetAgentId: string | null; result: "werewolf" | "good" | null } | null;
    witchState: { healUsed: boolean; poisonUsed: boolean; pendingKill: string | null } | null;
  };
  humanSpeechInfo: {
    skipUsed: number;
    skipLimit: number;
  };
  reveal: Array<{ agentId: string; seatNo: number; role: string; alive: boolean }> | null;
};

type BubbleState = { text: string; kind: "speech" | "vote" | "gm" };
type LiveSpeech = { actorAgentId: string; text: string; done: boolean };
type BannerTone = "phase" | "warn" | "win";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text().catch(() => `${res.status}`));
  return (await res.json()) as T;
}

function roleText(role: string) {
  if (role === "werewolf") return "狼人";
  if (role === "seer") return "预言家";
  if (role === "witch") return "女巫";
  return "村民";
}

function phaseText(phase: Game["phase"]) {
  const map: Record<Game["phase"], string> = {
    night_wolf: "夜晚·狼人行动",
    night_seer: "夜晚·预言家查验",
    night_witch: "夜晚·女巫行动",
    day_announce: "白天·昨夜公告",
    day_speaking: "白天·发言",
    day_voting: "白天·投票",
    day_tiebreak_speaking: "平票加赛·发言",
    day_tiebreak_voting: "平票加赛·投票",
    day_elimination: "白天·淘汰结算",
    game_over: "游戏结束",
  };
  return map[phase] ?? phase;
}

function phaseMode(phase: Game["phase"]) {
  return phase.startsWith("night_") ? "night" : "day";
}

function playerName(p?: Player | null) {
  if (!p) return "未知玩家";
  return `玩家${p.seatNo}${p.isHuman ? "(你)" : ""}`;
}

function winnerText(winner: string | null | undefined) {
  if (winner === "good_side") return "好人阵营胜利";
  if (winner === "werewolf_side") return "狼人阵营胜利";
  return "游戏结束";
}

export default function WerewolfGamePage() {
  const params = useParams<{ gameId: string }>();
  const gameId = params.gameId;

  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [liveSpeech, setLiveSpeech] = useState<LiveSpeech | null>(null);
  const [lastBubbleById, setLastBubbleById] = useState<Record<string, BubbleState>>({});
  const [speechDraft, setSpeechDraft] = useState("");
  const [voteTarget, setVoteTarget] = useState("");
  const [voteReason, setVoteReason] = useState("");
  const [nightTarget, setNightTarget] = useState("");
  const [review, setReview] = useState<{ summary: any; narrative: string } | null>(null);
  const [centerBanner, setCenterBanner] = useState<{ text: string; tone: BannerTone } | null>(null);
  const [countdownById, setCountdownById] = useState<Record<string, number>>({});
  const [nightCurtain, setNightCurtain] = useState(false);
  const [deathFlash, setDeathFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refreshRef = useRef<number | null>(null);
  const bannerTimerRef = useRef<number | null>(null);
  const playersByIdRef = useRef<Map<string, Player>>(new Map());

  const showBanner = useCallback((text: string, tone: BannerTone = "phase", durationMs = 1500) => {
    setCenterBanner({ text, tone });
    if (bannerTimerRef.current !== null) window.clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = window.setTimeout(() => {
      setCenterBanner(null);
      bannerTimerRef.current = null;
    }, durationMs);
  }, []);

  const load = useCallback(async () => {
    const [g, e] = await Promise.all([
      api<GameDetail>(`/api/werewolf/games/${encodeURIComponent(gameId)}`),
      api<{ events: EventItem[] }>(`/api/werewolf/games/${encodeURIComponent(gameId)}/events`),
    ]);
    setDetail(g);
    setEvents(e.events);

    const nextBubbles: Record<string, BubbleState> = {};
    const recent = e.events.slice(-80);
    for (const ev of recent) {
      const aid = ev.actorAgentId ?? "";
      if (!aid) continue;
      if (ev.eventType === "speech") {
        const text = String(ev.payload?.text ?? "");
        if (text) nextBubbles[aid] = { text, kind: "speech" };
      }
      if (ev.eventType === "speech_skip") {
        nextBubbles[aid] = { text: "本轮选择过", kind: "speech" };
      }
      if (ev.eventType === "vote") {
        const target = g.players.find((p) => p.agentId === ev.targetAgentId);
        nextBubbles[aid] = { text: `投给 ${playerName(target)}`, kind: "vote" };
      }
    }
    setLastBubbleById(nextBubbles);
  }, [gameId]);

  const scheduleLoad = useCallback((delayMs = 180) => {
    if (refreshRef.current !== null) return;
    refreshRef.current = window.setTimeout(() => {
      refreshRef.current = null;
      void load().catch(() => undefined);
    }, delayMs);
  }, [load]);

  useEffect(() => {
    setLoading(true);
    void load().catch((e) => setError(String(e))).finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    const es = new EventSource(`/api/werewolf/stream?gameId=${encodeURIComponent(gameId)}`);
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as { event?: string; data?: Record<string, unknown> };
        const evt = parsed.event ?? "";
        const data = parsed.data ?? {};

        if (evt === "ui.werewolf.speech_delta") {
          const aid = String(data.actorAgentId ?? "");
          const text = String(data.text ?? "");
          const done = Boolean(data.done);
          setLiveSpeech({ actorAgentId: aid, text, done });
          if (aid && text) setLastBubbleById((prev) => ({ ...prev, [aid]: { text, kind: "speech" } }));
          if (done) window.setTimeout(() => setLiveSpeech(null), 700);
          return;
        }

        if (evt === "ui.werewolf.countdown") {
          const aid = String(data.actorAgentId ?? "");
          const remain = Number(data.remainSec ?? 0);
          if (aid) setCountdownById((prev) => ({ ...prev, [aid]: remain }));
          return;
        }

        if (evt === "ui.werewolf.turn_start") {
          const aid = String(data.actorAgentId ?? "");
          if (aid) setDetail((prev) => (prev ? { ...prev, game: { ...prev.game, currentTurnPlayerId: aid } } : prev));
          return;
        }

        if (evt === "ui.werewolf.turn_end") {
          const aid = String(data.actorAgentId ?? "");
          if (aid) setCountdownById((prev) => ({ ...prev, [aid]: 0 }));
          return;
        }

        if (evt === "ui.werewolf.vote_reveal") {
          const aid = String(data.actorAgentId ?? "");
          const tid = String(data.targetAgentId ?? "");
          if (aid && tid) {
            const target = playersByIdRef.current.get(tid);
            setLastBubbleById((prev) => ({ ...prev, [aid]: { text: `投给 ${playerName(target)}`, kind: "vote" } }));
          }
          return;
        }
        if (evt === "ui.werewolf.speech_skip") {
          const aid = String(data.actorAgentId ?? "");
          if (aid) setLastBubbleById((prev) => ({ ...prev, [aid]: { text: "本轮选择过", kind: "speech" } }));
          scheduleLoad(90);
          return;
        }

        if (evt === "ui.werewolf.cinematic") {
          const kind = String(data.kind ?? "");
          const text = String(data.text ?? "");
          if (kind === "curtain_night") {
            setNightCurtain(true);
            showBanner(text || "天黑请闭眼", "phase", 1600);
          }
          if (kind === "curtain_dawn") {
            showBanner(text || "天亮了", "phase", 1600);
            window.setTimeout(() => setNightCurtain(false), 600);
          }
          if (kind === "death_mark") {
            setDeathFlash(true);
            showBanner(text || "昨夜有人倒下", "warn", 1800);
            window.setTimeout(() => setDeathFlash(false), 500);
          }
          if (kind === "vote_start") showBanner(text || "开始投票", "phase", 1400);
          if (kind === "vote_result") showBanner(text || "票型统计中", "warn", 1500);
          return;
        }

        if (evt === "ui.werewolf.phase_change") {
          const payload = (data.payload ?? {}) as Record<string, unknown>;
          const to = String(payload.to ?? "");
          if (to) {
            setDetail((prev) => (prev ? { ...prev, game: { ...prev.game, phase: to as Game["phase"] } } : prev));
            showBanner(phaseText(to as Game["phase"]), "phase");
          }
          scheduleLoad(90);
          return;
        }
        if (evt === "ui.werewolf.day_announce") {
          const payload = (data.payload ?? {}) as Record<string, unknown>;
          const deaths = Array.isArray(payload.deaths) ? (payload.deaths as unknown[]) : [];
          if (deaths.length === 0) showBanner("平安夜：首轮可选择过麦", "phase", 1700);
          scheduleLoad(90);
          return;
        }

        if (evt === "ui.werewolf.death_reveal") {
          scheduleLoad(90);
          return;
        }

        if (evt === "ui.werewolf.elimination") {
          showBanner("公布出局结果", "warn", 1700);
          scheduleLoad(90);
          return;
        }

        if (evt === "ui.werewolf.game_over") {
          const payload = (data.payload ?? {}) as Record<string, unknown>;
          const winner = String(payload.winner ?? data.winner ?? "");
          showBanner(winnerText(winner), "win", 2600);
          scheduleLoad(80);
          return;
        }

        scheduleLoad(220);
      } catch {
        scheduleLoad(240);
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [gameId, scheduleLoad, showBanner]);

  useEffect(() => {
    return () => {
      if (bannerTimerRef.current !== null) window.clearTimeout(bannerTimerRef.current);
    };
  }, []);

  const playersById = useMemo(() => {
    const map = new Map<string, Player>();
    for (const p of detail?.players ?? []) map.set(p.agentId, p);
    return map;
  }, [detail?.players]);
  useEffect(() => {
    playersByIdRef.current = playersById;
  }, [playersById]);

  const myId = detail?.game.humanAgentId ?? "";
  const isMySpeechTurn = !!detail && (detail.game.phase === "day_speaking" || detail.game.phase === "day_tiebreak_speaking") && detail.game.currentTurnPlayerId === myId;
  const isMyVoteTurn = !!detail && (detail.game.phase === "day_voting" || detail.game.phase === "day_tiebreak_voting") && detail.game.currentTurnPlayerId === myId;
  const isMyNightTurn = !!detail && detail.humanNightInfo.canAct && detail.game.currentTurnPlayerId === myId;

  const voteTargets = useMemo(() => {
    if (!detail) return [] as Player[];
    if (detail.game.phase === "day_tiebreak_voting") {
      return detail.players.filter((p) => p.alive && p.agentId !== myId && detail.game.state.tieCandidates.includes(p.agentId));
    }
    return detail.players.filter((p) => p.alive && p.agentId !== myId);
  }, [detail, myId]);

  const nightTargets = useMemo(() => {
    if (!detail) return [] as Player[];
    return detail.players.filter((p) => p.alive && p.agentId !== myId);
  }, [detail, myId]);

  useEffect(() => {
    if (!voteTarget && voteTargets[0]) setVoteTarget(voteTargets[0].agentId);
  }, [voteTarget, voteTargets]);
  useEffect(() => {
    if (!nightTarget && nightTargets[0]) setNightTarget(nightTargets[0].agentId);
  }, [nightTarget, nightTargets]);

  async function actNight(actionType: "wolf_kill" | "seer_check" | "witch_heal" | "witch_poison" | "witch_skip") {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/werewolf/games/${encodeURIComponent(gameId)}/human/night-action`, {
        method: "POST",
        body: JSON.stringify({ actorAgentId: myId, actionType, targetAgentId: nightTarget || null }),
      });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitSpeech() {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/werewolf/games/${encodeURIComponent(gameId)}/human/speech`, {
        method: "POST",
        body: JSON.stringify({ actorAgentId: myId, text: speechDraft }),
      });
      setSpeechDraft("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitSkipSpeech() {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/werewolf/games/${encodeURIComponent(gameId)}/human/speech`, {
        method: "POST",
        body: JSON.stringify({ actorAgentId: myId, action: "skip", reason: "保留信息，暂不过麦" }),
      });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitVote() {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/werewolf/games/${encodeURIComponent(gameId)}/human/vote`, {
        method: "POST",
        body: JSON.stringify({ voterAgentId: myId, targetAgentId: voteTarget, reason: voteReason }),
      });
      setVoteReason("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadReview() {
    setBusy(true);
    setError(null);
    try {
      setReview(await api(`/api/werewolf/games/${encodeURIComponent(gameId)}/review`));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return (
    <main className="game-root werewolf">
      <div className="game-container">
        <div className="skeleton skeleton-card" style={{ height: 80 }} />
        <div className="skeleton skeleton-card" style={{ height: 400 }} />
        <div className="skeleton skeleton-card" style={{ height: 120 }} />
      </div>
    </main>
  );
  if (!detail) return (
    <main className="game-root werewolf">
      <div className="game-container">
        <div className="lab-empty"><div className="lab-empty-icon" style={{ fontSize: 24 }}>?</div><div>Game not found.</div></div>
      </div>
    </main>
  );

  const gameLogs = events.filter((e) => ["speech", "speech_skip", "vote", "gm_notice", "day_announce", "elimination"].includes(e.eventType)).slice(-40);

  return (
    <main className="game-root werewolf" style={{ position: "relative", overflow: "hidden" }}>
      {nightCurtain ? <div className="game-curtain" /> : null}
      {deathFlash ? <div className="game-death-flash" /> : null}
      <div className="game-container">
        <section className="game-header">
          <div>
            <div className="mono muted" style={{ fontSize: 12 }}>Game {detail.game.id.slice(0, 8)}...</div>
            <div style={{ fontWeight: 700, marginTop: 4 }}>第 {detail.game.roundNo} 轮 · {phaseText(detail.game.phase)}</div>
            <div className="muted" style={{ marginTop: 4 }}>你的身份：{roleText(detail.humanRole)}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link className="btn" href="/werewolf">返回狼人大厅</Link>
          </div>
        </section>

        <section className="game-board">
          <div className="game-board-inner">
            <div className="game-table-wrap">
              <div className="game-table">
                {centerBanner ? (
                  <div className={`game-banner ${centerBanner.tone}`}>
                    {centerBanner.text}
                  </div>
                ) : null}

                <div className="game-center" style={{ background: phaseMode(detail.game.phase) === "night" ? "radial-gradient(circle,#111827,#020617)" : "radial-gradient(circle,var(--surface-1),var(--surface-0))" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontWeight: 800, fontSize: 24 }}>R{detail.game.roundNo}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{phaseText(detail.game.phase)}</div>
                  </div>
                </div>

                {detail.players.map((p, idx) => {
                  const angle = (Math.PI * 2 * idx) / detail.players.length - Math.PI / 2;
                  const radius = 41;
                  const x = 50 + radius * Math.cos(angle);
                  const y = 50 + radius * Math.sin(angle);
                  const active = detail.game.currentTurnPlayerId === p.agentId;
                  const speaking = liveSpeech?.actorAgentId === p.agentId;
                  const eliminated = !p.alive;
                  const bubble = lastBubbleById[p.agentId];
                  const countdown = countdownById[p.agentId] ?? 0;

                  const seatClasses = [
                    "game-seat",
                    speaking ? "speaking" : "",
                    active ? "active" : "",
                    eliminated ? "eliminated" : "",
                  ].filter(Boolean).join(" ");

                  return (
                    <div
                      key={p.agentId}
                      className={`game-seat-wrap${eliminated ? " eliminated" : ""}`}
                      style={{ left: `${x}%`, top: `${y}%` }}
                    >
                      {bubble ? (
                        <div className={`game-bubble${bubble.kind === "vote" ? " vote" : ""}`}>
                          {bubble.text}
                        </div>
                      ) : null}

                      <div
                        className={seatClasses}
                        style={{
                          background: phaseMode(detail.game.phase) === "night" ? "#111827" : "var(--surface-1)",
                        }}
                      >
                        <span style={{ fontSize: 27 }}>{p.isHuman ? "🧑" : "🤖"}</span>
                      </div>

                      {countdown > 0 && active ? (
                        <div style={{ marginTop: 4, fontSize: 11, color: "#fbbf24", fontWeight: 700 }}>倒计时 {countdown}s</div>
                      ) : null}
                      <div style={{ marginTop: 4, fontSize: 12, fontWeight: 700 }}>{playerName(p)}</div>
                      <div className="muted" style={{ fontSize: 11 }}>{p.alive ? "存活" : "出局"}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="game-sidebar">
              <div className="game-panel">
                <div style={{ fontWeight: 700 }}>实时发言</div>
                {liveSpeech ? (
                  <div style={{ marginTop: 8 }}>
                    <div className="muted">Speaker: {playerName(playersById.get(liveSpeech.actorAgentId))}</div>
                    <div style={{ marginTop: 6, lineHeight: 1.6 }}>{liveSpeech.text}</div>
                  </div>
                ) : (
                  <div className="muted" style={{ marginTop: 8 }}>等待中...</div>
                )}
              </div>

              <div className="game-panel game-panel-scroll">
                <div style={{ fontWeight: 700, marginBottom: 8 }}>日志</div>
                {gameLogs.map((e) => (
                  <div key={e.id} style={{ borderBottom: "1px solid var(--border-default)", padding: "6px 0" }}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{e.actorAgentId ? playerName(playersById.get(e.actorAgentId)) : "GM"}</div>
                    <div style={{ fontSize: 12, marginTop: 3 }}>
                      {e.eventType === "speech"
                        ? String(e.payload?.text ?? "")
                        : e.eventType === "speech_skip"
                        ? `${e.actorAgentId ? playerName(playersById.get(e.actorAgentId)) : "玩家"} 选择跳过发言`
                        : e.eventType === "vote"
                        ? `投票给 ${playerName(playersById.get(String(e.targetAgentId ?? "")))}，理由：${String(e.payload?.reason ?? "")}`
                        : e.eventType === "gm_notice"
                        ? String((e.payload as any)?.message ?? "GM 公告")
                        : e.eventType === "day_announce"
                        ? (() => {
                            const deaths = Array.isArray((e.payload as any)?.deaths) ? ((e.payload as any).deaths as string[]) : [];
                            if (deaths.length === 0) return "昨夜平安夜，无人出局";
                            return `昨夜出局：${deaths.map((id) => playerName(playersById.get(String(id)))).join("、")}`;
                          })()
                        : JSON.stringify(e.payload)}
                    </div>
                    <div className="muted" style={{ fontSize: 11 }}>{new Date(e.createdAt).toLocaleTimeString()}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="game-actions">
          <div style={{ fontWeight: 700 }}>你的操作</div>

          {isMyNightTurn ? (
            <>
              <select className="input" value={nightTarget} onChange={(e) => setNightTarget(e.target.value)}>
                {nightTargets.map((p) => <option key={p.agentId} value={p.agentId}>{playerName(p)}</option>)}
              </select>
              {detail.humanRole === "werewolf" ? <button className="btn btn-danger" onClick={() => actNight("wolf_kill")} disabled={busy}>夜晚击杀</button> : null}
              {detail.humanRole === "seer" ? <button className="btn btn-info" onClick={() => actNight("seer_check")} disabled={busy}>查验身份</button> : null}
              {detail.humanRole === "witch" ? (
                <>
                  <div className="muted" style={{ fontSize: 12 }}>
                    今晚被刀目标：{detail.humanNightInfo.witchState?.pendingKill ? playerName(playersById.get(detail.humanNightInfo.witchState.pendingKill)) : "未知"}
                    ，解药：{detail.humanNightInfo.witchState?.healUsed ? "已用" : "可用"}，毒药：{detail.humanNightInfo.witchState?.poisonUsed ? "已用" : "可用"}
                  </div>
                  <button className="btn btn-success" onClick={() => actNight("witch_heal")} disabled={busy || !!detail.humanNightInfo.witchState?.healUsed}>使用解药</button>
                  <button className="btn btn-danger" onClick={() => actNight("witch_poison")} disabled={busy || !!detail.humanNightInfo.witchState?.poisonUsed}>使用毒药</button>
                  <button className="btn" onClick={() => actNight("witch_skip")} disabled={busy}>跳过夜晚</button>
                </>
              ) : null}
            </>
          ) : null}

          {isMySpeechTurn ? (
            <>
              <textarea className="input" rows={3} value={speechDraft} onChange={(e) => setSpeechDraft(e.target.value)} placeholder="输入白天发言" />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-primary" onClick={submitSpeech} disabled={busy || !speechDraft.trim()}>提交发言</button>
                <button
                  className="btn"
                  onClick={submitSkipSpeech}
                  disabled={busy || (detail.humanSpeechInfo.skipUsed >= detail.humanSpeechInfo.skipLimit)}
                >
                  跳过发言（{detail.humanSpeechInfo.skipUsed}/{detail.humanSpeechInfo.skipLimit}）
                </button>
              </div>
            </>
          ) : null}

          {isMyVoteTurn ? (
            <>
              <select className="input" value={voteTarget} onChange={(e) => setVoteTarget(e.target.value)}>
                {voteTargets.map((p) => <option key={p.agentId} value={p.agentId}>{playerName(p)}</option>)}
              </select>
              <input className="input" value={voteReason} onChange={(e) => setVoteReason(e.target.value)} placeholder="投票理由（可选）" />
              <button className="btn btn-primary" onClick={submitVote} disabled={busy || !voteTarget}>提交投票</button>
            </>
          ) : null}

          {!isMyNightTurn && !isMySpeechTurn && !isMyVoteTurn && detail.game.status !== "finished" ? <div className="muted">等待其他玩家行动...</div> : null}

          {detail.humanNightInfo.seerResult?.targetAgentId ? (
            <div className="muted" style={{ fontSize: 12 }}>
              预言家查验：{playerName(playersById.get(detail.humanNightInfo.seerResult.targetAgentId))} = {detail.humanNightInfo.seerResult.result}
            </div>
          ) : null}

          {detail.game.status === "finished" ? <button className="btn" onClick={loadReview} disabled={busy}>生成分析报告</button> : null}
          {error ? <div className="toast" style={{ margin: 0 }}>{error}</div> : null}

          {detail.reveal ? (
            <div className="game-panel">
              <div style={{ fontWeight: 700, marginBottom: 6 }}>身份揭晓</div>
              {detail.reveal.slice().sort((a, b) => a.seatNo - b.seatNo).map((p) => (
                <div key={p.agentId} style={{ fontSize: 13, color: p.role === "werewolf" ? "#fca5a5" : "#bbf7d0" }}>
                  玩家{p.seatNo}：{roleText(p.role)}
                </div>
              ))}
            </div>
          ) : null}

          {review ? (
            <div className="game-panel">
              <div style={{ fontWeight: 700, marginBottom: 6 }}>分析报告</div>
              <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12 }}>{JSON.stringify(review, null, 2)}</pre>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
