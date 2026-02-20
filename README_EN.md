# 🐝 Swarm Lab

**An open-source multi-agent experimentation platform** — build, orchestrate, observe, and game-simulate AI agent swarms in your browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js)](https://nodejs.org/)

[中文文档](README.md) · [Quick Start](#-quick-start) · [Architecture](#-architecture) · [Configuration](#-configuration)

---

## What is Swarm Lab?

Swarm Lab is a **full-stack experimental platform** for researching and building multi-agent AI systems. It provides a real-time collaborative workspace where multiple AI agents with different roles and model backends can chat, reason, delegate tasks, and even compete in social-deduction games — all observable through a live event stream and organization graph.

**Two main experiment tracks:**

| Track | Purpose |
|-------|---------|
| 🤝 **Collaboration** | Multi-agent group chat, task orchestration, spawning sub-agents, blueprint instantiation |
| 🎮 **Game Simulation** | Undercover (谁是卧底) and Werewolf (狼人杀) for strategy divergence research |

---

## ✨ Features

### Collaboration Center (`/im`)
- **Multi-agent group chat** — multiple AI agents with distinct roles communicate in a shared group
- **Public feed** — aggregate view across all groups in a workspace
- **Task orchestration** — template-driven tasks with start/stop, token budget controls, and anti-loop safeguards
- **Agent management** — create, stop, terminate, delete agents; batch assign model profiles
- **Sub-agent spawning** — agents can dynamically create child agents during task execution
- **Streaming output** — real-time SSE token streaming with live typing indicators
- **Multi-model support** — plug in GLM, OpenRouter, or any OpenAI-compatible endpoint per agent
- **Blueprint instantiation** — one-click deployment of preset swarm architectures (Debate, Paper Writing, Code Review, Product Design)

### Visualization
- **Organization graph** (`/graph`) — live topology of agents and their parent-child hierarchy
- **Viz canvas** (`/im`) — in-page force graph with animated message beams between nodes
- **Event stream** — real-time log of all inter-agent events

### Game Arena (`/undercover`, `/werewolf`)
- **Undercover** (谁是卧底) — 1 human + 5 AI, full turn-based rounds: speaking → voting → elimination
- **Werewolf** (狼人杀) — 6 players, night skills (wolf / seer / witch) + daytime speech and voting
- **AI strategies** — each AI agent uses a configurable reasoning strategy
- **Live circular table** — animated seat UI with speech bubbles, emotion states, and cinematic banners
- **Post-game review** — AI-generated analysis report with turning points and player stats

### Lab Dashboard (`/lab`)
- KPI cards: active agents, running tasks, message throughput, token footprint
- Charts: message trend, task stop reasons, model usage pie, game match count
- Recent workspaces with quick navigation

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (Next.js)                     │
│  /lab  /im  /blueprints  /graph  /undercover  /werewolf  │
└────────────────────┬────────────────────────────────────┘
                     │ SSE + REST
┌────────────────────▼────────────────────────────────────┐
│               Next.js API Routes (Node.js)               │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Agent       │  │  Task        │  │  Game Engine  │  │
│  │ Runtime     │  │  Orchestrator│  │  Undercover / │  │
│  │             │  │              │  │  Werewolf     │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                │                   │           │
│  ┌──────▼────────────────▼───────────────────▼───────┐  │
│  │            Event Bus  +  UI Bus (SSE push)         │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │  Storage Layer (Drizzle ORM)                       │  │
│  │  Workspaces / Groups / Messages / Agents / Tasks   │  │
│  └──────────┬────────────────────────────────────────┘  │
└─────────────┼───────────────────────────────────────────┘
              │
  ┌───────────▼────────────┐     ┌──────────────┐
  │  PostgreSQL 17          │     │  Redis 7     │
  │  (primary store)        │     │  (pub/sub)   │
  └────────────────────────┘     └──────────────┘
              │
  ┌───────────▼────────────────────────────────────────┐
  │  LLM Providers                                      │
  │  GLM · OpenRouter · OpenAI-compatible (Qwen, etc.)  │
  └────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 20+ |
| Docker + Docker Compose | any recent |
| npm | 10+ |

> **Windows users**: just double-click `start_swarm_lab.bat` — it handles everything automatically.

### Manual Setup (Windows / macOS / Linux)

**1. Clone & enter backend**
```bash
git clone https://github.com/YOUR_USERNAME/swarm-lab.git
cd swarm-lab/backend
```

**2. Install dependencies**
```bash
npm install
```

**3. Configure environment**
```bash
cp .env.example .env.local
# Edit .env.local — set your LLM API key and database URL
```

**4. Start database services**
```bash
docker compose up -d
```

**5. Start dev server**
```bash
# macOS / Linux
npm run dev

# Windows
npm run dev:win
```

**6. Initialize database schema**
```bash
curl -X POST http://localhost:3017/api/admin/init-db
```

**7. Open in browser**
```
http://localhost:3017/lab        ← Dashboard (recommended entry)
http://localhost:3017/im         ← Collaboration Center
http://localhost:3017/blueprints ← Blueprint Workshop
```

---

## ⚙️ Configuration

Copy `backend/.env.example` to `backend/.env.local` and fill in the required values:

```env
# ── Database ──────────────────────────────────────────────
DATABASE_URL=postgres://postgres:postgres@localhost:5432/agent_wechat
REDIS_URL=redis://localhost:6379

# ── LLM Provider ──────────────────────────────────────────
# Options: glm | openrouter | openai_compatible
LLM_PROVIDER=openai_compatible

# ── GLM (Zhipu AI) ────────────────────────────────────────
GLM_API_KEY=your_glm_key
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4-flash

# ── OpenRouter ────────────────────────────────────────────
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# ── OpenAI-Compatible (DashScope / local / any) ───────────
OPENAI_COMPAT_API_KEY=your_key
OPENAI_COMPAT_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_COMPAT_MODEL=qwen-max-latest

# ── Shell execution mode ──────────────────────────────────
# auto | powershell | cmd | bash
AGENT_SHELL_MODE=auto
```

You can mix providers — each agent can be assigned a different model profile via the UI.

---

## 📱 Pages & Routes

| Route | Description |
|-------|-------------|
| `/` | Home navigation |
| `/lab` | Dashboard — KPIs, charts, workspace list |
| `/im` | Collaboration Center — group chat, task runner, viz canvas |
| `/blueprints` | Blueprint Workshop — one-click swarm presets |
| `/graph` | Organization Graph — live agent topology |
| `/undercover` | Undercover lobby |
| `/undercover/[gameId]` | Undercover game room (table mode + classic mode) |
| `/werewolf` | Werewolf lobby |
| `/werewolf/[gameId]` | Werewolf game room |

---

## 🧩 Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, full-stack) |
| UI | React 19 + TypeScript 5 |
| Styling | Tailwind CSS 4 + custom CSS design tokens |
| Animation | Framer Motion 11 |
| Charts | Recharts 3 |
| Icons | Lucide React |
| Markdown | Streamdown |
| ORM | Drizzle ORM |
| Database | PostgreSQL 17 |
| Cache / PubSub | Redis 7 |
| Real-time | Server-Sent Events (SSE) |
| Protocol | MCP SDK (Model Context Protocol) |
| Validation | Zod |
| Package manager | npm / bun compatible |

---

## 📁 Project Structure

```
swarm-lab/
├── backend/                  ← Main Next.js application
│   ├── app/                  ← App Router pages & API routes
│   │   ├── api/              ← REST API handlers
│   │   ├── im/               ← Collaboration Center page
│   │   ├── lab/              ← Dashboard page
│   │   ├── blueprints/       ← Blueprint Workshop page
│   │   ├── graph/            ← Org graph page
│   │   ├── undercover/       ← Undercover game pages
│   │   ├── werewolf/         ← Werewolf game pages
│   │   └── globals.css       ← Global styles + design tokens
│   ├── src/
│   │   ├── runtime/          ← Agent runtime, Event Bus, UI Bus
│   │   ├── lib/              ← LLM client, storage, config, blueprints
│   │   ├── db/               ← Drizzle schema + DB client
│   │   └── game/             ← Game rule engines
│   ├── docker-compose.yml    ← PostgreSQL + Redis services
│   └── .env.example          ← Environment template
├── assets/                   ← Screenshots and media
├── .github/                  ← Issue templates + workflows
├── start_swarm_lab.bat       ← Windows one-click launcher
├── README.md                 ← Chinese documentation (default)
├── README_EN.md              ← This file (English)
└── LICENSE                   ← MIT License
```

---

## 📖 Blueprint Presets

Four ready-to-use swarm architectures are included:

| Blueprint | Agents | Use Case |
|-----------|--------|----------|
| **Debate** | Proposer + Opposer + Moderator | Structured argument generation |
| **Paper Writing** | Researcher + Writer + Reviewer | Academic content collaboration |
| **Code Review** | Developer + Senior + QA | Automated code quality review |
| **Product Design** | PM + Designer + Engineer | Product spec generation |

Each blueprint automatically creates a fresh workspace with pre-configured agents on launch.

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'feat: add your feature'`
4. Push to the branch: `git push origin feature/your-feature`
5. Open a Pull Request

---

## 🙏 Acknowledgments

This project is built upon **[Swarm-IDE](https://github.com/chmod777john/swarm-ide)** by [@chmod777john](https://github.com/chmod777john), which introduced the elegant minimal-primitive philosophy: an agent swarm needs only **create** + **send** to express any collaborative structure.

We extended Swarm-IDE with a full Lab dashboard, Blueprint workshop, game arena (Undercover & Werewolf), task orchestration, multi-model profiles, a comprehensive CSS design system, and complete Windows support.

→ See [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) for a full feature-by-feature comparison.

---

## 📄 License

[MIT](LICENSE) © Swarm Lab Contributors
