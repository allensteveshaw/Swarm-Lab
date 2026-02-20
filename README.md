# 🐝 Swarm Lab — 多智能体实验平台

<p align="center">
  <img src="assets/bee.jpg" alt="Swarm Lab" width="360" />
</p>

**开源的多 AI Agent 实验与协作平台** — 在浏览器中构建、编排、观察和博弈 AI 蜂群。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js)](https://nodejs.org/)

[English](README_EN.md) · [快速开始](#-快速开始) · [架构设计](#-架构设计) · [配置说明](#-配置说明)

📺 [演示视频（B站）](https://www.bilibili.com/video/BV1FNf5BpEig/) · 📝 [开发全记录（CSDN）](https://blog.csdn.net/2301_80881806/article/details/158239547)

---

## 项目简介

Swarm Lab 是一个**全栈多智能体实验平台**，专为研究和构建 AI 蜂群系统而设计。平台提供实时协作工作区，支持多个具备不同角色和模型后端的 AI Agent 进行群聊、推理、任务委派，以及参与社交推理游戏——所有过程均可通过实时事件流和组织关系图谱进行观察。

**两条核心实验路线：**

| 实验路线 | 研究方向 |
|---------|---------|
| 🤝 **协作实验** | 多 Agent 群聊、任务编排、子 Agent 派生、蓝图一键实例化 |
| 🎮 **博弈实验** | 谁是卧底、狼人杀——用于多智能体策略差异性验证 |

---

## ✨ 核心功能

### 消息协作中心（`/im`）
- **多 Agent 群聊** — 不同角色的 AI Agent 在共享群组中进行对话协作
- **公屏聚合** — 跨群组的消息统一视图，便于全局观察
- **任务编排系统** — 模板驱动的任务执行，支持启动/停止、Token 预算控制、防死循环保护
- **Agent 管理** — 创建、停止、终止、删除 Agent；批量分配模型配置
- **子 Agent 派生** — Agent 可在任务执行中动态创建子 Agent，构建组织树
- **流式输出** — SSE 实时 Token 流，带动态打字动画
- **多模型接入** — 每个 Agent 可独立配置 GLM、OpenRouter 或任意 OpenAI 兼容接口
- **蓝图实例化** — 一键部署预设蜂群架构（辩论、论文写作、代码评审、产品设计）

### 可视化
- **组织关系图谱**（`/graph`）— Agent 父子层级的实时拓扑图
- **Viz 画布**（`/im` 内嵌）— 带消息光束动画的力导向关系图
- **事件流** — 所有 Agent 间事件的实时日志

### 游戏实验场（`/undercover`、`/werewolf`）
- **谁是卧底** — 1 人类 + 5 AI，完整回合制：发言 → 投票 → 淘汰
- **狼人杀** — 6 人局，夜晚技能（狼人/预言家/女巫）+ 白天发言投票
- **AI 策略引擎** — 每个 AI Agent 使用可配置的推理策略
- **圆桌动画界面** — 带语音气泡、情绪状态和电影级横幅的座位动画
- **赛后分析报告** — AI 生成的对局分析，包含关键转折点和玩家数据

### 实验室大厅（`/lab`）
- KPI 卡片：活跃 Agent 数、运行中任务、消息吞吐量、Token 消耗
- 图表：消息趋势、任务终止原因、模型使用占比、游戏场次统计
- 近期工作区快速导航

---

## 🏗 架构设计

<p align="center">
  <img src="assets/struct.jpg" alt="Architecture" width="720" />
</p>

---

## 🚀 快速开始

### 第一步：确认环境依赖

运行前请先确认本机已安装以下工具：

| 工具 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | 20+ | [下载地址](https://nodejs.org/) |
| Docker Desktop | 任意近期版本 | [下载地址](https://www.docker.com/products/docker-desktop/)，用于启动 PostgreSQL 和 Redis |
| npm | 10+ | 随 Node.js 自动安装 |

> **Windows 用户一键启动：** 如果不想手动配置，直接双击项目根目录的 `start_swarm_lab.bat`，脚本会自动完成后续所有步骤。

---

### 第二步：克隆仓库

```bash
git clone https://github.com/YOUR_USERNAME/swarm-lab.git
cd swarm-lab/backend
```

---

### 第三步：安装依赖

```bash
npm install
```

> 国内网络如遇超时，可先设置镜像源：
> ```bash
> npm config set registry https://registry.npmmirror.com
> ```

---

### 第四步：配置环境变量

复制模板文件：

```bash
# macOS / Linux
cp .env.example .env.local
cp mcp.json.example mcp.json   # MCP 工具配置（可选，填入对应 API Key）

# Windows（PowerShell）
Copy-Item .env.example .env.local
Copy-Item mcp.json.example mcp.json
```

用编辑器打开 `.env.local`，按以下说明逐项填写：

```env
# ── 数据库（保持默认即可，与 docker-compose 配置对应）────────────
DATABASE_URL=postgres://postgres:postgres@localhost:5432/agent_wechat
REDIS_URL=redis://localhost:6379

# ── 默认 LLM 提供商（选填一个）───────────────────────────────────
# 可选值：glm | openrouter | openai_compatible
LLM_PROVIDER=openai_compatible

# ── 方案 A：GLM（智谱 AI）─────────────────────────────────────────
# 申请地址：https://open.bigmodel.cn/
GLM_API_KEY=你的_glm_api_key
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4/chat/completions
GLM_MODEL=glm-5

# ── 方案 B：OpenRouter────────────────────────────────────────────
# 申请地址：https://openrouter.ai/
OPENROUTER_API_KEY=你的_openrouter_api_key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1/chat/completions
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
OPENROUTER_HTTP_REFERER=
OPENROUTER_APP_TITLE=SwarmLab

# ── 方案 C：OpenAI 兼容接口（通义千问 / 本地部署 / 其他）────────
# 通义千问申请地址：https://dashscope.console.aliyun.com/
OPENAI_COMPAT_API_KEY=你的_api_key
OPENAI_COMPAT_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_COMPAT_MODEL=qwen-max-latest
OPENAI_COMPAT_HEADERS={}

# ── Shell 执行模式（一般不需要修改）────────────────────────────
# auto | powershell | cmd | bash
AGENT_SHELL_MODE=auto
```

**说明：** 三种 LLM 方案可同时配置，每个 Agent 在 UI 中可独立选择使用哪个模型配置。

---

### 第五步：启动数据库服务

确保 Docker Desktop 已运行，然后执行：

```bash
docker compose up -d
```

启动后会在后台运行 PostgreSQL（端口 5432）和 Redis（端口 6379）两个容器。

验证容器正常运行：

```bash
docker compose ps
```

正常状态下两个服务均应显示 `running`。

---

### 第六步：启动开发服务器

```bash
# macOS / Linux
npm run dev

# Windows
npm run dev:win
```

看到类似以下输出即表示启动成功：

```
▲ Next.js 16.x.x
- Local: http://127.0.0.1:3017
✓ Ready in 2.3s
```

---

### 第七步：初始化数据库表结构

**第一次运行时必须执行此步骤**，之后重启无需重复。

```bash
# macOS / Linux
curl -X POST http://localhost:3017/api/admin/init-db

# Windows（PowerShell）
npm run init-db:win
```

返回 `{"ok":true}` 即初始化成功。

---

### 第八步：打开浏览器

```
http://localhost:3017/lab        ← 实验室大厅（推荐入口，查看整体状态）
http://localhost:3017/im         ← 消息协作中心（Agent 群聊与任务）
http://localhost:3017/blueprints ← 蓝图工坊（一键部署预设蜂群）
```

> 推荐从 `/lab` 进入，点击「新建工作区」，再前往 `/im` 开始实验。

---

## ⚙️ 配置说明

### LLM 提供商对比

| 提供商 | 特点 | 适用场景 |
|--------|------|---------|
| **GLM（智谱）** | 国内直连，无需梯子 | 国内用户首选，有免费额度 |
| **OpenRouter** | 统一接入 100+ 模型 | 想切换不同模型对比效果 |
| **OpenAI 兼容** | 支持通义、DeepSeek、本地 Ollama 等 | 自部署或使用国内大模型 |

### 多模型配置

平台支持为不同 Agent 分配不同的模型配置，在 `/im` 页面：
1. 点击右上角「模型管理」
2. 添加模型配置（可添加多个不同提供商）
3. 选中 Agent → 点击「分配模型」

### 数据库连接池调优（可选）

在 `.env.local` 中可以调整连接池参数，适用于高并发场景：

```env
DB_POOL_MAX=4              # 最大连接数（默认 4，开发环境推荐保持较小值）
DB_IDLE_TIMEOUT_SEC=10     # 空闲连接超时（秒）
DB_MAX_LIFETIME_SEC=600    # 连接最大存活时间（秒）
DB_CONNECT_TIMEOUT_SEC=10  # 连接超时（秒）
```

---

## 📖 蓝图预设

内置四种即用型蜂群架构，前往 `/blueprints` 一键部署：

| 蓝图 | 角色构成 | 适用场景 |
|------|---------|---------|
| **辩论** | 正方 + 反方 + 主持人 | 结构化论点生成、观点碰撞 |
| **论文写作** | 研究员 + 写作者 + 审阅者 | 学术内容协作、文档生成 |
| **代码评审** | 开发者 + 高级工程师 + QA | 自动化代码质量审查 |
| **产品设计** | PM + 设计师 + 工程师 | 产品需求文档生成 |

每次启动蓝图都会自动创建全新独立工作区，相互隔离互不干扰。

---

## 📱 页面路由

| 路由 | 功能说明 |
|------|---------|
| `/` | 首页导航 |
| `/lab` | 实验室大厅 — KPI 指标、图表、工作区列表 |
| `/im` | 消息协作中心 — 群聊、任务运行、Viz 画布 |
| `/blueprints` | 蓝图工坊 — 一键部署预设蜂群架构 |
| `/graph` | 组织关系图谱 — Agent 拓扑实时可视化 |
| `/undercover` | 谁是卧底大厅 |
| `/undercover/[gameId]` | 卧底对局页（圆桌模式 + 经典模式） |
| `/werewolf` | 狼人杀大厅 |
| `/werewolf/[gameId]` | 狼人杀对局页 |

---

## 🧩 技术栈

| 层级 | 技术选型 |
|------|---------|
| 框架 | Next.js 16（App Router，全栈） |
| 前端 | React 19 + TypeScript 5 |
| 样式 | Tailwind CSS 4 + 自定义 CSS 设计令牌系统 |
| 动画 | Framer Motion 11 |
| 图表 | Recharts 3 |
| 图标 | Lucide React |
| Markdown | Streamdown |
| ORM | Drizzle ORM |
| 数据库 | PostgreSQL 17 |
| 缓存/发布订阅 | Redis 7 |
| 实时通信 | Server-Sent Events（SSE） |
| 工具协议 | MCP SDK（Model Context Protocol） |
| 数据验证 | Zod |
| 包管理器 | npm / bun 兼容 |

---

## 📁 项目结构

```
swarm-lab/
├── backend/                  ← 主 Next.js 应用
│   ├── app/                  ← App Router 页面与 API 路由
│   │   ├── api/              ← REST API 处理器
│   │   ├── im/               ← 消息协作中心页面
│   │   ├── lab/              ← 实验室大厅页面
│   │   ├── blueprints/       ← 蓝图工坊页面
│   │   ├── graph/            ← 组织图谱页面
│   │   ├── undercover/       ← 谁是卧底页面
│   │   ├── werewolf/         ← 狼人杀页面
│   │   └── globals.css       ← 全局样式 + CSS 设计令牌
│   ├── src/
│   │   ├── runtime/          ← Agent 运行时、事件总线、UI 总线
│   │   ├── lib/              ← LLM 客户端、数据访问、配置、蓝图
│   │   ├── db/               ← Drizzle 表结构 + 数据库客户端
│   │   └── game/             ← 游戏规则引擎
│   ├── docker-compose.yml    ← PostgreSQL + Redis 服务
│   └── .env.example          ← 环境变量模板
├── assets/                   ← 截图与媒体资源
├── .github/                  ← Issue 模板 + 工作流
├── start_swarm_lab.bat       ← Windows 一键启动脚本
├── README.md                 ← 本文件（中文文档）
├── README_EN.md              ← English documentation
└── LICENSE                   ← MIT 许可证
```

---

## 常见问题

**Q: `docker compose up -d` 报错，端口被占用？**

PostgreSQL 默认使用 5432 端口，Redis 使用 6379 端口。如有冲突，编辑 `backend/docker-compose.yml` 修改端口映射，并同步更新 `.env.local` 中的 `DATABASE_URL` 和 `REDIS_URL`。

**Q: 初始化数据库返回 500 错误？**

检查 Docker 容器是否正常运行（`docker compose ps`），以及 `.env.local` 中的 `DATABASE_URL` 是否正确。

**Q: Agent 无响应，消息发出去没有回复？**

检查 `.env.local` 中填写的 API Key 是否有效，以及对应的 `LLM_PROVIDER` 配置是否与实际使用的 Key 匹配。可在 `/im` 页面右侧「推理」面板查看实时错误日志。

**Q: Windows 下 `npm run dev` 和 `npm run dev:win` 有什么区别？**

两个命令功能相同，均在 `127.0.0.1:3017` 上启动开发服务器。`dev:win` 是为解决部分 Windows 环境下的路径兼容性问题而提供的别名。

---

## 🔬 实验研究方向

Swarm Lab 特别适合以下研究场景：

- **组织结构实验** — 自由创建、终止、重组 Agent 层级结构，观察不同拓扑下的协作效率
- **任务治理研究** — 验证 Token 预算控制、防死循环机制、自动总结在实际工作流中的效果
- **多模型协同** — 在同一任务中混合不同提供商、不同参数量的模型，观察行为差异
- **策略博弈验证** — 通过谁是卧底/狼人杀量化不同 AI 策略的欺骗识别与社交推理能力
- **角色专业化研究** — 比较通用型 vs 专业化角色提示词对任务质量的影响

---

## 🤝 参与贡献

欢迎提交 Issue 和 Pull Request！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/你的功能`
3. 提交更改：`git commit -m 'feat: 添加你的功能'`
4. 推送分支：`git push origin feature/你的功能`
5. 发起 Pull Request

---

## 🙏 致谢

本项目基于 [@chmod777john](https://github.com/chmod777john) 的开源项目 **[Swarm-IDE](https://github.com/chmod777john/swarm-ide)** 构建。

Swarm-IDE 提出了优雅的极简原语哲学——Agent 蜂群只需 **create**（派生子代理）和 **send**（向任意代理发消息）两种能力，即可表达任意复杂的协作结构。感谢原作者开源了这套思路清晰、架构干净的系统。

在此基础上，Swarm Lab 新增了：实验室大厅、蓝图工坊、游戏实验场（谁是卧底 + 狼人杀）、任务编排系统、多模型配置管理、完整 CSS 设计令牌体系，以及 Windows 一键启动支持。

→ 详细功能对比见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGEMENTS.md)

---

## 📄 许可证

[MIT](LICENSE) © Swarm Lab 贡献者

---

> 🐝 **Swarm Lab** — 让每一个 AI Agent 都有自己的位置，让蜂群涌现出超越个体的智慧。
