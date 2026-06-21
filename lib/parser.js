// lib/parser.js
// Hardened text-based tool-call parser.
// Accepts ONLY the exact shape { "tool": "<name>", "args": { ... } }.

import { validateToolCall, TOOL_NAMES } from './tools.js';

const MAX_RAW = 4096;
const MAX_DEPTH = 6;
const FENCE_RE = /```(?:json)?\s*(\{[\s\S]{1,4096}?\})\s*```/m;
const ACTION_RE = /(?:^|\n)ACTION:\s*(\{[\s\S]{1,4096}?\})\s*(?:\n|$)/;

function checkDepth(s) {
  let depth = 0, maxDepth = 0, inString = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[' || c === '(') {
      depth++; if (depth > maxDepth) maxDepth = depth;
      if (depth > MAX_DEPTH) return false;
    } else if (c === '}' || c === ']' || c === ')') {
      depth--;
    }
  }
  return depth === 0;
}

function findFirstBlock(text) {
  const fence = text.match(FENCE_RE);
  if (fence) return { raw: fence[1], source: 'fence' };
  const action = text.match(ACTION_RE);
  if (action) return { raw: action[1], source: 'action' };
  return null;
}

/**
 * Parse a model text response for a tool call.
 * Returns { ok, toolCall | null, error | null, commentary, extrasDropped }
 */
export function parseTextToolCall(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, toolCall: null, error: 'empty text', commentary: '', extrasDropped: 0 };
  }
  if (text.length > 20000) {
    return { ok: false, toolCall: null, error: 'text too long', commentary: '', extrasDropped: 0 };
  }
  const block = findFirstBlock(text);
  if (!block) {
    return { ok: false, toolCall: null, error: 'no_action_block', commentary: text.trim(), extrasDropped: 0 };
  }
  if (block.raw.length > MAX_RAW) {
    return { ok: false, toolCall: null, error: 'json too large', commentary: text.trim(), extrasDropped: 0 };
  }
  if (!checkDepth(block.raw)) {
    return { ok: false, toolCall: null, error: 'json depth exceeded', commentary: text.trim(), extrasDropped: 0 };
  }
  let parsed;
  try { parsed = JSON.parse(block.raw); }
  catch (e) { return { ok: false, toolCall: null, error: 'json_parse_error: ' + e.message, commentary: text.trim(), extrasDropped: 0 }; }

  // Strict shape: exactly { tool, args } — extra keys dropped with warning.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, toolCall: null, error: 'top-level must be object', commentary: text.trim(), extrasDropped: 0 };
  }
  const keys = Object.keys(parsed);
  if (!('tool' in parsed) || !('args' in parsed)) {
    return { ok: false, toolCall: null, error: 'shape: must be exactly {tool, args}', commentary: text.trim(), extrasDropped: 0 };
  }
  const hasUnknownTopKey = keys.some(k => k !== 'tool' && k !== 'args');
  // The validator will also drop extras; this counts them for the warning.
  const extrasDropped = hasUnknownTopKey ? keys.filter(k => k !== 'tool' && k !== 'args').length : 0;

  const r = validateToolCall(parsed);
  if (!r.ok) {
    return { ok: false, toolCall: null, error: r.error, commentary: text.trim(), extrasDropped };
  }

  // Strip the action block from commentary.
  let commentary = text;
  if (block.source === 'fence') commentary = commentary.replace(FENCE_RE, '').trim();
  else commentary = commentary.replace(ACTION_RE, '').trim();

  return { ok: true, toolCall: r.value, error: null, commentary, extrasDropped };
}

export function isToolCallShape(value) {
  return value && typeof value === 'object' && 'tool' in value && 'args' in value;
}
