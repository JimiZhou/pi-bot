import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentRunResult, AgentRunner } from "./types.js";

export interface PiAgentRunnerOptions {
  model: Model<Api>;
  apiKey?: string | ((provider: string) => string | undefined | Promise<string | undefined>);
  thinkingLevel?: ThinkingLevel;
  /** Hard output cap per LLM call (includes provider thinking tokens where applicable). */
  maxOutputTokens?: number;
  maxRetryDelayMs?: number;
  /** Delays before retrying transient provider failures. Defaults to five retries over 30 seconds. */
  retryDelaysMs?: readonly number[];
  /** Maximum wall time for this model before preserving the turn budget for its fallback. */
  attemptTimeoutMs?: number;
  /** Optional independent runner used only after transient primary failures and before any tool side effect. */
  fallbackRunner?: AgentRunner;
  fallbackToolFilter?: (tool: AgentTool) => boolean;
  /** Internal provider rotation keeps full capability; external degradation is surfaced to callers. */
  fallbackMode?: "internal" | "degraded";
  /** Keeps subsequent turns off a known-bad primary for a short bounded interval. */
  circuitBreakerCooldownMs?: number;
  onFallback?: (
    error: string,
    reason: "primary-failed" | "circuit-open",
    request: AgentRunRequest,
  ) => void;
}

