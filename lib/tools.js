// lib/tools.js
// OpenAI-compatible tool schema + hand-written schema validator.
// One validator used by both the strict text parser and the native tool_calls path.

export const TOOL_NAMES = [
  'navigate',
  'open_tab',
  'switch_tab',
  'read_page',
  'click',
  'type_text',
  'press_key',
  'scroll',
  'extract_text',
  'wait_for',
  'back',
  'refresh',
  'ask_user',
  'finish',
  'scratchpad_read',
  'scratchpad_write'
];

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the current tab to a URL. Prefer back() over navigate(previous_url) when returning to a recent page.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 2048 },
          risk_reason: { type: 'string', maxLength: 500 }
        },
        required: ['url'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_tab',
      description: 'Open a new tab at the given URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 2048 },
          risk_reason: { type: 'string', maxLength: 500 }
        },
        required: ['url'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'switch_tab',
      description: 'Make a different tab active by its tabId.',
      parameters: {
        type: 'object',
        properties: { tabId: { type: 'integer', minimum: 0 } },
        required: ['tabId'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: 'Return the current page snapshot (interactive elements with stable IDs). Use max/offset to page through.',
      parameters: {
        type: 'object',
        properties: {
          max: { type: 'integer', minimum: 1, maximum: 1000 },
          offset: { type: 'integer', minimum: 0 }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click the element with the given snapshot id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^e_[a-z0-9]+$' },
          risk_reason: { type: 'string', maxLength: 500 }
        },
        required: ['id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Type text into a field. May optionally press Enter afterwards.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^e_[a-z0-9]+$' },
          text: { type: 'string', maxLength: 4096 },
          pressEnter: { type: 'boolean' },
          risk_reason: { type: 'string', maxLength: 500 }
        },
        required: ['id', 'text'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: 'Press a keyboard key. Common: Enter, Tab, Escape, ArrowDown, ArrowUp.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 32 },
          risk_reason: { type: 'string', maxLength: 500 }
        },
        required: ['key'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll the page in a direction by a pixel amount.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'integer', minimum: 1, maximum: 5000 }
        },
        required: ['direction', 'amount'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'extract_text',
      description: 'Read text content. If id is given, read that element. Else read the page body.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^e_[a-z0-9]+$' },
          max: { type: 'integer', minimum: 1, maximum: 20000 },
          offset: { type: 'integer', minimum: 0 }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wait_for',
      description: 'Wait until an element appears. selector is a CSS selector; id is a snapshot id; text is a substring match in the page text.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', maxLength: 500 },
          id: { type: 'string', pattern: '^e_[a-z0-9]+$' },
          text: { type: 'string', maxLength: 200 },
          timeout: { type: 'integer', minimum: 100, maximum: 60000 }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'back',
      description: 'Go back in browser history.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'refresh',
      description: 'Reload the current page. bypassCache does a hard reload.',
      parameters: {
        type: 'object',
        properties: { bypassCache: { type: 'boolean' } },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Pause and ask the user a clarifying question. Optionally provide 2-6 short options.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 500 },
          options: { type: 'array', items: { type: 'string', maxLength: 80 }, minItems: 2, maxItems: 6 }
        },
        required: ['question'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'The task is complete. Provide the final answer for the user.',
      parameters: {
        type: 'object',
        properties: { answer: { type: 'string', minLength: 1, maxLength: 8000 } },
        required: ['answer'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scratchpad_read',
      description: 'Read the persistent scratchpad — use this to recall saved state such as download IDs, processed items, plans, and intermediate results.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scratchpad_write',
      description: 'Write to the persistent scratchpad to save state across steps (append or replace).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 4000 },
          mode: { type: 'string', enum: ['append', 'replace'] }
        },
        required: ['text'],
        additionalProperties: false
      }
    }
  }
];

// Hand-written schema validator. No external deps.
// validate(value, schema) -> { ok, value?, error? }

function fail(error) { return { ok: false, error }; }

function validateType(value, schema) {
  if (schema.type === 'string') {
    if (typeof value !== 'string') return fail('expected string');
    if ('minLength' in schema && value.length < schema.minLength) return fail(`string shorter than ${schema.minLength}`);
    if ('maxLength' in schema && value.length > schema.maxLength) return fail(`string longer than ${schema.maxLength}`);
    if ('pattern' in schema) {
      try { if (!new RegExp(schema.pattern).test(value)) return fail(`string does not match pattern ${schema.pattern}`); }
      catch { return fail('invalid pattern in schema'); }
    }
    if ('enum' in schema && !schema.enum.includes(value)) return fail(`string not in enum: ${schema.enum.join('|')}`);
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`expected ${schema.type}`);
    if (schema.type === 'integer' && !Number.isInteger(value)) return fail('expected integer');
    if ('minimum' in schema && value < schema.minimum) return fail(`value < ${schema.minimum}`);
    if ('maximum' in schema && value > schema.maximum) return fail(`value > ${schema.maximum}`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return fail('expected boolean');
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return fail('expected array');
    if ('minItems' in schema && value.length < schema.minItems) return fail(`array shorter than ${schema.minItems}`);
    if ('maxItems' in schema && value.length > schema.maxItems) return fail(`array longer than ${schema.maxItems}`);
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const r = validate(value[i], schema.items);
        if (!r.ok) return fail(`item[${i}]: ${r.error}`);
      }
    }
  } else if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('expected object');
  } else {
    return fail(`unknown schema type: ${schema.type}`);
  }
  return { ok: true, value };
}

export function validate(value, schema) {
  if (!schema || typeof schema !== 'object') return { ok: true, value };
  const t = validateType(value, schema);
  if (!t.ok) return t;
  if (schema.type === 'object') {
    const out = {};
    const props = schema.properties || {};
    const required = schema.required || [];
    for (const k of required) {
      if (!(k in value)) return fail(`missing required field: ${k}`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (k in props) {
        const r = validate(v, props[k]);
        if (!r.ok) return fail(`${k}: ${r.error}`);
        out[k] = r.value;
      } else if (schema.additionalProperties === false) {
        // drop extra keys silently for the validated form
      } else {
        out[k] = v;
      }
    }
    return { ok: true, value: out };
  }
  return t;
}

export function validateToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return { ok: false, error: 'not an object' };
  const { tool, args } = toolCall;
  if (typeof tool !== 'string') return { ok: false, error: 'tool must be a string' };
  if (!TOOL_NAMES.includes(tool)) return { ok: false, error: `unknown_tool: ${tool}` };
  if (args === undefined) return { ok: false, error: 'missing required field: args' };
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return { ok: false, error: 'args must be an object' };
  const toolSchema = TOOLS.find(t => t.function.name === tool).function.parameters;
  const r = validate(args, toolSchema);
  if (!r.ok) return { ok: false, error: `invalid_args: ${r.error}` };
  return { ok: true, value: { tool, args: r.value } };
}
