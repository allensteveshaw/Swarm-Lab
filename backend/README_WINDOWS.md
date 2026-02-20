# Swarm-IDE Backend (Windows)

## Quick Start (Node/npm)

```powershell
cd backend
copy .env.example .env.local
docker compose up -d
npm install
npm run dev:win
```

In a second terminal:

```powershell
npm run init-db:win
```

Open: `http://127.0.0.1:3017`

## Notes

- Built-in `bash` tool now auto-selects shell by platform.
  - Windows default: `powershell.exe`
  - Linux/macOS default: `/bin/bash`
- Override shell mode via `.env.local`:
  - `AGENT_SHELL_MODE=auto|powershell|cmd|bash`

## Multi-model

Use API endpoints to manage model profiles:

- `GET /api/model-profiles?workspaceId=...`
- `POST /api/model-profiles`
- `PATCH /api/model-profiles/:profileId`
- `DELETE /api/model-profiles/:profileId?workspaceId=...`
- `PATCH /api/agents/:agentId/model`

Providers:

- `glm`
- `openrouter`
- `openai_compatible` (local or cloud OpenAI-compatible endpoints)
