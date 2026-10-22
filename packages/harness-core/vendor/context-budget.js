const DEFAULT_BUDGETS = Object.freeze({
  startup: 800,
  // The contract now also carries source readiness and permitted use, which the
  // original 300-token budget predates. Raised deliberately, not to hide growth:
  // the largest observed contract estimates 268, so this keeps real headroom
  // while still failing if the contract starts carrying prose.
  routing: 400,
  skill: 2500,
  rules: 800,
  sources: 3000,
  handoff: 1500,
  governance: 200,
});

// A single ratio cannot serve both scripts. Thai sits outside the dense part of
// a BPE vocabulary and costs roughly one token per character, while Latin text
// averages about four characters per token. Estimating Thai at the Latin rate
// under-reported Thai-heavy Skills by close to half, so budgets they exceeded
// were reported as fitting. Kept as a stated estimate: an exact count still
// requires the provider's own tokenizer, which arrives via actualTokens.
const THAI_CHARS_PER_TOKEN = 1.1;
const LATIN_CHARS_PER_TOKEN = 4;
const THAI_CHARACTER = /[฀-๿]/g;

export function estimateTextTokens(text = '') {
  const value = String(text || '');
  if (!value) {
    return { chars: 0, estimatedTokens: 0, actualTokens: null, method: 'script-aware-estimate-v2' };
  }

  const thaiChars = (value.match(THAI_CHARACTER) || []).length;
  const otherChars = value.length - thaiChars;
  return {
    chars: value.length,
    estimatedTokens: Math.ceil(thaiChars / THAI_CHARS_PER_TOKEN + otherChars / LATIN_CHARS_PER_TOKEN),
    actualTokens: null,
    method: 'script-aware-estimate-v2',
  };
}

/** Drop empty optional fields so healthy references stay cheap while problem
 * references keep the provenance a reviewer needs. */
function compactReference(ref = {}) {
  const compact = {
    id: ref.id,
    path: ref.path || '',
    status: ref.status || '',
    availability: ref.availability || 'not-checked',
  };
  if (ref.authority) compact.authority = ref.authority;
  if (ref.verification) compact.verification = ref.verification;
  return compact;
}

/** mandatoryReferences is the single source of reference detail. Readiness
 * issues only point at the offending id so the two do not duplicate fields. */
function compactReadiness(readiness = { status: 'ready', issues: [] }) {
  return {
    status: readiness.status || 'ready',
    issues: (readiness.issues || []).map((issue) => ({ type: issue.type, id: issue.id })),
  };
}

function compactScope(scopeResult = {}) {
  return {
    status: scopeResult.status || 'ALLOW',
    inScope: scopeResult.inScope !== false,
    targetRole: scopeResult.targetRole || '',
    authority: scopeResult.authority || '',
    targetSkill: scopeResult.targetSkill || '',
    playbookStep: scopeResult.playbookStep || '',
  };
}

export function buildCompactRoutingContract({
  selectedSkill = null,
  selectedPlaybook = null,
  playbookPlan = [],
  teamInfo = {},
  scopeResult = {},
  bestMatch = null,
  routingConfidence = null,
  skillMetadata = null,
  referenceMetadata = [],
  clarification = null,
  generalAssist = false,
  contextPolicy = null,
  readiness = { status: 'ready', issues: [] },
} = {}) {
  const halted = ['BLOCK', 'ESCALATE'].includes(scopeResult.status) || readiness.status === 'unavailable';
  const general = generalAssist && !halted && !selectedPlaybook && !clarification;
  const contract = {
    version: 1,
    routingEngine: 'local-deterministic',
    routerRegistrySentToModel: false,
    contextPolicy: {
      currentTurn: contextPolicy?.currentTurn || 'authoritative',
      history: contextPolicy?.history || 'ignore',
      carryover: contextPolicy?.carryover === true,
    },
    mode: scopeResult.status === 'BLOCK' ? 'BLOCK' : scopeResult.status === 'ESCALATE' ? 'ESCALATE'
      : readiness.status === 'unavailable' ? 'UNAVAILABLE' : selectedPlaybook ? 'PLAYBOOK' : clarification ? 'CLARIFY'
        : general ? 'GENERAL' : 'SKILL',
    team: general ? '' : teamInfo?.id || '',
    skill: halted || general ? '' : selectedSkill?.name || '',
    skillPath: halted ? '' : skillMetadata?.path || '',
    process: halted ? '' : selectedSkill?.processId || '',
    readiness: compactReadiness(readiness),
    permittedUse: halted ? 'none' : general ? 'general-assist-without-org-source'
      : readiness.status === 'partial' ? 'draft-with-source-gaps' : 'assist-with-human-authority',
    // Backward compatibility: confidence remains the deterministic match score.
    confidence: bestMatch ? Number(bestMatch.score.toFixed(3)) : null,
    matchScore: bestMatch ? Number(bestMatch.score.toFixed(3)) : null,
    confidenceTier: routingConfidence?.tier || bestMatch?.tier || '',
    confidenceReason: routingConfidence?.reason || '',
    confidenceMargin: routingConfidence?.margin ?? null,
    playbook: halted ? '' : selectedPlaybook?.id || '',
    steps: (halted ? [] : playbookPlan || []).map((step) => ({
      id: step.id,
      type: step.type,
      skill: step.skill || '',
      action: step.action || '',
    })),
    mandatoryReferences: (referenceMetadata || []).map(compactReference),
    authority: compactScope(scopeResult),
  };

  if (clarification) contract.clarification = clarification;
  return contract;
}

