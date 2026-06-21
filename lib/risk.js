// lib/risk.js
// Risk classification for tool calls.
// Returns { level: 'R0'|'R1'|'R2'|'R3'|'R4', reason, requiresApproval, blocked, riskReason }

import { isCrossOrigin } from './allowlist.js';

const DESTRUCTIVE_TEXT = /(buy|purchase|pay|checkout|order|confirm|send|post|publish|delete|remove|sign[_\s-]?out|unsubscribe|cancel[_\s-]?(subscription|order|plan|membership))/i;
const PASSWORD_AUTOCOMPLETE = /^(current-|new-)?password$/;
const PAYMENT_AUTOCOMPLETE = /^cc-(number|csc|exp|exp-month|exp-year|name|given-name|family-name)$/;
const USERNAME_AUTOCOMPLETE = /^(username|email|tel)$/;
const OTP_AUTOCOMPLETE = /^(one-time-code|otp)$/;

const SENSITIVE_FIELD_NAMES = /(password|passwd|pwd|secret|token|api[-_]?key|otp|cc|card|cvv|csc|expir)/i;

/**
 * @param {object} args - already-validated tool call { tool, args }
 * @param {object} ctx - { currentOrigin, targetElement?: { tag, type, text, aria, autocomplete, name, role, hasDownloadAttr, isInForm, isSubmit }, profile: { allowlistMode } }
 * @returns {object}
 */
export function classify({ tool, args }, ctx) {
  const el = (ctx && ctx.targetElement) || null;
  const currentOrigin = (ctx && ctx.currentOrigin) || null;
  const elText = (el ? (el.text || '') : '') + ' ' + (el ? (el.aria || '') : '');
  const modelReason = (args && args.risk_reason) ? String(args.risk_reason).slice(0, 500) : '';

  const make = (level, reason, extras = {}) => ({
    level, reason, requiresApproval: false, blocked: false,
    riskReason: modelReason,
    ...extras
  });

  // --- R0 read tools ---
  if (['read_page', 'extract_text', 'scroll', 'wait_for', 'ask_user', 'finish'].includes(tool)) {
    return make('R0', 'read_or_meta');
  }

  // --- navigate / open_tab ---
  if (tool === 'navigate' || tool === 'open_tab') {
    const newOrigin = (() => {
      try { return new URL(args.url).origin; } catch { return null; }
    })();
    const cross = isCrossOrigin(currentOrigin, newOrigin);
    if (cross) {
      return make('R2', 'cross_origin_navigation', { originChange: { from: currentOrigin, to: newOrigin } });
    }
    return make('R1', 'same_origin_navigation', { originChange: { from: currentOrigin, to: newOrigin } });
  }

  // --- switch_tab, refresh, back ---
  if (tool === 'switch_tab' || tool === 'refresh') return make('R1', 'low_impact');
  if (tool === 'back') {
    // back() is treated same as cross-origin navigation if we know the history;
    // we can't know without resolving. Conservative: R2 if a previous origin was recorded and differs.
    const prev = ctx && ctx.previousOrigin;
    const cross = prev ? isCrossOrigin(currentOrigin, prev) : false;
    return make(cross ? 'R2' : 'R1', cross ? 'cross_origin_history' : 'same_origin_history');
  }

  // --- click ---
  if (tool === 'click') {
    if (el && el.hasDownloadAttr) return make('R4', 'download', { blocked: true });
    // User requested AI clicking to be pre-built default safe.
    return make('R1', 'safe_click');
  }

  // --- type_text ---
  if (tool === 'type_text') {
    if (!el) return make('R1', 'type_unknown_target');
    const ac = (el.autocomplete || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    if (el.type === 'password' || PASSWORD_AUTOCOMPLETE.test(ac) || SENSITIVE_FIELD_NAMES.test(name)) {
      if (PASSWORD_AUTOCOMPLETE.test(ac) || OTP_AUTOCOMPLETE.test(ac) || /password/.test(name) || el.type === 'password') {
        return make('R3', 'sensitive_field');
      }
      return make('R3', 'sensitive_field_name');
    }
    if (PAYMENT_AUTOCOMPLETE.test(ac) || SENSITIVE_FIELD_NAMES.test(name) && /(cc|card|cvv)/.test(name)) {
      return make('R3', 'payment_field');
    }
    if (USERNAME_AUTOCOMPLETE.test(ac) || ac === 'email' || ac === 'tel') {
      return make('R2', 'identifying_field');
    }
    if (el.isInForm) return make('R2', 'form_field');
    return make('R1', 'free_text');
  }

  // --- press_key ---
  if (tool === 'press_key') {
    if (args && /^enter$/i.test(args.key) && el && el.isInForm) return make('R2', 'enter_on_form');
    return make('R1', 'safe_key');
  }

  return make('R1', 'default');
}

export function requiresApproval(level, mode) {
  if (level === 'R4') return false; // blocked outright, not a prompt
  if (level === 'R0' || level === 'R1') return false;
  if (level === 'R2') return mode === 'every';
  if (level === 'R3') return true; // always
  return false;
}
