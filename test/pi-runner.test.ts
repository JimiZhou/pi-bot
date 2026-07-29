import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
} from "@earendil-works/pi-ai";
import { PiAgentRunner } from "../src/pi-runner.js";

test("Pi runner collects one complete final response", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  try {
    faux.setResponses([fauxAssistantMessage("自然回复")]);
    const runner = new PiAgentRunner({ model: faux.getModel(), thinkingLevel: "off" });
    const result = await runner.run({ systemPrompt: "system", prompt: "hello", sessionId: "s1", tools: [] });
    assert.equal(result.text, "自然回复");
    assert.equal(result.telemetry?.llmCalls, 1);
    assert.equal(result.telemetry?.toolCalls, 0);
    assert.deepEqual(result.telemetry?.modelRoute, [`${faux.getModel().provider}/${faux.getModel().id}`]);
    assert.ok((result.telemetry?.inputTokens ?? 0) > 0);
    assert.ok((result.telemetry?.outputTokens ?? 0) > 0);
    assert.equal(faux.state.callCount, 1);
  } finally {
    faux.unregister();
  }
});

test("Pi skip_reply tool produces no outbound text", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  const Parameters = Type.Object({ reason: Type.String() });
  const skipTool: AgentTool<typeof Parameters, { silent: true }> = {
    name: "skip_reply",
    label: "保持沉默",
    description: "不应回复时调用",
    parameters: Parameters,
    async execute(): Promise<AgentToolResult<{ silent: true }>> {
      return { content: [{ type: "text", text: "silent" }], details: { silent: true }, terminate: true };
    },
  };

  try {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("skip_reply", { reason: "human conversation" }), {
        stopReason: "toolUse",
      }),
    ]);
    const runner = new PiAgentRunner({ model: faux.getModel(), thinkingLevel: "off" });
    const result = await runner.run({
      systemPrompt: "system",
      prompt: "hello",
      sessionId: "s2",
      tools: [skipTool],
    });
    assert.equal(result.text, null);
    assert.equal(result.telemetry?.llmCalls, 1);
    assert.equal(result.telemetry?.toolCalls, 1);
    assert.equal(faux.state.callCount, 1);
  } finally {
    faux.unregister();
  }
});

test("Pi executes a learning tool before producing the final chat reply", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  const Parameters = Type.Object({
    action: Type.String(),
    content: Type.String(),
  });
  const calls: Array<{ action: string; content: string }> = [];
  const memoryTool: AgentTool<typeof Parameters, { saved: true }> = {
    name: "memory",
    label: "管理长期记忆",
    description: "纠正并保存长期记忆",
    parameters: Parameters,
    async execute(_id, parameters): Promise<AgentToolResult<{ saved: true }>> {
      calls.push(parameters);
      return {
        content: [{ type: "text", text: "记忆已经纠正" }],
        details: { saved: true },
      };
    },
  };

  try {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("memory", { action: "correct", content: "阿青喜欢吃香菜。" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("记住了，是你喜欢吃香菜。"),
    ]);
    const runner = new PiAgentRunner({ model: faux.getModel(), thinkingLevel: "off" });
    const result = await runner.run({
      systemPrompt: "先纠正记忆再回复",
      prompt: "不是我不吃香菜，我喜欢吃。",
      sessionId: "s-learning",
      tools: [memoryTool],
    });

    assert.deepEqual(calls, [{ action: "correct", content: "阿青喜欢吃香菜。" }]);
    assert.equal(result.text, "记住了，是你喜欢吃香菜。");
    assert.equal(result.telemetry?.llmCalls, 2);
    assert.equal(result.telemetry?.toolCalls, 1);
    assert.equal(faux.state.callCount, 2);
  } finally {
    faux.unregister();
  }
});

