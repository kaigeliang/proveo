// TrustLoop Policy Agent —— 三层合规规则：block / warn / needs_evidence
// 替代 spec-runtime.ts 原扁平 complianceRules，但保留兼容字段（id/level/pattern/rule/suggestion）

import type { Claim, Evidence, PolicyLevel, Script } from '../../../../../packages/shared/types';

export type { PolicyLevel };

export type PolicyCategory =
  | 'absolute_claim'
  | 'medical'
  | 'price'
  | 'social_proof'
  | 'comparative'
  | 'scarcity'
  | 'evidence_required'
  | 'source_missing';

export interface PolicyRule {
  id: string;
  level: PolicyLevel;
  category: PolicyCategory;
  pattern: RegExp;
  rule: string;
  suggestion: string;
  lawRef?: string;
}

export const POLICY_RULES_V2: PolicyRule[] = [
  // ===== block 层（5 条）：触发即拒，必须重写 =====
  {
    id: 'absolute-claim',
    level: 'block',
    category: 'absolute_claim',
    pattern: /(根治|永久|100%|包治|无副作用|销量第一|全网第一|最有效|最强|最好|国家级|顶级)/i,
    rule: '《广告法》第九条禁止使用"国家级、最高级、最佳"等绝对化用语。',
    suggestion: '改用"适合日常使用""帮助改善体验"等可验证表达。',
    lawRef: '《广告法》§9',
  },
  {
    id: 'medical-claim',
    level: 'block',
    category: 'medical',
    pattern: /(治愈|治疗|药效|疗效|抗癌|降压|降糖|减肥神器|医美级|医用级)/i,
    rule: '非医疗器械/药品类目禁止使用医疗功效宣称。',
    suggestion: '改用"辅助舒缓""日常护理"等中性表达，并加"非医疗用途"声明。',
    lawRef: '《广告法》§17',
  },
  {
    id: 'comparative-attack',
    level: 'block',
    category: 'comparative',
    pattern: /(碾压|秒杀|吊打|完爆)\s*[A-Za-z一-龥]+/i,
    rule: '禁止贬低性比较，可能构成不正当竞争。',
    suggestion: '改用"相较同类产品""体验更优"等客观表达。',
    lawRef: '《反不正当竞争法》§11',
  },
  {
    id: 'false-authority',
    level: 'block',
    category: 'social_proof',
    pattern: /(央视推荐|国务院认证|央视独家|官方御用|皇家御用)/i,
    rule: '虚构权威背书属于虚假广告。',
    suggestion: '删除该表述；如有真实背书需提供凭证。',
    lawRef: '《广告法》§28',
  },
  {
    id: 'safety-violation',
    level: 'block',
    category: 'absolute_claim',
    pattern: /(绝对安全|零风险|绝无危险|保证不出事)/i,
    rule: '不得作出"绝对安全""零风险"等承诺。',
    suggestion: '改用"经过 N 项检测""通过 XX 认证"并附凭证。',
    lawRef: '《广告法》§9',
  },

  // ===== warn 层（4 条）：可发布但需提醒，建议软化 =====
  {
    id: 'price-pressure',
    level: 'warn',
    category: 'price',
    pattern: /(最低价|全网最低|错过后悔|马上抢光|只剩最后|今日最后)/i,
    rule: '价格与稀缺性表达需要可验证，否则有误导风险。',
    suggestion: '改用"以页面实时权益为准"或展示真实优惠信息。',
  },
  {
    id: 'scarcity-pressure',
    level: 'warn',
    category: 'scarcity',
    pattern: /(仅剩\s*\d+\s*件|仅限今日|限时\s*\d+\s*分钟)/i,
    rule: '稀缺性表达需要真实库存/时间数据支撑。',
    suggestion: '改为"库存有限"或引用真实库存接口。',
  },
  {
    id: 'vague-social-proof',
    level: 'warn',
    category: 'social_proof',
    pattern: /(用户都说好|大家都在用|火爆全网|万人种草)/i,
    rule: '泛化社会证明表达，缺乏数据支撑。',
    suggestion: '改用具体的样本数据或真实评价摘录。',
  },
  {
    id: 'urgency-overuse',
    level: 'warn',
    category: 'scarcity',
    pattern: /(立即下单|马上购买|抓紧时间|手慢无){2,}/i,
    rule: '催促语过度使用会降低观看体验。',
    suggestion: '保留一处即可，其余改为产品价值表达。',
  },

  // ===== needs_evidence 层（4 条）：必须能在 evidenceLedger 找到引用，否则降级 =====
  {
    id: 'sales-data',
    level: 'needs_evidence',
    category: 'evidence_required',
    pattern: /(销量\s*(突破|超过|达到)?\s*\d+|月销\s*\d+|累计售出\s*\d+)/i,
    rule: '具体销量数字必须有可追溯来源。',
    suggestion: '在 evidence 中关联店铺后台截图或第三方平台数据。',
  },
  {
    id: 'ranking-claim',
    level: 'needs_evidence',
    category: 'evidence_required',
    pattern: /(行业第\s*\d+|类目TOP\s*\d+|榜单第\s*\d+|排名第\s*\d+)/i,
    rule: '排名/榜单宣称必须能找到原始榜单链接。',
    suggestion: '关联榜单截图与发布时间，否则改为"用户评价良好"。',
  },
  {
    id: 'percentage-improvement',
    level: 'needs_evidence',
    category: 'evidence_required',
    pattern: /(提升\s*\d+\s*%|节省\s*\d+\s*%|减少\s*\d+\s*%)/i,
    rule: '百分比改善数据需有测试报告/对比依据。',
    suggestion: '关联测试报告原文，或改为"显著改善"等定性表达。',
  },
  {
    id: 'award-claim',
    level: 'needs_evidence',
    category: 'social_proof',
    pattern: /(荣获.*?奖|获得.*?认证|入选.*?名录|被.*?推荐)/i,
    rule: '获奖/认证宣称必须能提供颁奖机构与时间。',
    suggestion: '在 evidence 中关联证书原图或公告页。',
  },

  // ===== 兼容：原有 missing-source 规则保留为 warn =====
  {
    id: 'missing-source',
    level: 'warn',
    category: 'source_missing',
    pattern: /(^$)/, // 不参与文本匹配，由素材校验路径单独调用
    rule: '素材必须保留来源声明。',
    suggestion: '补充"商家上传""授权素材""系统生成素材"等来源。',
  },
];

