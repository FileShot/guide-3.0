'use strict';

function createJsonStringStreamState() {
  return {
    escPending: false,
    quotePending: false,
    quotePendingWs: '',
    unicodeCount: 0,
    unicodeChars: '',
  };
}

function isJsonWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isJsonStructuralCloseChar(ch) {
  return ch === ',' || ch === '}';
}

function decodeJsonEscapeChar(ch) {
  switch (ch) {
    case '"': return '"';
    case '\\': return '\\';
    case '/': return '/';
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'b': return '\b';
    case 'f': return '\f';
    default: return '\\' + ch;
  }
}

/**
 * Stream-decode one character from a JSON string value (no surrounding quotes).
 * Structural close: `"` ends the string only when followed by optional whitespace
 * then `,` or `}` — interior quotes (e.g. HTML charset="UTF-8") stay in content.
 */
function jsonStringStreamStep(ch, state) {
  const st = state || createJsonStringStreamState();
  let out = '';
  let ended = false;
  let endReason = null;

  if (st.quotePending) {
    if (isJsonWs(ch)) {
      st.quotePendingWs += ch;
      return { out, state: st, ended, endReason };
    }
    if (isJsonStructuralCloseChar(ch)) {
      st.quotePending = false;
      st.quotePendingWs = '';
      ended = true;
      endReason = 'structural-close';
      return { out, state: st, ended, endReason };
    }
    out += '"' + st.quotePendingWs + ch;
    st.quotePending = false;
    st.quotePendingWs = '';
    return { out, state: st, ended, endReason };
  }

  if (st.unicodeCount > 0) {
    st.unicodeChars += ch;
    st.unicodeCount -= 1;
    if (st.unicodeCount === 0) {
      try {
        out += String.fromCharCode(parseInt(st.unicodeChars, 16));
      } catch {
        out += '\\u' + st.unicodeChars;
      }
      st.unicodeChars = '';
    }
    return { out, state: st, ended, endReason };
  }

  if (st.escPending) {
    if (ch === 'u') {
      st.unicodeCount = 4;
      st.unicodeChars = '';
    } else {
      out += decodeJsonEscapeChar(ch);
    }
    st.escPending = false;
    return { out, state: st, ended, endReason };
  }

  if (ch === '\\') {
    st.escPending = true;
    return { out, state: st, ended, endReason };
  }

  if (ch === '"') {
    st.quotePending = true;
    return { out, state: st, ended, endReason };
  }

  out += ch;
  return { out, state: st, ended, endReason };
}

function normalizeStreamState(stateOrEscPending) {
  if (stateOrEscPending && typeof stateOrEscPending === 'object') {
    return { ...createJsonStringStreamState(), ...stateOrEscPending };
  }
  const st = createJsonStringStreamState();
  if (stateOrEscPending) st.escPending = true;
  return st;
}

/**
 * Stream-decode a fragment of a JSON string value (no surrounding quotes).
 * Handles escape sequences and structural quote close across chunk boundaries.
 */
function jsonStringChunkDecode(chunk, stateOrEscPending) {
  let state = normalizeStreamState(stateOrEscPending);
  let out = '';
  let ended = false;
  let endReason = null;

  for (let i = 0; i < chunk.length; i++) {
    const step = jsonStringStreamStep(chunk[i], state);
    state = step.state;
    out += step.out;
    if (step.ended) {
      ended = true;
      endReason = step.endReason;
      break;
    }
  }

  return {
    out,
    state,
    escPending: state.escPending,
    ended,
    endReason,
  };
}

module.exports = {
  createJsonStringStreamState,
  jsonStringStreamStep,
  jsonStringChunkDecode,
};
