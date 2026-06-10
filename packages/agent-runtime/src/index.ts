export type AgentRunKind = 'one_click_video' | 'script_generate' | 'render_full' | 'repair_shot' | 'ab_test';
export type AgentRunStatus = 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';
export type AgentStepStatus = 'queued' | 'running' | 'skipped' | 'completed' | 'failed';
export type AgentNodeResultStatus = 'completed' | 'skipped' | 'failed' | 'waiting_input';

export type JsonMap = Record<string, unknown>;

export type AgentRunRecord = {
  id: string;
  taskId?: string | null;
  kind: string;
  status: string;
  graphVersion: string;
  productId?: string | null;
  scriptId?: string | null;
  videoId?: string | null;
  input: unknown;
  output?: unknown;
  error?: string | null;
};

export type AgentArtifactRecord = {
  id: string;
  runId: string;
  stepId?: string | null;
  type: string;
  content?: unknown;
  objectKey?: string | null;
  contentHash?: string | null;
};

export type AgentStepRecord = {
  id: string;
  runId: string;
  nodeId: string;
  agentName: string;
  status: string;
  attempt: number;
  inputRefs: string[];
  outputRefs: string[];
};

export type CreateAgentStepData = {
  id: string;
  runId: string;
  nodeId: string;
  agentName: string;
  status: AgentStepStatus;
  attempt?: number;
  inputRefs?: string[];
  startedAt?: Date;
};

export type UpdateAgentStepData = {
  status?: AgentStepStatus;
  outputRefs?: string[];
  decision?: string | null;
  reason?: string | null;
  error?: string | null;
  finishedAt?: Date | null;
};

export type CreateAgentArtifactData = {
  id: string;
  runId: string;
  stepId?: string;
  type: string;
  content?: JsonMap;
  objectKey?: string;
  contentHash?: string;
};

export type AgentRuntimeStore = {
  updateRun(
    id: string,
    input: { status?: AgentRunStatus; output?: JsonMap | null; error?: string | null },
  ): Promise<unknown>;
  createStep(input: CreateAgentStepData): Promise<AgentStepRecord>;
  updateStep(id: string, input: UpdateAgentStepData): Promise<unknown>;
  createArtifact(input: CreateAgentArtifactData): Promise<AgentArtifactRecord>;
};

export type AgentArtifactWriter = {
  create(input: Omit<CreateAgentArtifactData, 'id' | 'runId' | 'stepId'>): Promise<AgentArtifactRecord>;
};

export type AgentLogger = {
  info(message: string, data?: JsonMap): void;
  warn(message: string, data?: JsonMap): void;
  error(message: string, data?: JsonMap): void;
};

export type AgentNodeContext = {
  run: AgentRunRecord;
  stepId: string;
  input: JsonMap;
  artifacts: AgentArtifactWriter;
  tools: Record<string, unknown>;
  logger: AgentLogger;
  signal: AbortSignal;
};

export type AgentNodeResult<TOutput extends JsonMap = JsonMap> = {
  status: AgentNodeResultStatus;
  output?: TOutput;
  artifactRefs?: string[];
  decision: string;
  reason: string;
  next?: string[];
};

export type AgentNode<TOutput extends JsonMap = JsonMap> = {
  id: string;
  agentName: string;
  blocking: boolean;
  retry: { attempts: number; backoffMs: number };
  run(ctx: AgentNodeContext): Promise<AgentNodeResult<TOutput>>;
};

export type AgentGraph = {
  version: string;
  entry: string;
  nodes: Record<string, AgentNode>;
  edges: Array<{ from: string; to: string; when?: string }>;
};

export type AgentGraphFactory = () => AgentGraph;

export type AgentRegistryEntry = {
  kind: string;
  description?: string;
  createGraph: AgentGraphFactory;
};

export type AgentRegistry = {
  register(entry: AgentRegistryEntry): void;
  resolve(kind: string): AgentRegistryEntry | undefined;
  create(kind: string): AgentGraph | undefined;
  list(): Array<{ kind: string; description?: string }>;
};

export function createAgentRegistry(entries: AgentRegistryEntry[] = []): AgentRegistry {
  const registry = new Map<string, AgentRegistryEntry>();
  const api: AgentRegistry = {
    register(entry) {
      if (!entry.kind) throw new Error('Agent registry entry requires kind');
      registry.set(entry.kind, entry);
    },
    resolve(kind) {
      return registry.get(kind);
    },
    create(kind) {
      return registry.get(kind)?.createGraph();
    },
    list() {
      return [...registry.values()].map((entry) => ({
        kind: entry.kind,
        description: entry.description,
      }));
    },
  };
  entries.forEach((entry) => api.register(entry));
  return api;
}

export type ToolRunContext = {
  signal?: AbortSignal;
  logger?: AgentLogger;
  node?: AgentNodeContext;
};

export type ToolDefinition<TInput extends JsonMap = JsonMap, TOutput extends JsonMap = JsonMap> = {
  name: string;
  description?: string;
  run(input: TInput, context?: ToolRunContext): Promise<TOutput>;
};

export type ToolRegistry = {
  register(definition: ToolDefinition): void;
  resolve(name: string): ToolDefinition | undefined;
  execute(name: string, input: JsonMap, context?: ToolRunContext): Promise<JsonMap>;
  list(): Array<{ name: string; description?: string }>;
};

export function createToolRegistry(definitions: ToolDefinition[] = []): ToolRegistry {
  const registry = new Map<string, ToolDefinition>();
  const api: ToolRegistry = {
    register(definition) {
      if (!definition.name) throw new Error('Tool definition requires name');
      registry.set(definition.name, definition);
    },
    resolve(name) {
      return registry.get(name);
    },
    async execute(name, input, context) {
      const tool = registry.get(name);
      if (!tool) throw new Error(`Tool not found: ${name}`);
      return tool.run(input, context);
    },
    list() {
      return [...registry.values()].map((definition) => ({
        name: definition.name,
        description: definition.description,
      }));
    },
  };
  definitions.forEach((definition) => api.register(definition));
  return api;
}

