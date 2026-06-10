import type { ClaimItem, EvidenceItem, RenderResult, ResearchData, TaskStatus } from './studio-types';

export type MagicActId = 'research' | 'evidence' | 'compose' | 'render';
export type MagicActStatus = 'pending' | 'active' | 'done' | 'skipped' | 'error';

export interface MagicProgressActState {
  status: MagicActStatus;
  headline?: string;
  detail?: string;
  note?: string;
}

export interface MagicProgressState {
  acts: Record<MagicActId, MagicProgressActState>;
  subject?: string;
  productUrl?: string;
  productImageUrl?: string;
  evidenceSamples: EvidenceItem[];
  claimSamples: ClaimItem[];
  renderTask?: TaskStatus | null;
  renderResult?: RenderResult | null;
  baselineScriptId?: string;
  finalScriptId?: string;
  fallbackNotes: string[];
}

export const createMagicProgressState = (): MagicProgressState => ({
  acts: {
    research: { status: 'pending' },
    evidence: { status: 'pending' },
    compose: { status: 'pending' },
    render: { status: 'pending' },
  },
  evidenceSamples: [],
  claimSamples: [],
  fallbackNotes: [],
});

export function filterReferenceEvidence(research: ResearchData | null): EvidenceItem[] {
  if (!research) return [];
  return research.evidence.filter(
    (item) => item.sourceType === 'reference' || item.sourceType === 'web' || item.sourceType === 'review',
  );
}