const DEFAULT_TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export class PiAgentRunner implements AgentRunner {
  readonly #options: PiAgentRunnerOptions;
  #primaryUnavailableUntil = 0;
  #lastTransientError = "primary provider is temporarily unavailable";

  constructor(options: PiAgentRunnerOptions) {
    this.#options = options;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const boundedRequest = withBudgetDeadline(request);
    const startedAt = Date.now();
    if (this.#options.fallbackRunner && Date.now() < this.#primaryUnavailableUntil) {
      return this.#runFallback(boundedRequest, this.#lastTransientError, "circuit-open", undefined, startedAt);
    }
    let silent = false;
    let toolExecutionStarted = false;
    let llmCalls = 0;
    let toolCalls = 0;
    let firstTokenAt: number | undefined;
    let budgetError: string | undefined;
    let attemptTimeoutError: string | undefined;
    const getApiKey = toApiKeyResolver(this.#options.apiKey);
    const attemptTimeoutMs = modelAttemptTimeout(this.#options.attemptTimeoutMs);
    let agent!: Agent;
    const maxOutputTokens = this.#options.maxOutputTokens;
    agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt,
        model: this.#options.model,
        thinkingLevel: this.#options.thinkingLevel ?? "low",
        tools: request.tools,
        messages: [],
      },
      sessionId: request.sessionId,
      toolExecution: "sequential",
      ...(maxOutputTokens !== undefined
        ? {
            streamFn: (model, context, options) =>
              streamSimple(model, context, { ...options, maxTokens: maxOutputTokens }),
          }
        : {}),
      ...(boundedRequest.budget
        ? {
            beforeToolCall: async () => {
              if (toolCalls < boundedRequest.budget!.maxToolCalls) return undefined;
              budgetError = `Agent tool-call budget exceeded (${boundedRequest.budget!.maxToolCalls})`;
              queueMicrotask(() => agent.abort());
              return { block: true, reason: budgetError };
            },
          }
        : {}),
      ...(getApiKey ? { getApiKey } : {}),
      ...(this.#options.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: this.#options.maxRetryDelayMs }),
    });

    agent.subscribe((event) => {
      if (event.type === "turn_start") {
        llmCalls += 1;
        if (boundedRequest.budget && llmCalls > boundedRequest.budget.maxLlmCalls) {
          budgetError = `Agent LLM-call budget exceeded (${boundedRequest.budget.maxLlmCalls})`;
          agent.abort();
        }
      }
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta" &&
        firstTokenAt === undefined
      ) firstTokenAt = Date.now();
      if (event.type === "tool_execution_start") toolExecutionStarted = true;
      if (event.type === "tool_execution_start") toolCalls += 1;
      if (event.type !== "tool_execution_end" || event.toolName !== "skip_reply" || event.isError) return;
      const details = (event.result as { details?: unknown } | undefined)?.details;
      if (isSilentDetails(details)) silent = true;
    });

    const runAgentOperation = async (operation: () => Promise<void>): Promise<void> => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const remainingMs = boundedRequest.budget
        ? boundedRequest.budget.deadlineAt! - Date.now()
        : Number.POSITIVE_INFINITY;
      if (remainingMs <= 0) throw new Error("Agent turn time budget exceeded");
      const operationTimeoutMs = Math.min(remainingMs, attemptTimeoutMs ?? Number.POSITIVE_INFINITY);
      if (Number.isFinite(operationTimeoutMs)) {
        timeout = setTimeout(() => {
          if (attemptTimeoutMs !== undefined && attemptTimeoutMs < remainingMs) {
            attemptTimeoutError = `Model attempt timed out after ${attemptTimeoutMs}ms`;
          } else {
            budgetError = `Agent turn time budget exceeded (${boundedRequest.budget!.timeoutMs}ms)`;
          }
          agent.abort();
        }, operationTimeoutMs);
      }
      try {
        await operation();
      } catch (error) {
        if (budgetError) throw new Error(budgetError);
        if (attemptTimeoutError) throw new Error(attemptTimeoutError);
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (budgetError) throw new Error(budgetError);
      if (attemptTimeoutError) throw new Error(attemptTimeoutError);
    };
    try {
      await runAgentOperation(() => agent.prompt(boundedRequest.prompt));
    } catch (error) {
      if (attemptTimeoutError && this.#options.fallbackRunner && !toolExecutionStarted) {
        this.#lastTransientError = attemptTimeoutError;
        this.#primaryUnavailableUntil = Date.now() + circuitBreakerCooldown(this.#options.circuitBreakerCooldownMs);
        return this.#runFallback(
          boundedRequest,
          attemptTimeoutError,
          "primary-failed",
          collectTelemetry(
            agent.state.messages,
            this.#options.model.provider,
            this.#options.model.id,
            llmCalls,
            toolCalls,
            startedAt,
            firstTokenAt,
          ),
          startedAt,
        );
      }
      throw error;
    }
    const retryDelays = this.#options.retryDelaysMs ?? DEFAULT_TRANSIENT_RETRY_DELAYS_MS;
    for (let retry = 0; agent.state.errorMessage && retry < retryDelays.length; retry += 1) {
      const error = agent.state.errorMessage;
      if (!isTransientProviderError(error)) break;
      if (isModelPermissionUnavailable(error)) break;
      const delayMs = retryDelay(retryDelays[retry]);
      if (delayMs > 0) {
        const remainingMs = boundedRequest.budget
          ? boundedRequest.budget.deadlineAt! - Date.now()
          : Number.POSITIVE_INFINITY;
        if (delayMs >= remainingMs) {
          throw new Error(`Agent turn time budget exceeded (${boundedRequest.budget!.timeoutMs}ms)`);
        }
        await delay(delayMs);
      }
      if (!removeTrailingErrorMessage(agent.state.messages)) {
        // A failed turn must end in the synthetic provider error. If that invariant
        // changes, never replay a request that may already have run a side-effecting tool.
        if (toolExecutionStarted) break;
        throw new Error(error);
      }
      await runAgentOperation(() => agent.continue());
    }
    if (agent.state.errorMessage) {
      const error = agent.state.errorMessage;
      if (this.#options.fallbackRunner && isTransientProviderError(error) && !toolExecutionStarted) {
        this.#lastTransientError = error;
        this.#primaryUnavailableUntil = Date.now() + circuitBreakerCooldown(this.#options.circuitBreakerCooldownMs);
        return this.#runFallback(
          boundedRequest,
          error,
          "primary-failed",
          collectTelemetry(
            agent.state.messages,
            this.#options.model.provider,
            this.#options.model.id,
            llmCalls,
            toolCalls,
            startedAt,
            firstTokenAt,
          ),
          startedAt,
        );
      }
      throw new Error(error);
    }
    this.#primaryUnavailableUntil = 0;
    const telemetry = collectTelemetry(
      agent.state.messages,
      this.#options.model.provider,
      this.#options.model.id,
      llmCalls,
      toolCalls,
      startedAt,
      firstTokenAt,
    );
    if (silent) return { text: null, telemetry };

    const assistant = [...agent.state.messages].reverse().find(isAssistantMessage);
    if (!assistant) return { text: null, telemetry };
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw new Error(assistant.errorMessage ?? `Pi stopped with ${assistant.stopReason}`);
    }
    const text = assistant.content
      .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
      .map((content) => content.text)
      .join("")
      .trim();
    return { text: text || null, telemetry };
  }

  async #runFallback(
    request: AgentRunRequest,
    error: string,
    reason: "primary-failed" | "circuit-open",
    usedTelemetry: NonNullable<AgentRunResult["telemetry"]> | undefined,
    turnStartedAt: number,
  ): Promise<AgentRunResult> {
    const runner = this.#options.fallbackRunner;
    if (!runner) throw new Error(error);
    this.#options.onFallback?.(error, reason, request);
    const usedLlmCalls = usedTelemetry?.llmCalls ?? 0;
    const usedToolCalls = usedTelemetry?.toolCalls ?? 0;
    const fallbackBudget = request.budget
      ? {
          ...request.budget,
          maxLlmCalls: request.budget.maxLlmCalls - usedLlmCalls,
          maxToolCalls: request.budget.maxToolCalls - usedToolCalls,
        }
      : undefined;
    if (fallbackBudget && (fallbackBudget.maxLlmCalls <= 0 || fallbackBudget.maxToolCalls < 0)) {
      throw new Error("Agent call budget exhausted before model fallback");
    }
    const fallbackStartedAt = Date.now();
    const result = await runner.run({
      ...request,
      ...(fallbackBudget ? { budget: fallbackBudget } : {}),
      tools: this.#options.fallbackToolFilter
        ? request.tools.filter(this.#options.fallbackToolFilter)
        : request.tools,
    });
    const current = `${this.#options.model.provider}/${this.#options.model.id}`;
    const telemetry = result.telemetry
      ? {
          ...result.telemetry,
          modelRoute: [current, ...result.telemetry.modelRoute],
          llmCalls: result.telemetry.llmCalls + usedLlmCalls,
          toolCalls: result.telemetry.toolCalls + usedToolCalls,
          inputTokens: result.telemetry.inputTokens + (usedTelemetry?.inputTokens ?? 0),
          outputTokens: result.telemetry.outputTokens + (usedTelemetry?.outputTokens ?? 0),
          cacheReadTokens: result.telemetry.cacheReadTokens + (usedTelemetry?.cacheReadTokens ?? 0),
          cacheWriteTokens: result.telemetry.cacheWriteTokens + (usedTelemetry?.cacheWriteTokens ?? 0),
          estimatedCostUsd: result.telemetry.estimatedCostUsd + (usedTelemetry?.estimatedCostUsd ?? 0),
          fallbackHops: result.telemetry.fallbackHops + 1,
          durationMs: Math.max(
            Date.now() - turnStartedAt,
            fallbackStartedAt - turnStartedAt + result.telemetry.durationMs,
            usedTelemetry?.durationMs ?? 0,
          ),
          ...fallbackFirstTokenTelemetry(usedTelemetry, result.telemetry, turnStartedAt, fallbackStartedAt),
        }
      : undefined;
    return this.#options.fallbackMode === "internal"
      ? { ...result, ...(telemetry ? { telemetry } : {}) }
      : { ...result, degradedMode: true, ...(telemetry ? { telemetry } : {}) };
  }
}

