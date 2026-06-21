// lib/usage.js
// Per-task usage accounting.

export function newCounters() {
  return {
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    toolExecutions: 0,
    toolBreakdown: {},
    elapsedTime: 0,
    modelTime: 0,
    approvals: { requested: 0, granted: 0, denied: 0, autoDenied: 0 },
    parseErrors: 0,
    injectionHits: 0,
    snapshotCount: 0,
    startedAt: Date.now(),
    endedAt: null,
    estimatedCostUSD: 0
  };
}

export function recordModelCall(counters, usage, modelTimeMs) {
  counters.modelCalls += 1;
  if (usage) {
    counters.promptTokens += usage.prompt_tokens || 0;
    counters.completionTokens += usage.completion_tokens || 0;
    counters.totalTokens += usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
  }
  counters.modelTime += modelTimeMs || 0;
}

export function recordToolExecution(counters, tool) {
  counters.toolExecutions += 1;
  counters.toolBreakdown[tool] = (counters.toolBreakdown[tool] || 0) + 1;
}

export function recordApproval(counters, kind) {
  counters.approvals.requested += 1;
  if (kind === 'granted') counters.approvals.granted += 1;
  else if (kind === 'denied') counters.approvals.denied += 1;
  else if (kind === 'autoDenied') counters.approvals.autoDenied += 1;
}

export function finalize(counters, profile) {
  counters.elapsedTime = (counters.endedAt || Date.now()) - counters.startedAt;
  if (profile && (profile.costPer1kPromptTokens != null || profile.costPer1kCompletionTokens != null)) {
    const pp = Number(profile.costPer1kPromptTokens || 0);
    const pc = Number(profile.costPer1kCompletionTokens || 0);
    counters.estimatedCostUSD = (counters.promptTokens / 1000) * pp + (counters.completionTokens / 1000) * pc;
  }
  return counters;
}
