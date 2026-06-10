// 对话生产主线的内核：一个 ARK function-calling 的工具循环 Agent。
// 模型自己决定调哪个工具（素材库检索 / 参考库检索 / 改分镜 / …），后端执行后把结果喂回，直到模型给出最终回复。
// 工具是「已有函数」的薄包装；慢任务（生成/渲染）后续以「异步派发」工具的形式接入。
import { completeWithDoubao, isDoubaoTextConfigured, streamChatCompletionWithDoubao } from './providers/doubao';

export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AgentTool = {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type AgentChatMessage = { role: 'user' | 'assistant'; content: string };

export type AgentStep = { tool: string; args: Record<string, unknown>; result: unknown };

export type AgentChatStreamEvent =
  | { type: 'status'; phase: 'thinking' | 'tooling' | 'typing' | 'wrapping'; step?: number }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown>; step: number }
  | { type: 'tool_result'; tool: string; args: Record<string, unknown>; result: unknown; step: number }
  | { type: 'token'; content: string }
  | { type: 'done'; reply: string; steps: AgentStep[] };

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type WorkingMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function finalReplyFromToolResult(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const row = result as Record<string, unknown>;
  if (typeof row.finalReply === 'string' && row.finalReply.trim()) return row.finalReply.trim();
  return '';
}

async function streamFinalReply(params: {
  messages: WorkingMessage[];
  maxTokens: number;
  onEvent?: (event: AgentChatStreamEvent) => void;
}): Promise<string> {
  if (!params.onEvent) {
    const response = await completeWithDoubao(
      {
        messages: params.messages,
        temperature: 0.3,
        max_tokens: params.maxTokens,
      },
      Number(process.env.ARK_TIMEOUT_MS || 60_000),
    );
    const message = response.choices?.[0]?.message as { content?: string } | undefined;
    return message?.content?.trim() || '';
  }

  const stream = await streamChatCompletionWithDoubao(
    {
      messages: params.messages,
      temperature: 0.3,
      max_tokens: params.maxTokens,
    },
    Number(process.env.ARK_TIMEOUT_MS || 60_000),
  );

  let reply = '';
  let sseBuffer = '';

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
      sseBuffer += chunk.toString('utf8');
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const raw = trimmed.slice(6);
        if (raw === '[DONE]') {
          resolve();
          return;
        }
        try {
          const parsed = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string } }> };
          const token = parsed.choices?.[0]?.delta?.content;
          if (typeof token === 'string' && token) {
            reply += token;
            params.onEvent?.({ type: 'token', content: token });
          }
        } catch {
          /* ignore malformed provider chunk */
        }
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return reply.trim();
}

export async function runAgentChat(params: {
  system: string;
  messages: AgentChatMessage[];
  tools: AgentTool[];
  maxSteps?: number;
  onEvent?: (event: AgentChatStreamEvent) => void;
}): Promise<{ reply: string; steps: AgentStep[] }> {
  if (!isDoubaoTextConfigured()) throw new Error('Doubao 文本模型未配置');
  const maxSteps = params.maxSteps ?? 6;
  const toolMap = new Map(params.tools.map((tool) => [tool.definition.function.name, tool]));
  const toolDefs = params.tools.map((tool) => tool.definition);

  const working: WorkingMessage[] = [
    { role: 'system', content: params.system },
    ...params.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  const steps: AgentStep[] = [];

  for (let i = 0; i < maxSteps; i++) {
    params.onEvent?.({ type: 'status', phase: 'thinking', step: i + 1 });
    const response = await completeWithDoubao(
      {
        messages: working,
        tools: toolDefs,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 900,
      },
      Number(process.env.ARK_TIMEOUT_MS || 60_000),
    );
    const message = response.choices?.[0]?.message as { content?: string; tool_calls?: ToolCall[] } | undefined;
    if (!message) break;

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (!toolCalls.length) {
      const direct = message.content?.trim() || '';
      if (!params.onEvent) {
        return { reply: direct || '（无回复）', steps };
      }
      params.onEvent?.({ type: 'status', phase: 'typing', step: i + 1 });
      // 模型这一步已经给出最终回复：直接分块流式吐出，省掉一次多余的 ARK 往返。
      if (direct) {
        for (let p = 0; p < direct.length; p += 8) {
          params.onEvent?.({ type: 'token', content: direct.slice(p, p + 8) });
        }
        params.onEvent?.({ type: 'done', reply: direct, steps });
        return { reply: direct, steps };
      }
      // 兜底：模型只发了空内容的收尾，才再要一次流式回复。
      const reply = await streamFinalReply({
        messages: [
          ...working,
          {
            role: 'user',
            content: '请基于当前上下文直接回复用户。回复要短，包含必要 id 或可行动原因，不要再调用工具。',
          },
        ],
        maxTokens: 700,
        onEvent: params.onEvent,
      });
      const finalReply = reply || '（无回复）';
      params.onEvent?.({ type: 'done', reply: finalReply, steps });
      return { reply: finalReply, steps };
    }

    working.push({
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: toolCalls,
    });
    params.onEvent?.({ type: 'status', phase: 'tooling', step: i + 1 });

    for (const call of toolCalls) {
      const tool = toolMap.get(call.function?.name);
      const args = parseArgs(call.function?.arguments || '');
      params.onEvent?.({ type: 'tool_call', tool: call.function?.name || 'unknown', args, step: i + 1 });
      let result: unknown;
      if (!tool) {
        result = { error: `未知工具：${call.function?.name}` };
      } else {
        try {
          result = await tool.execute(args);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : '工具执行失败' };
        }
      }
      steps.push({ tool: call.function?.name || 'unknown', args, result });
      params.onEvent?.({ type: 'tool_result', tool: call.function?.name || 'unknown', args, result, step: i + 1 });
      working.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function?.name,
        content: JSON.stringify(result),
      });

      const finalReply = finalReplyFromToolResult(result);
      if (finalReply) {
        params.onEvent?.({ type: 'done', reply: finalReply, steps });
        return { reply: finalReply, steps };
      }
    }
  }

  // 超过步数仍未收敛：让模型基于已有工具结果给个收尾回复（不再带工具）。
  params.onEvent?.({ type: 'status', phase: 'wrapping' });
  const reply =
    (await streamFinalReply({
      messages: [...working, { role: 'user', content: '请基于以上结果，用一句话简洁回复用户。' }],
      maxTokens: 400,
      onEvent: params.onEvent,
    })) || '我已经处理完上面的步骤。';
  params.onEvent?.({ type: 'done', reply, steps });
  return { reply, steps };
}