function withBudgetDeadline(request: AgentRunRequest): AgentRunRequest {
  if (!request.budget) return request;
  const { maxLlmCalls, maxToolCalls, timeoutMs, deadlineAt } = request.budget;
  if (!Number.isSafeInteger(maxLlmCalls) || maxLlmCalls < 1 || maxLlmCalls > 100) {
    throw new Error("Agent maxLlmCalls budget is invalid");
  }
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0 || maxToolCalls > 200) {
    throw new Error("Agent maxToolCalls budget is invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) {
    throw new Error("Agent timeout budget is invalid");
  }
  const resolvedDeadline = deadlineAt ?? Date.now() + timeoutMs;
  if (!Number.isSafeInteger(resolvedDeadline)) throw new Error("Agent deadline budget is invalid");
  return { ...request, budget: { maxLlmCalls, maxToolCalls, timeoutMs, deadlineAt: resolvedDeadline } };
}

function collectTelemetry(
  messages: AgentMessage[],
  provider: string,
  model: string,
  llmCalls: number,
  toolCalls: number,
  startedAt: number,
  firstTokenAt: number | undefined,
): NonNullable<AgentRunResult["telemetry"]> {
  const assistants = messages.filter(isAssistantMessage);
  const totals = assistants.reduce((sum, message) => ({
    inputTokens: sum.inputTokens + message.usage.input,
    outputTokens: sum.outputTokens + message.usage.output,
    cacheReadTokens: sum.cacheReadTokens + message.usage.cacheRead,
    cacheWriteTokens: sum.cacheWriteTokens + message.usage.cacheWrite,
    estimatedCostUsd: sum.estimatedCostUsd + message.usage.cost.total,
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
  });
  return {
    model,
    provider,
    modelRoute: [`${provider}/${model}`],
    llmCalls,
    toolCalls,
    ...totals,
    fallbackHops: 0,
    durationMs: Date.now() - startedAt,
    ...(firstTokenAt === undefined ? {} : { timeToFirstTokenMs: firstTokenAt - startedAt }),
  };
}

function fallbackFirstTokenTelemetry(
  used: NonNullable<AgentRunResult["telemetry"]> | undefined,
  fallback: NonNullable<AgentRunResult["telemetry"]>,
  turnStartedAt: number,
  fallbackStartedAt: number,
): Pick<NonNullable<AgentRunResult["telemetry"]>, "timeToFirstTokenMs"> | Record<string, never> {
  const candidates = [
    used?.timeToFirstTokenMs,
    fallback.timeToFirstTokenMs === undefined
      ? undefined
      : fallbackStartedAt - turnStartedAt + fallback.timeToFirstTokenMs,
  ].filter((value): value is number => value !== undefined);
  return candidates.length > 0 ? { timeToFirstTokenMs: Math.max(0, Math.min(...candidates)) } : {};
}

/** Matches retryable upstream/network failures while leaving auth and request errors fail-fast. */
export function isTransientProviderError(message: string): boolean {
  const normalized = message.normalize("NFKC").toLocaleLowerCase();
  // Some gateways wrap policy refusals in HTTP 500 responses. Retrying or routing
  // those to a less restricted local model would turn a refusal into a bypass.
  if (/(?:safety|safety.?filter|content.?filter|policy.?violation|prohibited|blocked.?reason|finish.?reason.{0,24}(?:safety|blocked)|内容审核|安全策略|内容政策|违规内容|因安全原因拒绝)/u.test(normalized)) {
    return false;
  }
  return /(?:\b(?:429|500|502|503|504)\b|\b403\b.{0,240}(?:permission_denied|caller does not have permission)|do_request_failed|fetch failed|network(?: error)?|econnreset|econnrefused|etimedout|esockettimedout|socket hang up|connection reset|timed?\s*out|temporar(?:y|ily) unavailable|service unavailable|rate limit|too many requests)/u.test(normalized);
}

function isModelPermissionUnavailable(message: string): boolean {
  const normalized = message.normalize("NFKC").toLocaleLowerCase();
  return /\b403\b.{0,240}(?:permission_denied|caller does not have permission)/u.test(normalized);
}

function removeTrailingErrorMessage(messages: AgentMessage[]): boolean {
  const last = messages.at(-1);
  if (!last || !isAssistantMessage(last) || (last.stopReason !== "error" && last.stopReason !== "aborted")) return false;
  messages.pop();
  return messages.length > 0 && messages.at(-1)?.role !== "assistant";
}

function retryDelay(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 0 || value > 60_000) {
    throw new Error("Pi retry delay must be an integer between 0 and 60000ms");
  }
  return value;
}

function circuitBreakerCooldown(value: number | undefined): number {
  const milliseconds = value ?? 60_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 10 * 60_000) {
    throw new Error("Pi circuit breaker cooldown must be an integer between 1000 and 600000ms");
  }
  return milliseconds;
}

function modelAttemptTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 10 * 60_000) {
    throw new Error("Pi model attempt timeout must be an integer between 1000 and 600000ms");
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toApiKeyResolver(
  value: PiAgentRunnerOptions["apiKey"],
): ((provider: string) => Promise<string | undefined> | string | undefined) | undefined {
  if (typeof value === "function") return value;
  if (typeof value === "string") return () => value;
  return undefined;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}

function isSilentDetails(value: unknown): value is { silent: true } {
  return typeof value === "object" && value !== null && "silent" in value && value.silent === true;
}