// 在文本中找出所有命中规则
export function scanText(
  text: string,
  rules: PolicyRule[] = POLICY_RULES_V2,
): Array<{
  rule: PolicyRule;
  match: string;
}> {
  if (!text) return [];
  const hits: Array<{ rule: PolicyRule; match: string }> = [];
  for (const rule of rules) {
    if (rule.id === 'missing-source') continue; // 该规则由素材校验单独触发
    const matched = text.match(rule.pattern);
    if (matched) hits.push({ rule, match: matched[0] });
  }
  return hits;
}

// 单条 claim 的合规判定 + 是否有 evidence 支撑
export function validateClaim(
  claim: Claim,
  evidenceMap: Map<string, Evidence>,
): {
  status: 'approved' | 'needs_evidence' | 'blocked';
  hits: Array<{ ruleId: string; level: PolicyLevel; reason: string }>;
} {
  const hits = scanText(claim.text);
  const policyHits = hits.map((h) => ({
    ruleId: h.rule.id,
    level: h.rule.level,
    reason: `${h.rule.rule}（命中："${h.match}"）`,
  }));

  if (policyHits.some((h) => h.level === 'block')) {
    return { status: 'blocked', hits: policyHits };
  }

  const needsEvidence = policyHits.some((h) => h.level === 'needs_evidence');
  const hasEvidence = claim.evidenceIds.length > 0 && claim.evidenceIds.some((id) => evidenceMap.has(id));

  if (needsEvidence && !hasEvidence) {
    return { status: 'needs_evidence', hits: policyHits };
  }

  return { status: 'approved', hits: policyHits };
}

// 整剧本审计：对每个 shot 的 narration/subtitle 文本扫规则
export function validateScript(
  script: Script,
  ledger: Map<string, Claim>,
): {
  shotIssues: Array<{
    shotId: string;
    ruleId: string;
    level: PolicyLevel;
    text: string;
    matched: string;
    suggestion: string;
  }>;
  globalIssues: Array<{ ruleId: string; level: PolicyLevel; matched: string; suggestion: string }>;
} {
  const shotIssues: ReturnType<typeof validateScript>['shotIssues'] = [];
  for (const shot of script.shots) {
    const combinedText = [shot.narration, shot.subtitle, shot.visualDesc].filter(Boolean).join(' ');
    for (const hit of scanText(combinedText)) {
      shotIssues.push({
        shotId: shot.id,
        ruleId: hit.rule.id,
        level: hit.rule.level,
        text: combinedText,
        matched: hit.match,
        suggestion: hit.rule.suggestion,
      });
    }
  }

  const globalText = [script.narrative, script.visualStyle, script.bgm, ...script.constraints]
    .filter(Boolean)
    .join(' ');
  const globalIssues = scanText(globalText).map((h) => ({
    ruleId: h.rule.id,
    level: h.rule.level,
    matched: h.match,
    suggestion: h.rule.suggestion,
  }));

  // ledger 不参与规则扫描，但保留参数为后续 needs_evidence 反查留口
  void ledger;

  return { shotIssues, globalIssues };
}

// 兼容旧 complianceRules 形状导出（spec-runtime.ts ComplianceLevel 仅有 block/warn/pass）
// needs_evidence 在兼容层降级为 warn（提示而不拦截），真实三层语义请用 POLICY_RULES_V2
export const LEGACY_COMPLIANCE_RULES: Array<{
  id: string;
  level: 'block' | 'warn';
  pattern: RegExp;
  rule: string;
  suggestion: string;
}> = POLICY_RULES_V2.map((r) => ({
  id: r.id,
  level: r.level === 'block' ? ('block' as const) : ('warn' as const),
  pattern: r.pattern,
  rule: r.rule,
  suggestion: r.suggestion,
}));
