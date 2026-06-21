// lib/ai-client.js
// OpenAI-compatible chat client + auto-detect native vs text-parser.

import { parseTextToolCall } from './parser.js';

export class AIClient {
  constructor(profile) {
    this.profile = profile;
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.profile.apiKey) h['Authorization'] = `Bearer ${this.profile.apiKey}`;
    return h;
  }

  async chat({ messages, tools, signal }) {
    const url = (this.profile.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: this.profile.model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: this.profile.temperature != null ? this.profile.temperature : 0.2,
      ...(this.profile.maxTokens > 0 && { max_tokens: this.profile.maxTokens })
    };
    const headers = this._headers();

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const errMsg = `HTTP ${res.status}: ${text.slice(0, 500)}`;
      // Detect model-image-unsupported errors and give a clear message.
      if (errMsg.includes('image') && (errMsg.includes('not support') || errMsg.includes('image_url') || errMsg.includes('Cannot read'))) {
        throw new Error('This model does not support image input. Please switch to a vision-capable model in your profile settings, or remove any image references from your request.');
      }
      throw new Error(errMsg);
    }
    const json = await res.json();
    const choice = (json.choices && json.choices[0]) || {};
    const msg = choice.message || {};
    const usage = json.usage || null;
    const finishReason = choice.finish_reason || null;

    // Native tool calls?
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const calls = msg.tool_calls.map(c => {
        // OpenAI shape: { id, type: 'function', function: { name, arguments: string } }
        let args = {};
        try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; }
        catch { args = {}; }
        return { id: c.id || null, tool: c.function.name, args };
      });
      return {
        mode: 'native',
        content: msg.content || '',
        toolCalls: calls,
        commentary: msg.content || '',
        usage,
        finishReason
      };
    }

    // Text fallback.
    const text = msg.content || '';
    const parsed = parseTextToolCall(text);
    if (parsed.ok) {
      return {
        mode: 'text',
        content: parsed.commentary,
        toolCalls: [parsed.toolCall],
        commentary: parsed.commentary,
        usage,
        finishReason,
        parseExtrasDropped: parsed.extrasDropped
      };
    }
    // Plain text reply.
    return {
      mode: 'text',
      content: text,
      toolCalls: [],
      commentary: text,
      usage,
      finishReason,
      parseError: parsed.error
    };
  }
}