export function buildContextBudgetPlan({
  startupText = '',
  routingContract = {},
  skillText = '',
  ruleTexts = [],
  sourceTexts = [],
  handoff = null,
  governanceText = '',
  budgets = {},
} = {}) {
  const limit = { ...DEFAULT_BUDGETS, ...budgets };
  const startup = String(startupText || '');
  const routingText = JSON.stringify(routingContract);
  const rulesText = (ruleTexts || []).join('\n');
  const sourcesText = (sourceTexts || []).join('\n');
  const handoffText = handoff ? JSON.stringify(handoff) : '';
  const governance = String(governanceText || '');

  const components = {
    startup: { ...estimateTextTokens(startup), budget: limit.startup },
    routing: { ...estimateTextTokens(routingText), budget: limit.routing },
    skill: { ...estimateTextTokens(skillText), budget: limit.skill },
    rules: { ...estimateTextTokens(rulesText), budget: limit.rules },
    sources: { ...estimateTextTokens(sourcesText), budget: limit.sources },
    handoff: { ...estimateTextTokens(handoffText), budget: limit.handoff },
    governance: { ...estimateTextTokens(governance), budget: limit.governance },
  };

  for (const value of Object.values(components)) {
    value.overBudget = value.estimatedTokens > value.budget;
  }

  return {
    version: 1,
    policy: 'progressive-disclosure',
    budgets: limit,
    components,
    estimatedHarnessTokens: Object.values(components)
      .reduce((sum, item) => sum + item.estimatedTokens, 0),
    routerRegistryIncluded: false,
    fullSkillInventoryIncluded: false,
    unrelatedRulesIncluded: false,
  };
}

function clampString(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 24)) + '…[handoff-truncated]';
}

function summarizeValue(value, maxChars) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) {
    return { value: structuredClone(value), truncation: null };
  }

  if (typeof value === 'string') {
    return {
      value: clampString(value, Math.max(40, maxChars)),
      truncation: { kind: 'string', originalChars: value.length },
    };
  }

  if (Array.isArray(value)) {
    const preview = [];
    const contentBudget = Math.max(40, maxChars - 120);
    for (const item of value) {
      const itemText = JSON.stringify(item);
      const used = JSON.stringify(preview).length;
      const remaining = contentBudget - used;
      if (remaining < 40) break;
      if (itemText.length <= remaining) {
        preview.push(structuredClone(item));
      } else if (preview.length === 0) {
        preview.push({ compactSummary: clampString(itemText, remaining) });
      } else {
        break;
      }
    }
    return {
      value: preview,
      truncation: {
        kind: 'array',
        originalItems: value.length,
        includedItems: preview.length,
      },
    };
  }

  if (value && typeof value === 'object') {
    const preview = {};
    const entries = Object.entries(value);
    const contentBudget = Math.max(40, maxChars - 140);
    for (const [key, item] of entries) {
      const candidate = { ...preview, [key]: item };
      if (JSON.stringify(candidate).length <= contentBudget) {
        preview[key] = structuredClone(item);
      } else if (Object.keys(preview).length === 0) {
        preview[key] = clampString(JSON.stringify(item), Math.max(40, contentBudget - key.length));
      } else {
        break;
      }
    }
    return {
      value: preview,
      truncation: {
        kind: 'object',
        originalKeys: entries.length,
        includedKeys: Object.keys(preview).length,
      },
    };
  }

  return {
    value: String(value),
    truncation: { kind: typeof value, originalChars: serialized.length },
  };
}

