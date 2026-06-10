import path from 'path';
import { v4 as uuid } from 'uuid';
import {
  buildClaimLedger,
  buildEvidenceMap,
  runResearchAgent as runSharedResearchAgent,
  type Claim,
  type Evidence,
  type ResearchInput,
  type ResearchOutput,
  type ResearchSearchScope,
  type SearchPlanItem,
} from '@aigc-video-hub/trustloop';
import {
  completeWithDoubao,
  createResponseWithDoubao,
  describeProviderError,
  fetchPublicHtml,
  isDoubaoTextConfigured,
  readDoubaoResponseText,
  readDoubaoUrlCitations,
} from '../providers/doubao';
import { ensureLocalDir, localPathExists, readLocalText, statLocalPath, writeLocalText } from '../providers/files';

export type { ResearchInput, ResearchOutput, ResearchSearchScope, SearchPlanItem };
export { buildClaimLedger, buildEvidenceMap };

function webSearchEnabled(): boolean {
  const value = (process.env.TRUSTLOOP_WEB_SEARCH || 'true').trim().toLowerCase();
  return value !== 'false' && value !== '0' && value !== 'off';
}

export async function runResearchAgent(input: ResearchInput & { noCache?: boolean }): Promise<ResearchOutput> {
  return runSharedResearchAgent(input, {
    fetchPublicHtml,
    completeText: completeWithDoubao,
    createResponse: createResponseWithDoubao,
    isTextConfigured: isDoubaoTextConfigured,
    describeProviderError,
    readResponseText: readDoubaoResponseText,
    readUrlCitations: readDoubaoUrlCitations,
    ensureLocalDir,
    localPathExists,
    readLocalText,
    statLocalPath,
    writeLocalText,
    cacheRoot: path.resolve(__dirname, '../../../var/research-cache'),
    fixtureRoot: path.resolve(__dirname, '../../../../../scripts/fixtures'),
    webSearchEnabled,
    createId: () => uuid(),
  });
}

export type { Claim, Evidence };
