import type { ChatMessage, ModelResponse, ModelClientOptions } from "./types.js";
import { ModelClientError } from "./model-client-error.js";
import { chatCompletion, anthropicCompletion } from "./adapters.js";
import { traceModelCall, setModelResponseAttributes } from "./tracing.js";


// ── Circuit breaker ─────────────────────────────────────────────────────

interface CircuitState {
  failures: number;
  lastFailure: number;
  open: boolean;
}

class CircuitBreaker {
  private state = new Map<string, CircuitState>();
  private threshold: number;
  private resetTimeoutMs: number;

  constructor(threshold = 5, resetTimeoutMs = 30000) {
    this.threshold = threshold;
    this.resetTimeoutMs = resetTimeoutMs;
  }

  isOpen(key: string): boolean {
    const s = this.state.get(key);
    if (!s || !s.open) return false;
    if (Date.now() - s.lastFailure > this.resetTimeoutMs) {
      // Half-open: allow one probe request
      s.open = false;
      s.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(key: string): void {
    this.state.delete(key);
  }

  recordFailure(key: string): void {
    const s = this.state.get(key) ?? { failures: 0, lastFailure: 0, open: false };
    s.failures++;
    s.lastFailure = Date.now();
    if (s.failures >= this.threshold) {
      s.open = true;
    }
    this.state.set(key, s);
  }
}

function jitter(delayMs: number): number {
  return delayMs * (0.75 + Math.random() * 0.5);
}

function shouldRetry(e: ModelClientError, attempt: number, maxRetries: number): { retry: boolean; delayMs: number } {
  if (attempt >= maxRetries) return { retry: false, delayMs: 0 };
  switch (e.code) {
    case "RATE_LIMIT": return { retry: true, delayMs: jitter(Math.min(e.retryAfterMs ?? 2000, 300000)) };
    case "TIMEOUT": return attempt === 0 ? { retry: true, delayMs: jitter(1000) } : { retry: false, delayMs: 0 };
    case "AUTH_ERROR": case "PARSE_ERROR": return { retry: false, delayMs: 0 };
    case "API_ERROR":
      if (e.statusCode === 400 || e.statusCode === 401 || e.statusCode === 403) return { retry: false, delayMs: 0 };
      if (e.statusCode && e.statusCode >= 500) return { retry: true, delayMs: jitter(Math.min(1000 * Math.pow(2, attempt), 300000)) };
      if (e.statusCode && e.statusCode >= 400) return { retry: false, delayMs: 0 };
      return { retry: true, delayMs: jitter(Math.min(1000 * Math.pow(2, attempt), 300000)) };
    case "NETWORK_ERROR": return { retry: true, delayMs: jitter(Math.min(1000 * Math.pow(2, attempt), 300000)) };
    default: return { retry: false, delayMs: 0 };
  }
}

export class ModelClient {
  private static circuitBreaker = new CircuitBreaker();
  constructor(private readonly config: ModelClientOptions) {}

  private isAnthropic(): boolean {
    return this.config.providerType === "anthropic";
  }

  async chat(messages: ChatMessage[]): Promise<ModelResponse> {
    const providerKey = this.config.providerType;
    // Disambiguate providers of the same type via baseUrl fragment
    const cbKey = `${providerKey}:${this.config.defaultModel}` +
      (this.config.providerType === "openai"
        ? ":" + this.config.baseUrl.replace(/https?:\/\//, "").split("/")[0]
        : "");
    if (ModelClient.circuitBreaker.isOpen(cbKey)) {
      throw ModelClientError.api(503, `Circuit breaker open for ${cbKey}`);
    }
    return traceModelCall(providerKey, this.config.defaultModel, async (span) => {
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        let response: ModelResponse;
        if (this.isAnthropic()) { response = await anthropicCompletion(messages, this.config); }
        else {
          const headers: Record<string, string> = {};
          if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
          response = await chatCompletion(messages, this.config, headers);
        }
        ModelClient.circuitBreaker.recordSuccess(cbKey);
        setModelResponseAttributes(span, {
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
          totalTokens: response.totalTokens,
          reasoningTokens: response.reasoningTokens,
          finishReason: response.finishReason,
        });
        return response;
      } catch (e) {
        if (e instanceof ModelClientError && e.code !== "TIMEOUT") {
          ModelClient.circuitBreaker.recordFailure(cbKey);
        }
        if (!(e instanceof ModelClientError)) throw e;
        const decision = shouldRetry(e, attempt, this.config.maxRetries);
        if (!decision.retry) throw e;
        await new Promise(r => setTimeout(r, decision.delayMs));
      }
    }
    throw ModelClientError.api(500, "Unreachable");
    });
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<ModelResponse> {
    return this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
  }
}
