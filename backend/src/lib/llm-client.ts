import { store } from "@/lib/storage";
import { safeJsonParse } from "@/runtime/utils";

type UUID = string;
type LlmProvider = "glm" | "openrouter" | "openai_compatible";

type ResolvedLlmConfig = {
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
};

export type LlmDecodeParams = {
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  maxTokens?: number;
};

function getLlmProvider(): Exclude<LlmProvider, "openai_compatible"> {
  const raw = (process.env.LLM_PROVIDER ?? "glm").toLowerCase();
  if (raw === "openrouter" || raw === "open-router" || raw === "or") return "openrouter";
  return "glm";
}

function normalizeOpenRouterUrl(value: string) {
  if (!value) return "https://openrouter.ai/api/v1/chat/completions";
  if (value.endsWith("/chat/completions")) return value;
  if (value.endsWith("/api/v1")) return `${value}/chat/completions`;
  if (value.endsWith("/v1")) return `${value}/chat/completions`;
  return value;
}

function getGlmConfig() {
  const apiKey = process.env.GLM_API_KEY ?? process.env.ZHIPUAI_API_KEY ?? "";
  const baseUrl = process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4/chat/completions";
  const model = process.env.GLM_MODEL ?? "glm-4.7";
  if (!apiKey) throw new Error("Missing GLM API key");
  return { apiKey, baseUrl, model };
}

function getOpenRouterConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  const baseUrl = normalizeOpenRouterUrl(
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1/chat/completions"
  );
  const model = process.env.OPENROUTER_MODEL ?? "";
  const httpReferer = process.env.OPENROUTER_HTTP_REFERER ?? "";
  const appTitle = process.env.OPENROUTER_APP_TITLE ?? "";
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");
  return { apiKey, baseUrl, model, httpReferer, appTitle };
}

function getOpenAiCompatibleConfig() {
  const apiKey = process.env.OPENAI_COMPAT_API_KEY ?? "";
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL ?? "http://127.0.0.1:11434/v1/chat/completions";
  const model = process.env.OPENAI_COMPAT_MODEL ?? "";
  const headers = safeJsonParse<Record<string, string>>(process.env.OPENAI_COMPAT_HEADERS ?? "{}", {});
  if (!apiKey) throw new Error("Missing OPENAI_COMPAT_API_KEY");
  return { apiKey, baseUrl, model, headers };
}

async function resolveAgentLlmConfig(agentId: UUID): Promise<ResolvedLlmConfig> {
  const profile = await store.getAgentModelRuntimeConfig({ agentId });
  if (profile.provider && profile.model && profile.baseUrl && profile.apiKey) {
    return {
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      headers: profile.headers,
    };
  }

  const provider = getLlmProvider();
  if (provider === "openrouter") {
    const cfg = getOpenRouterConfig();
    return {
      provider: "openrouter",
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      headers: {
        ...(cfg.httpReferer ? { "HTTP-Referer": cfg.httpReferer } : {}),
        ...(cfg.appTitle ? { "X-Title": cfg.appTitle } : {}),
      },
    };
  }

  if ((process.env.LLM_PROVIDER ?? "").toLowerCase() === "openai_compatible") {
    const cfg = getOpenAiCompatibleConfig();
    return {
      provider: "openai_compatible",
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      headers: cfg.headers,
    };
  }

  const cfg = getGlmConfig();
  return {
    provider: "glm",
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
  };
}

function parseAssistantContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) => (typeof x === "string" ? x : typeof x?.text === "string" ? x.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function formatUpstreamError(provider: string, status: number, text: string) {
  const raw = String(text ?? "").trim();
  let message = raw;
  let code = "";
  try {
    const parsed = JSON.parse(raw) as any;
    code = String(parsed?.error?.code ?? parsed?.code ?? "");
    message = String(parsed?.error?.message ?? parsed?.message ?? raw);
  } catch {
    // ignore
  }
  const compact = message.replace(/\s+/g, " ").trim();
  const looksArrearage =
    /arrearage/i.test(code) || /overdue-payment|access denied|in good standing/i.test(compact);
  if (looksArrearage) {
    return `模型调用失败：账户欠费或状态受限（Arrearage）。请到阿里云百炼充值并确认账号状态后重试。provider=${provider}, status=${status}`;
  }
  const clipped = compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
  return `llm upstream error ${status}: ${clipped}`;
}

export async function chatJsonByAgent(input: {
  agentId: UUID;
  systemPrompt: string;
  userPrompt: string;
  decode?: LlmDecodeParams;
}): Promise<string> {
  const llm = await resolveAgentLlmConfig(input.agentId);

  const payload: Record<string, unknown> = {
    model: llm.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    stream: false,
    temperature: input.decode?.temperature ?? 0.8,
    top_p: input.decode?.topP ?? 0.9,
    presence_penalty: input.decode?.presencePenalty ?? 0.2,
    frequency_penalty: input.decode?.frequencyPenalty ?? 0.2,
    max_tokens: input.decode?.maxTokens ?? 220,
  };

  const res = await fetch(llm.baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
      ...(llm.headers ?? {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(formatUpstreamError(llm.provider, res.status, body));
  }

  const data = (await res.json().catch(() => null)) as any;
  const content = parseAssistantContent(data?.choices?.[0]?.message?.content ?? "");
  if (!content.trim()) throw new Error("llm returned empty content");
  return content;
}