test("Pi retries transient upstream 500 failures before returning a reply", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  try {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 500 do_request_failed" }),
      fauxAssistantMessage("重试恢复了"),
    ]);
    const runner = new PiAgentRunner({
      model: faux.getModel(),
      thinkingLevel: "off",
      retryDelaysMs: [0],
    });
    const result = await runner.run({ systemPrompt: "system", prompt: "hello", sessionId: "retry-500", tools: [] });
    assert.equal(result.text, "重试恢复了");
    assert.equal(result.telemetry?.llmCalls, 2);
    assert.equal(faux.state.callCount, 2);
  } finally {
    faux.unregister();
  }
});

test("Pi falls back locally after transient failures and opens a short circuit", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  const fallbackRequests: Array<{ prompt: string; tools: string[] }> = [];
  const fallbackRunner = {
    async run(request: Parameters<PiAgentRunner["run"]>[0]) {
      fallbackRequests.push({ prompt: request.prompt, tools: request.tools.map((tool) => tool.name) });
      return { text: "本地兜底回复" };
    },
  };
  const ParametersSchema = Type.Object({ question: Type.String() });
  const unavailableVisionTool: AgentTool<typeof ParametersSchema, Record<string, never>> = {
    name: "understand_image",
    label: "看图",
    description: "依赖故障上游",
    parameters: ParametersSchema,
    async execute(): Promise<AgentToolResult<Record<string, never>>> {
      return { content: [{ type: "text", text: "unused" }], details: {} };
    },
  };

  try {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 500 Google RPC failed" }),
    ]);
    const reasons: string[] = [];
    const runner = new PiAgentRunner({
      model: faux.getModel(),
      thinkingLevel: "off",
      retryDelaysMs: [],
      fallbackRunner,
      fallbackToolFilter: (tool) => tool.name !== "understand_image",
      circuitBreakerCooldownMs: 60_000,
      onFallback: (_error, reason) => reasons.push(reason),
    });
    const request = {
      systemPrompt: "system",
      prompt: "hello",
      sessionId: "fallback-500",
      tools: [unavailableVisionTool],
    };
    assert.deepEqual(await runner.run(request), { text: "本地兜底回复", degradedMode: true });
    assert.deepEqual(await runner.run({ ...request, prompt: "second" }), { text: "本地兜底回复", degradedMode: true });
    assert.equal(faux.state.callCount, 1);
    assert.deepEqual(reasons, ["primary-failed", "circuit-open"]);
    assert.deepEqual(fallbackRequests, [
      { prompt: "hello", tools: [] },
      { prompt: "second", tools: [] },
    ]);
  } finally {
    faux.unregister();
  }
});

test("Pi internal model rotation does not mark the answer as externally degraded", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  try {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 429 RESOURCE_EXHAUSTED" }),
    ]);
    const runner = new PiAgentRunner({
      model: faux.getModel(),
      thinkingLevel: "off",
      retryDelaysMs: [],
      fallbackMode: "internal",
      fallbackRunner: { async run() { return { text: "Gemini 内部轮换成功" }; } },
    });
    assert.deepEqual(
      await runner.run({ systemPrompt: "system", prompt: "hello", sessionId: "internal-rotation", tools: [] }),
      { text: "Gemini 内部轮换成功" },
    );
  } finally {
    faux.unregister();
  }
});

test("Pi telemetry accumulates the ordered route and fallback hops", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  try {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 429 RESOURCE_EXHAUSTED" }),
    ]);
    const runner = new PiAgentRunner({
      model: faux.getModel(),
      thinkingLevel: "off",
      retryDelaysMs: [],
      fallbackRunner: {
        async run() {
          return {
            text: "最终本地回复",
            degradedMode: true,
            telemetry: {
              provider: "openai",
              model: "gpt-fallback",
              modelRoute: ["openai/gpt-fallback", "local/qwen-small"],
              llmCalls: 2,
              toolCalls: 1,
              inputTokens: 120,
              outputTokens: 30,
              cacheReadTokens: 20,
              cacheWriteTokens: 0,
              estimatedCostUsd: 0.002,
              fallbackHops: 1,
              durationMs: 25,
            },
          };
        },
      },
    });
    const result = await runner.run({ systemPrompt: "system", prompt: "hello", sessionId: "route", tools: [] });
    assert.equal(result.text, "最终本地回复");
    assert.equal(result.degradedMode, true);
    assert.deepEqual(result.telemetry?.modelRoute, [
      `${faux.getModel().provider}/${faux.getModel().id}`,
      "openai/gpt-fallback",
      "local/qwen-small",
    ]);
    assert.equal(result.telemetry?.fallbackHops, 2);
    assert.equal(result.telemetry?.estimatedCostUsd, 0.002);
  } finally {
    faux.unregister();
  }
});