export function buildStructuredHandoff(step, outputs = {}, {
  maxEstimatedTokens = DEFAULT_BUDGETS.handoff,
} = {}) {
  const produces = Array.isArray(step?.produces) ? step.produces : [];
  const fullEnvelope = {
    version: 1,
    fromStep: step?.id || '',
    producedKeys: produces,
    data: structuredClone(outputs),
  };

  let telemetry = estimateTextTokens(JSON.stringify(fullEnvelope));
  if (telemetry.estimatedTokens <= maxEstimatedTokens) {
    return { ...fullEnvelope, truncated: false, telemetry };
  }

  // Budget characters at the Thai rate: assuming the Latin rate here would hand
  // a Thai handoff roughly twice the characters its token budget allows.
  const maxChars = Math.floor(maxEstimatedTokens * THAI_CHARS_PER_TOKEN);
  const entries = Object.entries(outputs || {});
  const perKeyBudget = Math.max(80, Math.floor((maxChars - 500) / Math.max(1, entries.length)));
  const data = {};
  const truncation = {};
  for (const [key, value] of entries) {
    const summary = summarizeValue(value, perKeyBudget);
    data[key] = summary.value;
    if (summary.truncation) truncation[key] = summary.truncation;
  }

  let compactEnvelope = {
    version: 1,
    fromStep: step?.id || '',
    producedKeys: produces,
    data,
    truncated: true,
    truncation,
    fullOutputRetainedInRunState: true,
  };
  telemetry = estimateTextTokens(JSON.stringify(compactEnvelope));

  if (telemetry.estimatedTokens > maxEstimatedTokens + 50) {
    compactEnvelope = {
      version: 1,
      fromStep: step?.id || '',
      producedKeys: produces,
      data: Object.fromEntries(entries.map(([key]) => [key, '[truncated; inspect full run output]'])),
      truncated: true,
      truncation: Object.fromEntries(entries.map(([key, value]) => [key, {
        kind: Array.isArray(value) ? 'array' : typeof value,
        originalChars: JSON.stringify(value).length,
      }])),
      fullOutputRetainedInRunState: true,
    };
    telemetry = estimateTextTokens(JSON.stringify(compactEnvelope));
  }

  return { ...compactEnvelope, telemetry };
}

export function getStepHandoffContext(state, stepId = '') {
  const step = state?.steps?.find((item) => item.id === stepId)
    || state?.steps?.find((item) => item.id === state?.currentStep);
  if (!step) return { version: 1, consumes: [], inputs: {} };

  const consumes = Array.isArray(step.consumes) ? step.consumes : [];
  const inputs = {};
  const handoffs = state?.context?.handoffs || {};

  for (const handoff of Object.values(handoffs)) {
    const data = handoff?.data;
    if (!data || typeof data !== 'object') continue;

    for (const key of consumes) {
      if (Object.hasOwn(data, key)) inputs[key] = data[key];
    }
  }

  if (consumes.includes('source-references') && !Object.hasOwn(inputs, 'source-references')) {
    inputs['source-references'] = state?.sourceRefs || [];
  }

  // Compatibility fallback: some current Skills return compact objects whose
  // keys do not exactly match Playbook produces/consumes yet.
  if (Object.keys(inputs).length === 0 && consumes.length > 0) {
    const previous = Object.values(handoffs).at(-1);
    if (previous?.data) inputs.previousStep = previous.data;
  }

  return {
    version: 1,
    stepId: step.id,
    consumes,
    inputs,
    telemetry: estimateTextTokens(JSON.stringify(inputs)),
  };
}

export function createUsageTelemetry({
  queryText = '',
  startupText = '',
  routingContract = null,
  skillText = '',
  ruleTexts = [],
  sourceTexts = [],
  handoff = null,
  governanceText = '',
  actualInputTokens = null,
  actualOutputTokens = null,
} = {}) {
  const task = estimateTextTokens(queryText);
  const plan = buildContextBudgetPlan({
    startupText,
    routingContract: routingContract || {},
    skillText,
    ruleTexts,
    sourceTexts,
    handoff,
    governanceText,
  });

  return {
    version: 1,
    accounting: actualInputTokens === null && actualOutputTokens === null
      ? 'estimated'
      : 'provider-reported-partial',
    estimateMethod: 'char-estimate-v1',
    inputTokens: actualInputTokens,
    outputTokens: actualOutputTokens,
    taskData: task,
    harnessContext: {
      estimatedTokens: plan.estimatedHarnessTokens,
      actualTokens: null,
    },
    components: plan.components,
  };
}

export function mergeActualUsage(usage = {}, {
  inputTokens = null,
  outputTokens = null,
} = {}) {
  return {
    ...usage,
    accounting: inputTokens !== null || outputTokens !== null
      ? 'provider-reported-partial'
      : usage.accounting || 'estimated',
    inputTokens: inputTokens ?? usage.inputTokens ?? null,
    outputTokens: outputTokens ?? usage.outputTokens ?? null,
  };
}

export { DEFAULT_BUDGETS };
