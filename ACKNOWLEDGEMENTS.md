# 致谢

本项目基于 **swarm-ide**（作者：chmod777john）二次开发，感谢其在多 Agent 运行时、群组消息模型与图谱可视化方面奠定的基础架构。

在此基础上，Swarm-Lab 在以下方向做出了系统性工程贡献：

**任务治理**：设计并实现了完整的任务生命周期控制体系，支持超时、轮次、Token 预算与重复率等多维度停止策略，并引入强制中断机制防止 Agent 群组陷入死循环持续消耗资源。任务结束后自动触发总结生成与质量评审流程。

**Agent 管理**：实现了 Stop All / Terminate All / Delete All 批量生命周期操作，并对跨群扩散行为加以约束，避免无限分叉导致的信噪比崩溃。Agent 状态完全可追溯、可回收。

**多模型编排**：将 LLM 身份与 Agent 身份解耦，支持同一工作区内不同 Agent 绑定不同提供商与模型并发运行，统一接入 GLM、OpenRouter 与 OpenAI 兼容接口，支持一键批量重分配。

**蓝图系统**：设计了基于角色图的蓝图模板体系，将辩论、论文写作、代码评审、产品设计等协作范式编码为可实例化的组织架构，用户仅需提供主题即可一键启动完整 Agent 组织。

**可观测性**：构建了基于 SSE 的实时事件推送栈，引入跨群公共公屏（Public Feed）统一聚合多 Agent 运行状态，并以实时力导向图谱可视化 Agent 拓扑与通信关系。

**游戏化扩展**：在同一 Agent 运行时上实现了谁是卧底与狼人杀两个完整游戏模块，覆盖完整的规则引擎、阶段推进、角色行动与胜负判定，验证了该架构对对抗性协调场景的泛化能力。

---

# Acknowledgements

This project is a secondary development based on **swarm-ide** (author: chmod777john). We thank the original work for establishing the foundational multi-agent runtime, group messaging model, and graph visualization infrastructure.

Building on that foundation, Swarm-Lab contributes the following system-level engineering advances:

**Task Governance**: A complete task lifecycle control system with multi-dimensional stopping conditions — timeout, round limit, per-turn token budget, and repetition rate threshold. A forced interrupt mechanism prevents agent groups from falling into degenerate loops and consuming unbounded resources. Every completed task automatically triggers summary generation and quality review.

**Agent Management**: Bulk lifecycle operations — Stop All, Terminate All, Delete All — with full state tracking and cleanup. Cross-group diffusion is bounded to prevent unbounded fork trees that degrade signal-to-noise ratio. Agent state is fully traceable and reclaimable.

**Multi-Model Orchestration**: LLM identity is decoupled from agent identity. Different agents within the same workspace can run on different providers and models concurrently. Unified integration covers GLM, OpenRouter, and OpenAI-compatible endpoints, with one-click batch model reassignment.

**Blueprint System**: A role-graph-based template system that encodes collaborative archetypes — debate, academic paper, code review, product design — as instantiable organizational structures. Users provide a topic; the full agent organization is created and ready to run immediately.

**Observability**: A real-time event delivery stack built on SSE, with a cross-group Public Feed that aggregates significant events from all agent groups into a single timeline. Agent topology and communication patterns are rendered as a live force-directed graph.

**Gamified Extension**: Two complete game modules — Undercover and Werewolf — implemented on the same agent runtime, with full rule engines, phase progression, role actions, and win condition logic. These validate that the governance and communication primitives generalize from cooperative task completion to adversarial agent coordination.