test("Pi aborts a tool loop when the per-turn LLM-call budget is exhausted", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  const Parameters = Type.Object({ value: Type.String() });
  const tool: AgentTool<typeof Parameters, { ok: true }> = {
    name: "bounded_tool",
    label: "预算测试工具",
    description: "测试调用预算",
    parameters: Parameters,
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: { ok: true } };
    },
  };
  try {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bounded_tool", { value: "one" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("不应完成"),
    ]);
    const runner = new PiAgentRunner({ model: faux.getModel(), thinkingLevel: "off" });
    await assert.rejects(
      runner.run({
        systemPrompt: "system",
        prompt: "hello",
        sessionId: "budget",
        tools: [tool],
        budget: { maxLlmCalls: 1, maxToolCalls: 2, timeoutMs: 10_000 },
      }),
      /LLM-call budget exceeded/u,
    );
    assert.equal(faux.state.callCount, 2);
  } finally {
    faux.unregister();
  }
});

test("Pi preserves the absolute deadline and passes only remaining calls to a fallback", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  let fallbackBudget: Parameters<PiAgentRunner["run"]>[0]["budget"];
  try {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 429 RESOURCE_EXHAUSTED" }),
    ]);
    const runner = new PiAgentRunner({
      model: faux.getModel(),
      thinkingLevel: "off",
      retryDelaysMs: [],
      fallbackRunner: {
        async run(request) {
          fallbackBudget = request.budget;
          return { text: "降级成功" };
        },
      },
    });
    const deadlineAt = Date.now() + 10_000;
    const result = await runner.run({
      systemPrompt: "system",
      prompt: "hello",
      sessionId: "fallback-budget",
      tools: [],
      budget: { maxLlmCalls: 3, maxToolCalls: 2, timeoutMs: 10_000, deadlineAt },
    });
    assert.equal(result.text, "降级成功");
    assert.deepEqual(fallbackBudget, { maxLlmCalls: 2, maxToolCalls: 2, timeoutMs: 10_000, deadlineAt });
  } finally {
    faux.unregister();
  }
});

test("Pi abandons a hung model attempt before the turn deadline and runs its fallback", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  let fallbackDeadline: number | undefined;
  try {
    faux.setResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_050));
        return fauxAssistantMessage("过晚的主模型回复");
      },
    ]);
    const reasons: string[] = [];
    const runner = new PiAgentRunner({
      model: faux.getModel(),
      thinkingLevel: "off",
      attemptTimeoutMs: 1_000,
      fallbackRunner: {
        async run(request) {
          fallbackDeadline = request.budget?.deadlineAt;
          return { text: "及时降级成功" };
        },
      },
      onFallback: (error, reason) => reasons.push(`${reason}:${error}`),
    });
    const deadlineAt = Date.now() + 3_000;
    const result = await runner.run({
      systemPrompt: "system",
      prompt: "hello",
      sessionId: "attempt-timeout-fallback",
      tools: [],
      budget: { maxLlmCalls: 3, maxToolCalls: 1, timeoutMs: 3_000, deadlineAt },
    });
    assert.equal(result.text, "及时降级成功");
    assert.equal(result.degradedMode, true);
    assert.equal(fallbackDeadline, deadlineAt);
    assert.deepEqual(reasons, ["primary-failed:Model attempt timed out after 1000ms"]);
  } finally {
    faux.unregister();
  }
});

