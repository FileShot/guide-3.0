/** True if chunk is only whitespace or orphan fence markers (no substantive prose). */
export function isOrphanFenceChunk(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^`{3,}[a-z0-9_-]*\s*$/i.test(t)) return true;
  return false;
}

/** Remove non-markdown code fences from prose (file-routed content must not duplicate in text). */
export function stripPlainCodeFencesFromProse(text) {
  if (!text) return text;
  return String(text).replace(/```(?!markdown\b|md\b)[\w-]*\s*\n[\s\S]*?```/gi, '').trim();
}

/**
 * Split markdown into alternating prose and fenced code chunks (closed + optional open tail).
 */
export function splitMarkdownFences(content, streaming = false) {
  if (!content) return { chunks: [], openCode: null };

  const lines = content.split('\n');
  const chunks = [];
  let proseLines = [];
  let openFenceLen = 0;
  let openLang = '';
  let openFenceLine = -1;
  let codeLines = [];
  let inCode = false;
  let codeLang = '';

  const flushProse = () => {
    const text = proseLines.join('\n');
    if (text && !isOrphanFenceChunk(text)) {
      chunks.push({ type: 'prose', text });
    }
    proseLines = [];
  };

  const flushCode = () => {
    const text = codeLines.join('\n');
    if (text.trim()) {
      chunks.push({ type: 'code', lang: codeLang, text });
    }
    codeLines = [];
    codeLang = '';
    inCode = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(`{3,})(\w*)\s*$/);

    if (!inCode && fenceMatch) {
      flushProse();
      inCode = true;
      codeLang = fenceMatch[2] || '';
      codeLines = [];
      continue;
    }

    if (inCode && fenceMatch && fenceMatch[1].length >= 3) {
      flushCode();
      continue;
    }

    if (inCode) {
      codeLines.push(line);
    } else {
      proseLines.push(line);
    }
  }

  if (inCode) {
    if (streaming) {
      flushProse();
      const tail = codeLines.join('\n');
      return {
        chunks,
        openCode: { lang: codeLang, text: tail },
      };
    }
    flushCode();
  } else {
    flushProse();
  }

  if (streaming) {
    openFenceLen = 0;
    openLang = '';
    openFenceLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(`{3,})(\w*)/);
      if (m) {
        const len = m[1].length;
        if (openFenceLen === 0) {
          openFenceLen = len;
          openLang = m[2] || '';
          openFenceLine = i;
        } else if (len >= openFenceLen) {
          openFenceLen = 0;
          openLang = '';
          openFenceLine = -1;
        }
      }
    }
    if (openFenceLen > 0 && openFenceLine >= 0) {
      const stableLines = lines.slice(0, openFenceLine + 1);
      const tailLines = lines.slice(openFenceLine + 1);
      const stableText = stableLines.join('\n');
      const prior = chunks.length ? chunks[chunks.length - 1] : null;
      if (prior?.type === 'prose' && prior.text === stableText) {
        chunks.pop();
      } else if (stableText && !isOrphanFenceChunk(stableText)) {
        chunks.push({ type: 'prose', text: stableText });
      }
      return {
        chunks,
        openCode: { lang: openLang, text: tailLines.join('\n') },
      };
    }
  }

  return { chunks, openCode: null };
}

export function escapeProse(content) {
  if (!content) return '';
  const lines = content.split('\n');
  let openFenceLen = 0;
  const escapedLines = [];
  for (const line of lines) {
    const fenceMatch = line.match(/^(`{3,})/);
    if (fenceMatch) {
      const len = fenceMatch[1].length;
      if (openFenceLen === 0) openFenceLen = len;
      else if (len >= openFenceLen) openFenceLen = 0;
      escapedLines.push(line);
    } else if (openFenceLen > 0) {
      escapedLines.push(line);
    } else {
      escapedLines.push(line.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    }
  }
  let out = escapedLines.join('\n');
  if (openFenceLen > 0) out += '\n' + '`'.repeat(openFenceLen);
  return out;
}