export type ExecuteAgentGraphInput = {
  run: AgentRunRecord;
  graph: AgentGraph;
  store: AgentRuntimeStore;
  tools?: Record<string, unknown>;
  signal?: AbortSignal;
  logger?: AgentLogger;
  maxNodeVisits?: number;
  createId(prefix: string): string;
};

function defaultLogger(): AgentLogger {
  return {
    info() {
      return undefined;
    },
    warn() {
      return undefined;
    },
    error() {
      return undefined;
    },
  };
}

function normalizeInput(value: unknown): JsonMap {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonMap) : {};
}

function nextNodeIds(graph: AgentGraph, nodeId: string) {
  return graph.edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to);
}

async function wait(ms: number) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function executeAgentGraph(input: ExecuteAgentGraphInput) {
  const logger = input.logger || defaultLogger();
  const signal = input.signal || new AbortController().signal;
  const runInput = normalizeInput(input.run.input);
  const executed: string[] = [];
  const artifactRefs: string[] = [];
  const nodeQueue = [input.graph.entry];
  const queued = new Set(nodeQueue);
  const visitCounts = new Map<string, number>();
  const maxNodeVisits = Math.max(1, input.maxNodeVisits || 50);
  let previousOutput: JsonMap = {};

  await input.store.updateRun(input.run.id, { status: 'running', error: null });

  try {
    while (nodeQueue.length) {
      const nodeId = nodeQueue.shift();
      if (!nodeId) continue;
      queued.delete(nodeId);
      if (signal.aborted) throw new Error('Agent run aborted');
      const node = input.graph.nodes[nodeId];
      if (!node) throw new Error(`Agent node not found: ${nodeId}`);
      const nextVisitCount = (visitCounts.get(nodeId) || 0) + 1;
      if (nextVisitCount > maxNodeVisits) {
        throw new Error(`Agent node exceeded max visits: ${nodeId}`);
      }
      visitCounts.set(nodeId, nextVisitCount);

      const stepId = input.createId('step');
      await input.store.createStep({
        id: stepId,
        runId: input.run.id,
        nodeId,
        agentName: node.agentName,
        status: 'running',
        attempt: 1,
        inputRefs: artifactRefs,
        startedAt: new Date(),
      });

      const createArtifact: AgentArtifactWriter['create'] = async (artifact) => {
        const created = await input.store.createArtifact({
          ...artifact,
          id: input.createId('artifact'),
          runId: input.run.id,
          stepId,
        });
        artifactRefs.push(created.id);
        return created;
      };

      let lastError: unknown;
      let completedResult: AgentNodeResult | undefined;
      for (let attempt = 1; attempt <= Math.max(1, node.retry.attempts); attempt++) {
        try {
          const result = await node.run({
            run: input.run,
            stepId,
            input: {
              runInput,
              previous: previousOutput,
              artifactRefs: [...artifactRefs],
            },
            artifacts: { create: createArtifact },
            tools: input.tools || {},
            logger,
            signal,
          });

          const outputArtifact = result.output
            ? await createArtifact({
                type: `agent.node_output.${node.id}`,
                content: result.output,
              })
            : undefined;
          const refs = [...(result.artifactRefs || []), ...(outputArtifact ? [outputArtifact.id] : [])];

          await input.store.updateStep(stepId, {
            status: result.status === 'failed' ? 'failed' : result.status === 'skipped' ? 'skipped' : 'completed',
            outputRefs: refs,
            decision: result.decision,
            reason: result.reason,
            error: result.status === 'failed' ? result.reason : null,
            finishedAt: new Date(),
          });

          if (result.status === 'failed' && node.blocking) {
            throw new Error(result.reason || `Agent node failed: ${node.id}`);
          }

          previousOutput = result.output ? { ...previousOutput, ...result.output } : previousOutput;
          executed.push(node.id);
          completedResult = result;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < Math.max(1, node.retry.attempts)) {
            await wait(node.retry.backoffMs);
            continue;
          }
          await input.store.updateStep(stepId, {
            status: 'failed',
            decision: 'failed',
            reason: error instanceof Error ? error.message : 'Agent node failed',
            error: error instanceof Error ? error.message : 'Agent node failed',
            finishedAt: new Date(),
          });
          if (node.blocking) throw error;
          logger.warn(`Non-blocking agent node failed: ${node.id}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }

      if (lastError && node.blocking) throw lastError;

      if (completedResult?.status === 'waiting_input') {
        const output = {
          graphVersion: input.graph.version,
          executed,
          artifactRefs,
          result: previousOutput,
        };
        await input.store.updateRun(input.run.id, { status: 'waiting_input', output });
        return output;
      }

      const nextIds = completedResult?.next?.length ? completedResult.next : nextNodeIds(input.graph, nodeId);
      for (const next of nextIds) {
        if (!input.graph.nodes[next]) throw new Error(`Agent next node not found: ${next}`);
        if (!queued.has(next)) {
          nodeQueue.push(next);
          queued.add(next);
        }
      }
    }

    const output = {
      graphVersion: input.graph.version,
      executed,
      artifactRefs,
      result: previousOutput,
    };
    await input.store.updateRun(input.run.id, { status: 'completed', output });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agent orchestration failed';
    await input.store.updateRun(input.run.id, {
      status: message === 'Agent run aborted' ? 'cancelled' : 'failed',
      error: message,
    });
    throw error;
  }
}

export * from './mastra-workflow';