test("Pi rejects a tool call when the tool budget is zero", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  const Parameters = Type.Object({ value: Type.String() });
  let executions = 0;
  const tool: AgentTool<typeof Parameters, { ok: true }> = {
    name: "forbidden_tool",
    label: "零预算工具",
    description: "不应执行",
    parameters: Parameters,
    async execute() {
      executions += 1;
      return { content: [{ type: "text", text: "ok" }], details: { ok: true } };
    },
  };
  try {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("forbidden_tool", { value: "one" }), { stopReason: "toolUse" }),
    ]);
    const runner = new PiAgentRunner({ model: faux.getModel(), thinkingLevel: "off" });
    await assert.rejects(
      runner.run({
        systemPrompt: "system",
        prompt: "hello",
        sessionId: "zero-tool-budget",
        tools: [tool],
        budget: { maxLlmCalls: 2, maxToolCalls: 0, timeoutMs: 10_000 },
      }),
      /tool-call budget exceeded/u,
    );
    assert.equal(executions, 0);
  } finally {
    faux.unregister();
  }
});

test("Pi does not begin a retry that cannot finish before the turn deadline", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  try {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 500 do_request_failed" }),
      fauxAssistantMessage("不应重试"),
    ]);
    const runner = new PiAgentRunner({
      model: faux.getModel(),
      thinkingLevel: "off",
      retryDelaysMs: [100],
    });
    await assert.rejects(
      runner.run({
        systemPrompt: "system",
        prompt: "hello",
        sessionId: "retry-deadline",
        tools: [],
        budget: { maxLlmCalls: 3, maxToolCalls: 0, timeoutMs: 10 },
      }),
      /turn time budget exceeded/u,
    );
    assert.equal(faux.state.callCount, 1);
  } finally {
    faux.unregister();
  }
});

test("Pi does not retry permanent authentication failures", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  try {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 401 invalid API key" }),
      fauxAssistantMessage("不应调用"),
    ]);
    const runner = new PiAgentRunner({ model: faux.getModel(), thinkingLevel: "off", retryDelaysMs: [0] });
    await assert.rejects(
      runner.run({ systemPrompt: "system", prompt: "hello", sessionId: "no-retry-auth", tools: [] }),
      /401 invalid API key/u,
    );
    assert.equal(faux.state.callCount, 1);
  } finally {
    faux.unregister();
  }
});

test("Pi rotates past a Gemini model-specific permission denial", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  try {
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "HTTP 403 PERMISSION_DENIED: The caller does not have permission",
      }),
    ]);
    const runner = new PiAgentRunner({
      model: faux.getModel(),
      thinkingLevel: "off",
      retryDelaysMs: [],
      fallbackMode: "internal",
      fallbackRunner: { async run() { return { text: "下一个模型可用" }; } },
    });
    assert.deepEqual(
      await runner.run({ systemPrompt: "system", prompt: "hello", sessionId: "permission-rotation", tools: [] }),
      { text: "下一个模型可用" },
    );
  } finally {
    faux.unregister();
  }
});

test("Pi does not retry or fall back when a gateway wraps a safety refusal in HTTP 500", async () => {
  const faux = registerFauxProvider({ provider: uniqueProvider() });
  let fallbackCalls = 0;
  try {
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "HTTP 500 content_filter blocked_reason=safety policy violation",
      }),
      fauxAssistantMessage("不应调用"),
    ]);
    const runner = new PiAgentRunner({
      model: faux.getModel(),
      thinkingLevel: "off",
      retryDelaysMs: [0],
      fallbackRunner: {
        async run() {
          fallbackCalls += 1;
          return { text: "不应降级" };
        },
      },
    });
    await assert.rejects(
      runner.run({ systemPrompt: "system", prompt: "hello", sessionId: "no-safety-fallback", tools: [] }),
      /safety policy violation/u,
    );
    assert.equal(faux.state.callCount, 1);
    assert.equal(fallbackCalls, 0);
  } finally {
    faux.unregister();
  }
});

function uniqueProvider(): string {
  return `pi-bot-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
}
