/**
 * MarkdownRenderer — ReactMarkdown wrapper with syntax highlighting and custom components.
 * Fenced code blocks render via plain CodeBlock (no rehype-highlight on fence bodies).
 * variant="think": same markdown, small dim text, plain <pre> fences (no CodeBlock chrome).
 * OneWriteOneCard1: when ownedFileBodies is set, skip CodeBlocks whose body is already
 * on a FileContentBlock (same bytes — no filename allowlists).
 */
import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import CodeBlock from './CodeBlock';
import MermaidBlock from './MermaidBlock';
import { splitMarkdownFences, isOrphanFenceChunk, escapeProse } from '../../utils/markdownFenceUtils.js';
import 'katex/dist/katex.min.css';

function sanitizeChildren(children) {
  if (children == null || typeof children === 'string' || typeof children === 'number' || typeof children === 'boolean') {
    return children;
  }
  if (children != null && typeof children === 'object' && children.$$typeof) {
    return children;
  }
  if (Array.isArray(children)) {
    return children.map(sanitizeChildren);
  }
  if (typeof children === 'object') {
    if (children.value != null) return String(children.value);
    if (children.children) return sanitizeChildren(children.children);
    return String(children);
  }
  return children;
}

function cleanBody(s) {
  return String(s || '').replace(/\s+$/g, '').replace(/"$/, '');
}

/** True when this fence body is already painted on a FileContentBlock (same write). */
function isOwnedFileBody(codeText, ownedFileBodies) {
  if (!Array.isArray(ownedFileBodies) || ownedFileBodies.length === 0) return false;
  const c = cleanBody(codeText);
  if (c.length < 20) return false;
  for (const body of ownedFileBodies) {
    const b = cleanBody(body);
    if (!b || b.length < 20) continue;
    if (b === c) return true;
    if (b.includes(c) || c.includes(b)) return true;
    const n = Math.min(160, b.length, c.length);
    if (n >= 40 && (b.slice(0, n) === c.slice(0, n) || b.slice(-n) === c.slice(-n))) return true;
  }
  return false;
}

function buildMarkdownComponents(ownedFileBodies) {
  return {
  pre({ children }) {
    return <>{children}</>;
  },

  code({ node, className, children, ...props }) {
    const hasLanguageClass = /language-/.test(className || '');
    const safeChildren = sanitizeChildren(children);

    if (hasLanguageClass || (node?.tagName === 'code' && node?.properties?.className)) {
      const classTokens = (className || '').split(' ').filter(c => c && c !== 'hljs');
      const langToken = classTokens.find(c => c.startsWith('language-'));
      const lang = langToken ? langToken.replace(/^language-/, '') : (classTokens[0] || '');
      if (lang === 'mermaid') {
        const text = Array.isArray(safeChildren) ? safeChildren.join('') : String(safeChildren || '');
        return <MermaidBlock>{text}</MermaidBlock>;
      }
      const codeText = Array.isArray(safeChildren) ? safeChildren.join('') : String(safeChildren || '');
      if (!codeText.trim()) return null;
      if (isProseTextFence(lang, codeText)) {
        return <p className="my-1.5 leading-relaxed">{codeText.trim()}</p>;
      }
      // OneWriteOneCard1: same bytes already on FileContentBlock — do not paint a second card.
      if (isOwnedFileBody(codeText, ownedFileBodies)) {
        return null;
      }
      return (
        <CodeBlock language={lang} className={className}>
          {safeChildren}
        </CodeBlock>
      );
    }

    return (
      <code className="bg-vsc-input px-1.5 py-0.5 rounded text-vsc-sm text-vsc-text-bright" {...props}>
        {safeChildren}
      </code>
    );
  },

  table({ children }) {
    return (
      <div className="overflow-x-auto my-2 rounded-md border border-vsc-panel-border/20">
        <table className="w-full border-collapse text-vsc-sm">{children}</table>
      </div>
    );
  },
  thead({ children }) { return <thead className="bg-vsc-sidebar">{children}</thead>; },
  th({ children }) {
    return (
      <th className="px-3 py-1.5 text-left font-semibold text-vsc-text-bright border-b border-vsc-panel-border/20">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="px-3 py-1.5 border-b border-vsc-panel-border/20 text-vsc-text">{children}</td>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-vsc-accent pl-3 ml-0 my-2 text-vsc-text-dim italic">
        {children}
      </blockquote>
    );
  },
  hr() { return <hr className="border-vsc-panel-border/20 my-4" />; },
  a({ href, children }) {
    return (
      <a href={href} className="text-vsc-accent hover:text-vsc-accent-hover hover:underline" target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    return (
      <img src={src} alt={alt || ''} className="max-w-full rounded-md border border-vsc-panel-border/20 my-2" loading="lazy" />
    );
  },
  p({ children }) { return <p className="my-1.5 leading-relaxed">{children}</p>; },
  ul({ children }) { return <ul className="list-disc ml-5 my-1.5 space-y-0.5">{children}</ul>; },
  ol({ children }) { return <ol className="list-decimal ml-5 my-1.5 space-y-0.5">{children}</ol>; },
  h1({ children }) { return <h1 className="text-vsc-xl font-semibold mt-3 mb-1 text-vsc-text-bright">{children}</h1>; },
  h2({ children }) { return <h2 className="text-vsc-lg font-semibold mt-3 mb-1 text-vsc-text-bright">{children}</h2>; },
  h3({ children }) { return <h3 className="text-vsc-base font-semibold mt-2 mb-1 text-vsc-text-bright">{children}</h3>; },
  };
}

/** ThinkMdFlat1: match reasoning dropdown text-[10px] text-vsc-text-dim — no CodeBlock chrome. */
const THINK_TEXT = 'text-[10px] leading-relaxed text-vsc-text-dim';
const thinkMarkdownComponents = {
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const hasLanguageClass = /language-/.test(className || '');
    const safeChildren = sanitizeChildren(children);
    const text = Array.isArray(safeChildren) ? safeChildren.join('') : String(safeChildren || '');
    if (hasLanguageClass) {
      if (!text.trim()) return null;
      return (
        <pre className={`think-md-pre my-0.5 whitespace-pre-wrap font-mono ${THINK_TEXT}`}>
          {text.replace(/\n$/, '')}
        </pre>
      );
    }
    return (
      <code className={`font-mono ${THINK_TEXT}`} {...props}>
        {safeChildren}
      </code>
    );
  },
  table({ children }) {
    return <div className="overflow-x-auto my-0.5"><table className={`w-full border-collapse ${THINK_TEXT}`}>{children}</table></div>;
  },
  thead({ children }) { return <thead>{children}</thead>; },
  th({ children }) { return <th className={`text-left font-medium ${THINK_TEXT} pr-2`}>{children}</th>; },
  td({ children }) { return <td className={`${THINK_TEXT} pr-2`}>{children}</td>; },
  blockquote({ children }) {
    return <blockquote className={`border-l border-vsc-panel-border pl-2 my-0.5 italic ${THINK_TEXT}`}>{children}</blockquote>;
  },
  hr() { return <hr className="border-vsc-panel-border/20 my-1" />; },
  a({ href, children }) {
    return (
      <a href={href} className={`${THINK_TEXT} underline`} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img() { return null; },
  p({ children }) { return <p className={`my-0.5 ${THINK_TEXT}`}>{children}</p>; },
  ul({ children }) { return <ul className={`list-disc ml-4 my-0.5 space-y-0 ${THINK_TEXT}`}>{children}</ul>; },
  ol({ children }) { return <ol className={`list-decimal ml-4 my-0.5 space-y-0 ${THINK_TEXT}`}>{children}</ol>; },
  li({ children }) { return <li className={THINK_TEXT}>{children}</li>; },
  h1({ children }) { return <p className={`my-0.5 font-medium ${THINK_TEXT}`}>{children}</p>; },
  h2({ children }) { return <p className={`my-0.5 font-medium ${THINK_TEXT}`}>{children}</p>; },
  h3({ children }) { return <p className={`my-0.5 font-medium ${THINK_TEXT}`}>{children}</p>; },
  h4({ children }) { return <p className={`my-0.5 font-medium ${THINK_TEXT}`}>{children}</p>; },
  h5({ children }) { return <p className={`my-0.5 font-medium ${THINK_TEXT}`}>{children}</p>; },
  h6({ children }) { return <p className={`my-0.5 font-medium ${THINK_TEXT}`}>{children}</p>; },
  strong({ children }) { return <strong className={`font-medium ${THINK_TEXT}`}>{children}</strong>; },
  em({ children }) { return <em className={THINK_TEXT}>{children}</em>; },
};

const remarkPlugins = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
const rehypePlugins = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
  rehypeKatex,
];
const thinkRehypePlugins = [rehypeKatex];

function isProseTextFence(lang, text) {
  const l = (lang || '').toLowerCase();
  if (l !== 'text' && l !== 'plaintext' && l !== 'txt') return false;
  const body = String(text || '').trim();
  if (!body || body.length > 120) return false;
  if (/[{[\]`$=<>]|function |import |const |class |<\/?\w+/.test(body)) return false;
  return true;
}

function ThinkFencePre({ text, lang }) {
  const body = String(text || '').replace(/\n$/, '');
  if (!body.trim()) return null;
  return (
    <pre className={`think-md-pre my-0.5 whitespace-pre-wrap font-mono ${THINK_TEXT}`} data-lang={lang || ''}>
      {body}
    </pre>
  );
}

function MarkdownRendererImpl({ content, streaming, variant, ownedFileBodies }) {
  const isThink = variant === 'think';
  const bodies = Array.isArray(ownedFileBodies) ? ownedFileBodies : [];
  const { chunks, openCode } = useMemo(
    () => splitMarkdownFences(content, streaming),
    [content, streaming],
  );
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(bodies),
    [bodies],
  );

  if (!content) return null;

  const components = isThink ? thinkMarkdownComponents : markdownComponents;
  const rehype = isThink ? thinkRehypePlugins : rehypePlugins;

  return (
    <div className={isThink ? 'markdown-body think-md' : 'markdown-body'}>
      {chunks.map((chunk, i) => {
        if (chunk.type === 'prose' && chunk.text && !isOrphanFenceChunk(chunk.text)) {
          const displayContent = escapeProse(chunk.text);
          return displayContent ? (
            <ReactMarkdown key={`prose-${i}`} remarkPlugins={remarkPlugins} rehypePlugins={rehype} components={components}>
              {displayContent}
            </ReactMarkdown>
          ) : null;
        }
        if (chunk.type === 'code' && chunk.text && chunk.text.trim()) {
          if (isThink) {
            return <ThinkFencePre key={`code-${i}`} text={chunk.text} lang={chunk.lang} />;
          }
          if (isProseTextFence(chunk.lang, chunk.text)) {
            return <p key={`code-prose-${i}`} className="my-1.5 leading-relaxed">{chunk.text.trim()}</p>;
          }
          // OneWriteOneCard1: FileContentBlock already owns these bytes.
          if (isOwnedFileBody(chunk.text, bodies)) {
            return null;
          }
          return (
            <CodeBlock key={`code-${i}`} language={chunk.lang || 'text'} streaming={streaming}>
              {chunk.text}
            </CodeBlock>
          );
        }
        return null;
      })}
      {openCode && (
        isThink ? (
          <ThinkFencePre text={openCode.text} lang={openCode.lang} />
        ) : isProseTextFence(openCode.lang, openCode.text) && openCode.text.trim() ? (
          <p className="my-1.5 leading-relaxed">{openCode.text.trim()}</p>
        ) : isOwnedFileBody(openCode.text, bodies) ? null : (
          <CodeBlock language={openCode.lang || 'text'} streaming>
            {openCode.text}
          </CodeBlock>
        )
      )}
    </div>
  );
}

const MarkdownRenderer = memo(MarkdownRendererImpl, (prev, next) => (
  prev.content === next.content
  && prev.streaming === next.streaming
  && prev.variant === next.variant
  && prev.ownedFileBodies === next.ownedFileBodies
));

export default MarkdownRenderer;
