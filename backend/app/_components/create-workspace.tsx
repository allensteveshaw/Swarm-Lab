"use client";

import { useState } from "react";

type WorkspaceDefaults = {
  workspaceId: string;
  humanAgentId: string;
  assistantAgentId: string;
  defaultGroupId: string;
};

export default function CreateWorkspace() {
  const [name, setName] = useState("New Workspace");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCreate() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${text}`);
      const data = JSON.parse(text) as WorkspaceDefaults;
      window.location.href = `/im?workspaceId=${encodeURIComponent(data.workspaceId)}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <input
        className="input"
        style={{ maxWidth: 320 }}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Workspace name"
        disabled={busy}
      />
      <button className="btn btn-primary" onClick={() => void onCreate()} disabled={busy}>
        Create
      </button>
      {error ? (
        <span className="muted" style={{ color: "#fecaca", fontSize: 13 }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

