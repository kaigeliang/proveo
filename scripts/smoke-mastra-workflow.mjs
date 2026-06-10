// Verifies the Mastra workflow adapter without calling external models,
// Seedance, FFmpeg, Redis, or Postgres.
//
// Usage: node scripts/smoke-mastra-workflow.mjs
// Add --skip-build to reuse an existing apps/api/dist build.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runNpm } from './lib/run-npm.mjs';

const distEntry = new URL('../packages/agent-runtime/dist/mastra-workflow.js', import.meta.url);
const skipBuild = process.argv.includes('--skip-build');

if (!skipBuild || !existsSync(fileURLToPath(distEntry))) {
  runNpm(['run', 'build', '--prefix', 'packages/agent-runtime']);
}

const { getMastraProductionWorkflowRuntimeSummary, mastraProductionWorkflow, planMastraAgentRunDispatch } =
  await import(distEntry.href);

const summary = getMastraProductionWorkflowRuntimeSummary();
const requiredPrimitives = ['branch', 'parallel', 'step'];

for (const primitive of requiredPrimitives) {
  if (!summary.primitives.includes(primitive)) {
    console.error(`Mastra workflow is missing ${primitive} primitive`);
    console.error(JSON.stringify(summary, null, 2));
    process.exit(1);
  }
}

if (!summary.committed || summary.executionLayer !== 'BullMQ + Postgres + Worker') {
  console.error('Mastra workflow must be committed and preserve the existing execution layer');
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}

const confirmedRun = await mastraProductionWorkflow.createRun({ runId: 'mastra_confirmed_smoke' });
const confirmed = await confirmedRun.start({
  inputData: {
    productTitle: 'Portable blender',
    hasResearch: true,
    hasScript: true,
    renderConsent: true,
    approvalAction: 'confirm_render',
    target: 'video',
  },
});

if (confirmed.status !== 'success' || confirmed.result?.status !== 'completed') {
  console.error('Confirmed Mastra workflow path should complete');
  console.error(JSON.stringify(confirmed, null, 2));
  process.exit(1);
}

const renderDispatch = confirmed.result.dispatches.find((dispatch) => dispatch.nodeId === 'render.dispatch');
if (renderDispatch?.target !== 'BullMQ:aigc.agent' || renderDispatch.queued !== false) {
  console.error('Render dispatch must stay a BullMQ descriptor and not execute inline');
  console.error(JSON.stringify(confirmed.result.dispatches, null, 2));
  process.exit(1);
}

const scriptPlan = await planMastraAgentRunDispatch({
  kind: 'script_generate',
  runId: 'run_script_plan_smoke',
  runInput: {
    productTitle: 'Portable blender',
    productUrl: 'https://example.com/products/blender',
  },
});

if (scriptPlan.status !== 'success' || scriptPlan.result?.status !== 'dispatched') {
  console.error('Script AgentRun planning should stop after script dispatch');
  console.error(JSON.stringify(scriptPlan, null, 2));
  process.exit(1);
}

const scriptDispatch = scriptPlan.result.dispatches.find((dispatch) => dispatch.nodeId === 'script.compose');
if (scriptDispatch?.target !== 'BullMQ:aigc.script' || scriptDispatch.queued !== false) {
  console.error('Script dispatch must stay a BullMQ descriptor and not execute inline');
  console.error(JSON.stringify(scriptPlan.result.dispatches, null, 2));
  process.exit(1);
}

const suspendedRun = await mastraProductionWorkflow.createRun({ runId: 'mastra_suspended_smoke' });
const suspended = await suspendedRun.start({
  inputData: {
    productTitle: 'Portable blender',
    hasResearch: true,
    hasScript: true,
    renderConsent: true,
    target: 'video',
  },
});

if (suspended.status !== 'suspended') {
  console.error('Unconfirmed Mastra workflow path should suspend at storyboard approval');
  console.error(JSON.stringify(suspended, null, 2));
  process.exit(1);
}

console.log(
  `Validated Mastra workflow ${summary.workflowId}: primitives=${summary.primitives.join(', ')}, confirmed=${confirmed.status}, scriptPlan=${scriptPlan.result.status}, unconfirmed=${suspended.status}`,
);
