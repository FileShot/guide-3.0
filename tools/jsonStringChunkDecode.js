'use strict';

/**
 * Stream-decode a fragment of a JSON string value (no surrounding quotes).
 * Handles escape sequences that may be split across chunk boundaries.
 */
function jsonStringChunkDecode(chunk, escPending) {
  let out = '';
  let i = 0;
  if (escPending && chunk.length > 0) {
    const c = chunk[0];
    switch (c) {
      case '"':  out += '"';  break;
      case '\\': out += '\\'; break;
      case '/':  out += '/';  break;
      case 'n':  out += '\n'; break;
      case 'r':  out += '\r'; break;
      case 't':  out += '\t'; break;
      case 'b':  out += '\b'; break;
      case 'f':  out += '\f'; break;
      default:   out += '\\' + c;
    }
    i = 1;
  }
  while (i < chunk.length) {
    const c = chunk[i];
    if (c === '\\') {
      if (i + 1 < chunk.length) {
        const nc = chunk[i + 1];
        switch (nc) {
          case '"':  out += '"';  break;
          case '\\': out += '\\'; break;
          case '/':  out += '/';  break;
          case 'n':  out += '\n'; break;
          case 'r':  out += '\r'; break;
          case 't':  out += '\t'; break;
          case 'b':  out += '\b'; break;
          case 'f':  out += '\f'; break;
          default:   out += '\\' + nc;
        }
        i += 2;
      } else {
        return { out, escPending: true, ended: false };
      }
    } else if (c === '"') {
      return { out, escPending: false, ended: true };
    } else {
      out += c;
      i++;
    }
  }
  return { out, escPending: false, ended: false };
}

module.exports = { jsonStringChunkDecode };
