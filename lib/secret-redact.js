// lib/secret-redact.js
// Per-rule secret redaction. Off by default; user opts in per rule.

const SETTINGS_DEFAULTS = {
  passwords: false,
  paymentFields: false,
  otp: false,
  usernames: false,
  cookies: false,
  apiTokens: false,
  apiKeyShapes: false,
  ccHeuristic: false
};

export function defaultRedactSettings() { return { ...SETTINGS_DEFAULTS }; }

function ccHeuristicRedact(text) {
  if (typeof text !== 'string') return text;
  // Look for 13-19 digit groups (with optional spaces/dashes) within ~200 chars of payment keywords.
  const keywordRe = /(cvv|csc|expir|expiry|credit\s*card|card\s*number|payment)/i;
  if (!keywordRe.test(text)) return text;
  return text.replace(/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED_CC_NUMBER]');
}

function apiKeyShapeRedact(text) {
  if (typeof text !== 'string') return text;
  const patterns = [
    /\bsk-[A-Za-z0-9]{20,}\b/g,            // OpenAI / many
    /\bAIza[A-Za-z0-9_\-]{20,}\b/g,        // Google
    /\bghp_[A-Za-z0-9]{20,}\b/g,           // GitHub PAT
    /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g,  // Slack
    /\bBearer\s+[A-Za-z0-9._\-]{16,}\b/gi  // Generic bearer
  ];
  let out = text;
  for (const p of patterns) out = out.replace(p, '[REDACTED_API_KEY]');
  return out;
}

function redactValue(value, rule, settings) {
  if (value == null) return value;
  if (rule === 'passwords' && settings.passwords) return '[REDACTED_PASSWORD]';
  if (rule === 'paymentFields' && settings.paymentFields) return '[REDACTED_CC_FIELD]';
  if (rule === 'otp' && settings.otp) return '[REDACTED_OTP]';
  if (rule === 'usernames' && settings.usernames) return '[REDACTED_USERNAME]';
  return value;
}

function redactString(s, settings) {
  if (typeof s !== 'string' || s.length === 0) return s;
  let out = s;
  if (settings.cookies) {
    out = out.replace(/(?:Set-Cookie|Cookie):\s*[^\n;]+/gi, '[REDACTED_COOKIE]');
  }
  if (settings.apiTokens) {
    out = out.replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._\-]+/gi, '[REDACTED_TOKEN]');
  }
  if (settings.apiKeyShapes) out = apiKeyShapeRedact(out);
  if (settings.ccHeuristic) out = ccHeuristicRedact(out);
  return out;
}

/**
 * Redact secret-shaped values inside a snapshot.
 * @param {object} snapshot - { url, title, elements: [{ id, tag, type, autocomplete, name, value, text, aria, ... }] }
 * @param {object} settings - redact settings
 */
export function redactSnapshot(snapshot, settings) {
  if (!snapshot) return snapshot;
  const s = { ...settings };
  const elements = (snapshot.elements || []).map(el => {
    const out = { ...el };
    const ac = (out.autocomplete || '').toLowerCase();
    const isOtp = ac === 'one-time-code' || ac === 'otp';
    const isPassword = (out.type || '').toLowerCase() === 'password' || ac === 'current-password' || ac === 'new-password' || /password/.test(out.name || '');
    const isPayment = /^cc-(number|csc|exp|name)/.test(ac) || /(cc|card|cvv|csc|expir)/i.test(out.name || '');
    const isUsername = ac === 'username' || ac === 'email' || ac === 'tel';

    if (isOtp && s.otp) out.value = redactValue(out.value, 'otp', s);
    if (isPassword && s.passwords) out.value = redactValue(out.value, 'passwords', s);
    if (isPayment && s.paymentFields) out.value = redactValue(out.value, 'paymentFields', s);
    if (isUsername && s.usernames) out.value = redactValue(out.value, 'usernames', s);

    // Text/aria still get pattern redactions.
    out.text = redactString(out.text, s);
    out.aria = redactString(out.aria, s);
    return out;
  });
  return { ...snapshot, elements };
}

/**
 * Redact a free-text extract (e.g. result of extract_text).
 */
export function redactExtract(text, settings) {
  return redactString(text, settings || SETTINGS_DEFAULTS);
}
