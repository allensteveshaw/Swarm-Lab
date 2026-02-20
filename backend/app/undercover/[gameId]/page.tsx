"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Game = {
  id: string;
  workspaceId: string;
  status: "running" | "finished";
  phase:
    | "waiting_human_join"
    | "round_speaking"
    | "round_voting"
    | "round_tiebreak_speaking"
    | "round_tiebreak_voting"
    | "round_elimination"
    | "game_over";
  roundNo: number;
  humanAgentId: string;
  currentTurnPlayerId: string | null;
  winnerSide: "civilian" | "undercover" | null;
  state: { tieCandidates: string[] };
};

type Player = {
  gameId: string;
  agentId: string;
  isHuman: boolean;
  role: "civilian" | "undercover";
  alive: boolean;
  seatNo: number;
  roleName: string;
  strategyKey: string | null;
  emotionState: string | null;
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
  humanRole: "civilian" | "undercover";
  humanWord: string;
  reveal: {
    topic: string;
    difficulty: "easy" | "normal" | "hard";
    civilianWord: string;
    undercoverWord: string;
    civilianHints: string[];
    undercoverHints: string[];
  } | null;
};

type LiveSpeech = { actorAgentId: string; text: string; done: boolean };
type BubbleState = { text: string; kind: "speech" | "vote" };
type ReviewReport = {
  summary?: Record<string, unknown>;
  turningPoints?: Array<{ roundNo: number; event: string; role: string; impact: string }>;
  playerStats?: Array<{
    seatNo: number;
    role: "civilian" | "undercover";
    alive: boolean;
    votesCast: number;
    votedUndercover: number;
    gotVotes: number;
  }>;
  narrative: string;
  createdAt: string;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text().catch(() => `${res.status}`));
  return (await res.json()) as T;
}

function playerName(p?: Player | null) {
  if (!p) return "未知玩家";
  return `玩家${p.seatNo}${p.isHuman ? "(你)" : ""}`;
}

function modeLink(gameId: string, mode: "classic" | "table") {
  return `/undercover/${encodeURIComponent(gameId)}?mode=${mode}`;
}

function roleText(role: Player["role"]) {
  return role === "undercover" ? "卧底" : "平民";
}

function roleColors(role: Player["role"]) {
  return role === "undercover"
    ? { border: "#ef4444", bg: "rgba(127,29,29,.35)", text: "#fecaca" }
    : { border: "#14b8a6", bg: "rgba(13,148,136,.28)", text: "#ccfbf1" };
}

