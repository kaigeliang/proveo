import type { Express } from 'express';
import { summarizeAgentWorkflowBlueprint, THREE_AGENT_BLUEPRINT } from './workflow';

export function registerAgentWorkflowRoutes(app: Express) {
  app.get('/api/agents/workflow', (_req, res) => {
    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      ...summarizeAgentWorkflowBlueprint(),
      threeAgents: THREE_AGENT_BLUEPRINT,
    });
  });
}
