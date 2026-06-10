// Validates that the API-side agent UI event builder emits official AG-UI
// event shapes while keeping merchant-visible text free of internal handles.
//
// Usage: node scripts/smoke-agent-ui-protocol.mjs
// Add --skip-build to reuse an existing apps/api/dist build.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventSchemas } from '@ag-ui/core';
import { runNpm } from './lib/run-npm.mjs';

const distEntry = new URL('../apps/api/dist/apps/api/src/lib/agent-ui.js', import.meta.url);
const skipBuild = process.argv.includes('--skip-build');

if (!skipBuild || !existsSync(fileURLToPath(distEntry))) {
  runNpm(['run', 'build', '--prefix', 'apps/api']);
}

const { createAgentUiEventBuilder } = await import(distEntry.href);

const builder = createAgentUiEventBuilder({
  threadId: 'thread_protocol_smoke',
  runId: 'chat_protocol_smoke',
  messageId: 'msg_protocol_smoke',
});

const events = [
  builder.runStarted(),
  builder.state('preparing', 'running', '正在准备生产 Agent'),
  builder.toolStart('assess_project_brief', { intent: 'video' }, 1),
  builder.toolResult(
    'assess_project_brief',
    { intent: 'video' },
    {
      ok: true,
      action: 'brief_required',
      known: ['TikTok Shop US'],
      missing: ['商品链接、主图或核心卖点'],
      readyForScript: false,
    },
    1,
  ),
  builder.toolStart('search_reference_videos', { query: 'portable blender' }, 2),
  builder.toolResult(
    'search_reference_videos',
    { query: 'portable blender' },
    {
      ok: true,
      count: 3,
      mode: 'semantic',
    },
    2,
  ),
  builder.runStartedCustom({
    action: 'started_agent_run',
    runId: 'run_smoke_internal',
    taskId: 'task_smoke_internal',
    productId: 'prod_smoke_internal',
    kind: 'script',
  }),
  builder.text('好的，我先整理商品资料并生成剧本分镜。'),
  builder.textEnd(),
  builder.done(),
].filter(Boolean);

const forbiddenVisiblePattern =
  /(?:task|run|script|prod)_[A-Za-z0-9_-]+|workflowDecision|decisionReason|currentState|模型名|modelName/i;

function visiblePayloadText(event) {
  const chunks = [];
  if (event.ui) chunks.push(JSON.stringify(event.ui));
  if (event.state) chunks.push(JSON.stringify(event.state));
  if (event.snapshot) chunks.push(JSON.stringify(event.snapshot));
  if (event.value?.ui) chunks.push(JSON.stringify(event.value.ui));
  if (event.type === 'TEXT_MESSAGE_CONTENT') chunks.push(event.delta);
  return chunks.join('\n');
}

for (const event of events) {
  const parsed = EventSchemas.safeParse(event);
  if (!parsed.success) {
    console.error(`AG-UI schema validation failed for ${event.type}`);
    console.error(JSON.stringify(parsed.error.issues, null, 2));
    process.exit(1);
  }
  if (typeof event.timestamp !== 'number') {
    console.error(`AG-UI timestamp must be numeric for ${event.type}`);
    process.exit(1);
  }
  const visibleText = visiblePayloadText(event);
  if (forbiddenVisiblePattern.test(visibleText)) {
    console.error(`Merchant-visible AG-UI payload leaked internal detail for ${event.type}`);
    console.error(visibleText);
    process.exit(1);
  }
}

const finished = events.find((event) => event.type === 'RUN_FINISHED');
if (finished?.outcome?.type !== 'success') {
  console.error('RUN_FINISHED must use the AG-UI outcome object shape');
  process.exit(1);
}

const toolStart = events.find((event) => event.type === 'TOOL_CALL_START');
if (!toolStart?.toolCallName) {
  console.error('TOOL_CALL_START must include official toolCallName');
  process.exit(1);
}

console.log(`Validated ${events.length} AG-UI events: ${events.map((event) => event.type).join(', ')}`);