export default function UndercoverGamePage() {
  const params = useParams<{ gameId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const gameId = params.gameId;
  const mode = search.get("mode") === "classic" ? "classic" : "table";

  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [liveSpeech, setLiveSpeech] = useState<LiveSpeech | null>(null);
  const [lastSpeechById, setLastSpeechById] = useState<Record<string, string>>({});
  const [lastBubbleById, setLastBubbleById] = useState<Record<string, BubbleState>>({});
  const lastSpeechRef = useRef<Record<string, string>>({});
  const playersRef = useRef<Player[]>([]);
  const [emotionById, setEmotionById] = useState<Record<string, string>>({});
  const [activeTurnAgentId, setActiveTurnAgentId] = useState<string | null>(null);
  const [speechDraft, setSpeechDraft] = useState("");
  const [voteTarget, setVoteTarget] = useState("");
  const [voteReason, setVoteReason] = useState("");
  const [review, setReview] = useState<ReviewReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [centerBanner, setCenterBanner] = useState<{ text: string; tone: "phase" | "warn" | "win" } | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const bannerTimerRef = useRef<number | null>(null);
  const gameMetaRef = useRef<{ roundNo: number; phase: Game["phase"] | string }>({ roundNo: 0, phase: "round_speaking" });

  const showCenterBanner = useCallback((text: string, tone: "phase" | "warn" | "win" = "phase", durationMs = 1500) => {
    setCenterBanner({ text, tone });
    if (bannerTimerRef.current !== null) window.clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = window.setTimeout(() => {
      setCenterBanner(null);
      bannerTimerRef.current = null;
    }, durationMs);
  }, []);

  const load = useCallback(async () => {
    const [g, e] = await Promise.all([
      api<GameDetail>(`/api/undercover/games/${encodeURIComponent(gameId)}`),
      api<{ events: EventItem[] }>(`/api/undercover/games/${encodeURIComponent(gameId)}/events`),
    ]);
    setDetail(g);
    setEvents(e.events);
    playersRef.current = g.players;
    const playerMap = new Map(g.players.map((p) => [p.agentId, p]));
    const tieSet = new Set(g.game.state.tieCandidates ?? []);
    const speeches = e.events.filter((x) => x.eventType === "speech");
    const nextLastSpeech: Record<string, string> = {};
    const nextBubbles: Record<string, BubbleState> = {};
    for (const ev of speeches) {
      const aid = ev.actorAgentId ?? "";
      const text = String(ev.payload?.text ?? "");
      if (aid && text) {
        nextLastSpeech[aid] = text;
        nextBubbles[aid] = { text, kind: "speech" };
      }
    }
    if (g.game.phase === "round_voting" || g.game.phase === "round_tiebreak_voting" || g.game.phase === "round_elimination") {
      for (const ev of e.events.filter((x) => x.eventType === "vote" && x.roundNo === g.game.roundNo)) {
        const aid = ev.actorAgentId ?? "";
        const target = ev.targetAgentId ? playerMap.get(ev.targetAgentId) : null;
        if (aid) nextBubbles[aid] = { text: `投给 ${playerName(target)}`, kind: "vote" };
      }
    }
    if (g.game.phase === "round_tiebreak_speaking" && tieSet.size > 0) {
      const tieBubbles: Record<string, BubbleState> = {};
      const tiebreakSpeeches = e.events.filter(
        (x) => x.eventType === "speech" && x.roundNo === g.game.roundNo && tieSet.has(String(x.actorAgentId ?? ""))
      );
      for (const ev of tiebreakSpeeches) {
        const aid = ev.actorAgentId ?? "";
        const text = String(ev.payload?.text ?? "");
        if (aid && text) tieBubbles[aid] = { text, kind: "speech" };
      }
      for (const aid of tieSet) {
        if (!tieBubbles[aid] && nextLastSpeech[aid]) tieBubbles[aid] = { text: nextLastSpeech[aid]!, kind: "speech" };
      }
      Object.keys(nextBubbles).forEach((k) => delete nextBubbles[k]);
      Object.assign(nextBubbles, tieBubbles);
    }
    setLastSpeechById(nextLastSpeech);
    lastSpeechRef.current = nextLastSpeech;
    setLastBubbleById(nextBubbles);
    setActiveTurnAgentId((prev) => prev ?? g.game.currentTurnPlayerId);
  }, [gameId]);

  const appendLocalEvent = useCallback((event: EventItem) => {
    setEvents((prev) => {
      const duplicate = prev.some((x) =>
        x.eventType === event.eventType &&
        x.roundNo === event.roundNo &&
        x.actorAgentId === event.actorAgentId &&
        x.targetAgentId === event.targetAgentId &&
        JSON.stringify(x.payload) === JSON.stringify(event.payload)
      );
      if (duplicate) return prev;
      const next = [...prev, event];
      return next.slice(-220);
    });
  }, []);

  const scheduleLoad = useCallback((delayMs = 220) => {
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void load().catch(() => undefined);
    }, delayMs);
  }, [load]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void load().catch((e) => setError(String(e))).finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    playersRef.current = detail?.players ?? [];
    if (detail?.game) gameMetaRef.current = { roundNo: detail.game.roundNo, phase: detail.game.phase };
  }, [detail]);

  useEffect(() => {
    const es = new EventSource(`/api/undercover/stream?gameId=${encodeURIComponent(gameId)}`);
    es.onopen = () => setSseConnected(true);
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as { event?: string; data?: Record<string, unknown> };
        const evt = parsed.event ?? "";
        const data = parsed.data ?? {};
        if (evt === "ui.undercover.speech_delta") {
          const aid = String(data.actorAgentId ?? "");
          const text = String(data.text ?? "");
          const done = Boolean(data.done);
          setLiveSpeech({ actorAgentId: aid, text, done });
          if (aid && text) {
            setLastSpeechById((prev) => ({ ...prev, [aid]: text }));
            lastSpeechRef.current = { ...lastSpeechRef.current, [aid]: text };
            setLastBubbleById((prev) => ({ ...prev, [aid]: { text, kind: "speech" } }));
          }
          if (done) {
            appendLocalEvent({
              id: `live-speech-${Date.now()}-${aid}`,
              roundNo: Number(data.roundNo ?? gameMetaRef.current.roundNo ?? 0),
              phase: String(data.phase ?? gameMetaRef.current.phase ?? "round_speaking"),
              eventType: "speech",
              actorAgentId: aid || null,
              targetAgentId: null,
              payload: { text },
              createdAt: new Date().toISOString(),
            });
            window.setTimeout(() => setLiveSpeech(null), 900);
          }
          return;
        }
        if (evt === "ui.undercover.emotion_update") {
          const aid = String(data.agentId ?? "");
          const emotion = String(data.emotion ?? "neutral");
          if (aid) setEmotionById((prev) => ({ ...prev, [aid]: emotion }));
          return;
        }
        if (evt === "ui.undercover.turn_start") {
          setActiveTurnAgentId(String(data.actorAgentId ?? "") || null);
          return;
        }
        if (evt === "ui.undercover.turn_end") {
          setActiveTurnAgentId(null);
          return;
        }
        if (evt === "ui.undercover.vote_reveal") {
          const actor = String(data.actorAgentId ?? "");
          const target = String(data.targetAgentId ?? "");
          const reason = String(data.reason ?? "");
          const targetPlayer = playersRef.current.find((p) => p.agentId === target);
          if (actor) setLastBubbleById((prev) => ({ ...prev, [actor]: { text: `投给 ${playerName(targetPlayer)}`, kind: "vote" } }));
          appendLocalEvent({
            id: `live-vote-${Date.now()}-${actor}`,
            roundNo: Number(data.roundNo ?? gameMetaRef.current.roundNo ?? 0),
            phase: String(gameMetaRef.current.phase ?? "round_voting"),
            eventType: "vote",
            actorAgentId: actor || null,
            targetAgentId: target || null,
            payload: { reason, isTiebreak: gameMetaRef.current.phase === "round_tiebreak_voting" },
            createdAt: new Date().toISOString(),
          });
          return;
        }
        if (evt === "ui.undercover.phase_change") {
          const to = String(data.to ?? "");
          const nextRoundNo = Number(data.roundNo ?? gameMetaRef.current.roundNo);
          gameMetaRef.current = { roundNo: nextRoundNo, phase: to || gameMetaRef.current.phase };
          if (to === "round_speaking" || to === "round_tiebreak_speaking") {
            setLastBubbleById((prev) => {
              const next: Record<string, BubbleState> = {};
              for (const [aid, bubble] of Object.entries(prev)) {
                if (bubble.kind === "speech") { next[aid] = bubble; continue; }
                const lastSpeech = lastSpeechRef.current[aid];
                if (lastSpeech) next[aid] = { text: lastSpeech, kind: "speech" };
              }
              return next;
            });
          }
          if (to === "round_voting") showCenterBanner("投票阶段开始", "phase");
          else if (to === "round_tiebreak_voting") showCenterBanner("平票加赛投票", "warn");
          else if (to === "round_elimination") showCenterBanner("正在公布淘汰结果", "warn");
          else if (to === "round_speaking") {
            const roundNo = Number(data.roundNo ?? 0);
            showCenterBanner(roundNo > 0 ? `第 ${roundNo} 轮发言` : "发言阶段开始", "phase");
          }
          scheduleLoad(140);
          return;
        }
        if (evt === "ui.undercover.elimination") {
          const eliminatedAgentId = String(data.eliminatedAgentId ?? data.actorAgentId ?? "");
          const eliminated = playersRef.current.find((p) => p.agentId === eliminatedAgentId);
          showCenterBanner(`${playerName(eliminated)} 出局`, "warn", 1800);
          scheduleLoad(140);
          return;
        }
        if (evt === "ui.undercover.game_over") {
          const payload = (data.payload ?? {}) as Record<string, unknown>;
          const winner = String(data.winner ?? payload.winner ?? "");
          showCenterBanner(winner === "civilian" ? "平民阵营胜利" : "卧底阵营胜利", "win", 2200);
          scheduleLoad(140);
          return;
        }
        if (evt === "ui.undercover.gm_notice") {
          const payload = (data.payload ?? {}) as Record<string, unknown>;
          const message = String(data.message ?? payload.message ?? "");
          const level = String(data.level ?? payload.level ?? "info");
          if (message) {
            appendLocalEvent({
              id: `gm-${Date.now()}`,
              roundNo: Number(data.roundNo ?? gameMetaRef.current.roundNo ?? 0),
              phase: String(data.phase ?? gameMetaRef.current.phase ?? "round_speaking"),
              eventType: "gm_notice",
              actorAgentId: null,
              targetAgentId: null,
              payload: { message, level, code: String(data.code ?? payload.code ?? "") },
              createdAt: new Date().toISOString(),
            });
            if (level === "warn") showCenterBanner("GM：检测到违规", "warn", 1800);
          }
          return;
        }
      } catch {
        // ignore
      }
      scheduleLoad(220);
    };
    es.onerror = () => {
      setSseConnected(false);
      es.close();
    };
    return () => {
      setSseConnected(false);
      es.close();
    };
  }, [appendLocalEvent, gameId, scheduleLoad, showCenterBanner]);

  useEffect(() => {
    return () => {
      if (bannerTimerRef.current !== null) window.clearTimeout(bannerTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (sseConnected) return;
    const t = window.setInterval(() => void load().catch(() => undefined), 7000);
    return () => window.clearInterval(t);
  }, [load, sseConnected]);

  const playersById = useMemo(() => {
    const map = new Map<string, Player>();
    for (const p of detail?.players ?? []) map.set(p.agentId, p);
    return map;
  }, [detail?.players]);

  const myAgentId = detail?.game.humanAgentId ?? "";
  const isMySpeakTurn =
    !!detail &&
    (detail.game.phase === "round_speaking" || detail.game.phase === "round_tiebreak_speaking") &&
    detail.game.currentTurnPlayerId === myAgentId;
  const isMyVoteTurn =
    !!detail &&
    (detail.game.phase === "round_voting" || detail.game.phase === "round_tiebreak_voting") &&
    detail.game.currentTurnPlayerId === myAgentId;

  const validVoteTargets = useMemo(() => {
    if (!detail) return [] as Player[];
    if (detail.game.phase === "round_tiebreak_voting") {
      return detail.players.filter(
        (p) => p.alive && p.agentId !== myAgentId && detail.game.state.tieCandidates.includes(p.agentId)
      );
    }
    return detail.players.filter((p) => p.alive && p.agentId !== myAgentId);
  }, [detail, myAgentId]);

  useEffect(() => {
    if (!voteTarget && validVoteTargets[0]) setVoteTarget(validVoteTargets[0].agentId);
  }, [validVoteTargets, voteTarget]);

  async function submitSpeech() {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/undercover/games/${encodeURIComponent(gameId)}/human/speech`, {
        method: "POST",
        body: JSON.stringify({ actorAgentId: myAgentId, text: speechDraft }),
      });
      setSpeechDraft("");
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
      await api(`/api/undercover/games/${encodeURIComponent(gameId)}/human/vote`, {
        method: "POST",
        body: JSON.stringify({ voterAgentId: myAgentId, targetAgentId: voteTarget, reason: voteReason }),
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
      setReview(await api(`/api/undercover/games/${encodeURIComponent(gameId)}/review`));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return (
    <main className="game-root undercover">
      <div className="game-container" style={{ maxWidth: 1280 }}>
        <div className="skeleton skeleton-card" style={{ height: 80 }} />
        <div className="skeleton skeleton-card" style={{ height: 400 }} />
        <div className="skeleton skeleton-card" style={{ height: 120 }} />
      </div>
    </main>
  );
  if (!detail) return (
    <main className="game-root undercover">
      <div className="game-container" style={{ maxWidth: 1280 }}>
        <div className="lab-empty"><div className="lab-empty-icon" style={{ fontSize: 24 }}>?</div><div>Game not found.</div></div>
      </div>
    </main>
  );

  return (
    <main className="game-root undercover">
      <div className="game-container" style={{ maxWidth: 1280 }}>
        <section className="game-header">
          <div>
            <div className="mono muted" style={{ fontSize: 12 }}>Game {detail.game.id.slice(0, 8)}...</div>
            <div style={{ marginTop: 4, fontWeight: 700 }}>Round {detail.game.roundNo} | {detail.game.phase}</div>
            <div className="muted" style={{ marginTop: 6 }}>Your role: {detail.humanRole} | Your word: {detail.humanWord}</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Link className="btn" href="/undercover">Lobby</Link>
            <button className="btn" onClick={() => router.push(`/im?workspaceId=${encodeURIComponent(detail.game.workspaceId)}`)}>Open Collaboration Center</button>
            <Link className={mode === "table" ? "btn btn-primary" : "btn"} href={modeLink(gameId, "table")}>Table Mode</Link>
            <Link className={mode === "classic" ? "btn btn-primary" : "btn"} href={modeLink(gameId, "classic")}>Classic Mode</Link>
          </div>
        </section>

        {mode === "table" ? (
          <TableMode
            detail={detail}
            events={events}
            liveSpeech={liveSpeech}
            lastBubbleById={lastBubbleById}
            emotionById={emotionById}
            activeTurnAgentId={activeTurnAgentId}
            playersById={playersById}
            centerBanner={centerBanner}
          />
        ) : (
          <ClassicMode detail={detail} events={events} playersById={playersById} />
        )}

        {detail.game.status === "finished" ? (
          <section className="game-actions">
            <div style={{ fontWeight: 800, fontSize: 18 }}>身份揭晓</div>
            {detail.reveal ? (
              <div className="game-panel" style={{ display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 700 }}>
                  主题：{detail.reveal.topic} | 难度：{detail.reveal.difficulty}
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ padding: "4px 8px", borderRadius: 8, background: "rgba(20,184,166,.2)", border: "1px solid #14b8a6" }}>
                    平民词：{detail.reveal.civilianWord}
                  </span>
                  <span style={{ padding: "4px 8px", borderRadius: 8, background: "rgba(239,68,68,.2)", border: "1px solid #ef4444" }}>
                    卧底词：{detail.reveal.undercoverWord}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "#fca5a5" }}>
                  卧底提示词：{detail.reveal.undercoverHints.join(" / ") || "-"}
                </div>
              </div>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10 }}>
              {detail.players
                .slice()
                .sort((a, b) => a.seatNo - b.seatNo)
                .map((p) => {
                  const c = roleColors(p.role);
                  return (
                    <div key={p.agentId} style={{ border: `1px solid ${c.border}`, background: c.bg, borderRadius: 12, padding: 10 }}>
                      <div style={{ fontWeight: 700 }}>{playerName(p)}</div>
                      <div style={{ marginTop: 6, color: c.text, fontWeight: 700 }}>{roleText(p.role)}</div>
                      <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>{p.alive ? "存活" : "已出局"}</div>
                    </div>
                  );
                })}
            </div>
          </section>
        ) : null}

        <section className="game-actions">
          <div style={{ fontWeight: 700 }}>Your Action</div>
          {isMySpeakTurn ? (
            <>
              <textarea className="input" rows={3} value={speechDraft} onChange={(e) => setSpeechDraft(e.target.value)} placeholder="1-2句中文描述，不要直接说词" />
              <button className="btn btn-primary" disabled={busy || !speechDraft.trim()} onClick={submitSpeech}>Submit Speech</button>
            </>
          ) : null}
          {isMyVoteTurn ? (
            <>
              <select className="input" value={voteTarget} onChange={(e) => setVoteTarget(e.target.value)}>
                {validVoteTargets.map((p) => <option key={p.agentId} value={p.agentId}>{playerName(p)}</option>)}
              </select>
              <input className="input" value={voteReason} onChange={(e) => setVoteReason(e.target.value)} placeholder="一句理由（可选）" />
              <button className="btn btn-primary" disabled={busy || !voteTarget} onClick={submitVote}>Submit Vote</button>
            </>
          ) : null}
          {!isMySpeakTurn && !isMyVoteTurn && detail.game.status !== "finished" ? <div className="muted">Waiting other players...</div> : null}
          {detail.game.status === "finished" ? <button className="btn" onClick={loadReview} disabled={busy}>生成分析报告</button> : null}
          {error ? <div className="toast" style={{ margin: 0 }}>{error}</div> : null}
          {review ? (
            <div className="game-panel" style={{ display: "grid", gap: 8 }}>
              <div style={{ fontWeight: 800 }}>对局分析报告</div>
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{review.narrative}</div>
              {Array.isArray(review.turningPoints) && review.turningPoints.length > 0 ? (
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontWeight: 700 }}>关键转折点</div>
                  {review.turningPoints.map((t, idx) => (
                    <div key={`${t.roundNo}-${idx}`} className="game-panel" style={{ padding: 8 }}>
                      <div style={{ fontWeight: 700 }}>{t.event}</div>
                      <div className="muted">{t.impact}</div>
                    </div>
                  ))}
                </div>
              ) : null}
              {Array.isArray(review.playerStats) && review.playerStats.length > 0 ? (
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontWeight: 700 }}>玩家数据</div>
                  <div style={{ display: "grid", gap: 4 }}>
                    {review.playerStats
                      .slice()
                      .sort((a, b) => a.seatNo - b.seatNo)
                      .map((p) => (
                        <div key={p.seatNo} style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 13 }}>
                          <span style={{ fontWeight: 700 }}>玩家{p.seatNo}</span>
                          <span className="muted">身份：{p.role === "undercover" ? "卧底" : "平民"}</span>
                          <span className="muted">投票次数：{p.votesCast}</span>
                          <span className="muted">命中卧底：{p.votedUndercover}</span>
                          <span className="muted">被投次数：{p.gotVotes}</span>
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function ClassicMode({ detail, events, playersById }: { detail: GameDetail; events: EventItem[]; playersById: Map<string, Player> }) {
  return (
    <section className="game-board">
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Round Log</div>
      <div style={{ maxHeight: 420, overflow: "auto", display: "grid", gap: 8 }}>
        {events.map((e) => (
          <div key={e.id} className="game-panel" style={{ padding: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div>R{e.roundNo} | {e.eventType}</div>
              <div className="muted">{new Date(e.createdAt).toLocaleTimeString()}</div>
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              actor: {e.actorAgentId ? playerName(playersById.get(e.actorAgentId)) : "-"}
              {" | "}target: {e.targetAgentId ? playerName(playersById.get(e.targetAgentId)) : "-"}
            </div>
            <div style={{ marginTop: 4 }}>{JSON.stringify(e.payload)}</div>
          </div>
        ))}
      </div>
      <div className="muted" style={{ marginTop: 8 }}>Winner: {detail.game.winnerSide ?? "-"}</div>
    </section>
  );
}

function TableMode(input: {
  detail: GameDetail;
  events: EventItem[];
  liveSpeech: LiveSpeech | null;
  lastBubbleById: Record<string, BubbleState>;
  emotionById: Record<string, string>;
  activeTurnAgentId: string | null;
  playersById: Map<string, Player>;
  centerBanner: { text: string; tone: "phase" | "warn" | "win" } | null;
}) {
  const { detail, events, liveSpeech, lastBubbleById, emotionById, activeTurnAgentId, playersById, centerBanner } = input;
  const liveSpeaker = liveSpeech?.actorAgentId ? playersById.get(liveSpeech.actorAgentId) : null;
  const gameLogs = events.filter((e) => e.eventType === "speech" || e.eventType === "vote" || e.eventType === "gm_notice").slice(-32);

  return (
    <section className="game-board">
      <div className="game-board-inner">
        <div className="game-table-wrap">
          <div className="game-table">
            {centerBanner ? (
              <div className={`game-banner ${centerBanner.tone}`}>
                {centerBanner.text}
              </div>
            ) : null}
            <div className="game-center">
              <div style={{ textAlign: "center" }}>
                <div style={{ fontWeight: 700 }}>Round {detail.game.roundNo}</div>
                <div className="muted" style={{ fontSize: 12 }}>{detail.game.phase}</div>
              </div>
            </div>
            {detail.players.map((p, idx) => {
              const angle = (Math.PI * 2 * idx) / detail.players.length - Math.PI / 2;
              const radius = 41;
              const x = 50 + radius * Math.cos(angle);
              const y = 50 + radius * Math.sin(angle);
              const emotion = emotionById[p.agentId] ?? p.emotionState ?? "neutral";
              const active = activeTurnAgentId === p.agentId || detail.game.currentTurnPlayerId === p.agentId;
              const speaking = liveSpeech?.actorAgentId === p.agentId;
              const eliminated = !p.alive;
              const bubble = lastBubbleById[p.agentId];
              const inTiebreak = detail.game.phase === "round_tiebreak_speaking" || detail.game.phase === "round_tiebreak_voting";
              const isTieCandidate = detail.game.state.tieCandidates.includes(p.agentId);
              const emotionColor =
                emotion === "speaking" ? "#22d3ee"
                  : emotion === "thinking" ? "#818cf8"
                  : emotion === "suspicious" ? "#fb7185"
                  : emotion === "eliminated" ? "#64748b"
                  : "#475569";
              const seatBg =
                emotion === "speaking" ? "linear-gradient(160deg,#082f49,#0c4a6e)"
                  : emotion === "thinking" ? "linear-gradient(160deg,#312e81,#1e1b4b)"
                  : emotion === "suspicious" ? "linear-gradient(160deg,#4c0519,#7f1d1d)"
                  : "var(--surface-1)";
              const seatClasses = [
                "game-seat",
                speaking ? "speaking" : "",
                active || (inTiebreak && isTieCandidate) ? "active" : "",
                eliminated ? "eliminated" : "",
              ].filter(Boolean).join(" ");

              return (
                <div
                  key={p.agentId}
                  className={`game-seat-wrap${eliminated ? " eliminated" : ""}`}
                  style={{ left: `${x}%`, top: `${y}%` }}
                >
                  {bubble ? (
                    <div className={`game-bubble${bubble.kind === "vote" ? " vote" : ""}`}
                      style={{
                        boxShadow: speaking
                          ? "0 0 18px rgba(34,211,238,.35)"
                          : inTiebreak && isTieCandidate
                            ? "0 0 18px rgba(245,158,11,.35)"
                            : "none",
                      }}
                    >
                      {bubble.text}
                    </div>
                  ) : null}
                  <div
                    className={seatClasses}
                    style={{
                      width: 74, height: 74,
                      borderColor: active ? "#f59e0b" : inTiebreak && isTieCandidate ? "#f59e0b" : emotionColor,
                      background: seatBg,
                      boxShadow: speaking ? "0 0 26px rgba(34,211,238,.5)" : active ? "0 0 20px rgba(245,158,11,.35)" : inTiebreak && isTieCandidate ? "0 0 20px rgba(245,158,11,.32)" : `0 0 18px ${emotionColor}33`,
                      animation: speaking ? "seatPulse 900ms ease-in-out infinite" : emotion === "thinking" ? "thinkPulse 1400ms ease-in-out infinite" : emotion === "suspicious" ? "warnPulse 1200ms ease-in-out infinite" : "none",
                    }}
                  >
                    <div style={{ position: "relative", width: 36, height: 36, display: "grid", placeItems: "center" }}>
                      <span style={{ fontSize: 28 }}>{p.isHuman ? "🙂" : "🤖"}</span>
                      <div
                        style={{
                          position: "absolute",
                          bottom: 2,
                          width: speaking ? 14 : 10,
                          height: speaking ? 5 : 2,
                          borderRadius: 999,
                          background: "#e2e8f0",
                          animation: speaking ? "mouthTalk 300ms ease-in-out infinite alternate" : "none",
                        }}
                      />
                    </div>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700 }}>{playerName(p)}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{emotion}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="game-sidebar">
          <div className="game-panel">
            <div style={{ fontWeight: 700 }}>Live Speech</div>
            {liveSpeech ? (
              <div style={{ marginTop: 8 }}>
                <div className="muted">Speaker: {playerName(liveSpeaker)}</div>
                <div style={{ marginTop: 6, lineHeight: 1.6 }}>{liveSpeech.text}</div>
              </div>
            ) : (
              <div className="muted" style={{ marginTop: 8 }}>Waiting...</div>
            )}
          </div>

          <div className="game-panel game-panel-scroll">
            <div style={{ fontWeight: 700, marginBottom: 8 }}>聊天记录</div>
            {gameLogs.map((e) => (
              <div key={e.id} style={{ borderBottom: "1px solid var(--border-default)", padding: "6px 0" }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>
                  {e.eventType === "gm_notice" ? "GM" : playerName(e.actorAgentId ? playersById.get(e.actorAgentId) : undefined)}
                </div>
                {e.eventType === "speech" ? (
                  <div style={{ fontSize: 12, marginTop: 4 }}>{String(e.payload?.text ?? "")}</div>
                ) : e.eventType === "gm_notice" ? (
                  <div style={{ fontSize: 12, marginTop: 4, color: "#fda4af" }}>
                    {String(e.payload?.message ?? "GM提示")}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    投票给 {playerName(e.targetAgentId ? playersById.get(e.targetAgentId) : undefined)}
                    {String(e.payload?.reason ?? "").trim() ? `，理由：${String(e.payload?.reason ?? "")}` : ""}
                  </div>
                )}
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{new Date(e.createdAt).toLocaleTimeString()}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
