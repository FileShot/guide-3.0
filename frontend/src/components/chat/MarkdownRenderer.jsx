/**
 * MarkdownRenderer — ReactMarkdown wrapper with syntax highlighting and custom components.
 * Fenced code blocks render via plain CodeBlock (no rehype-highlight on fence bodies).
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

const markdownComponents = {
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

const remarkPlugins = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
const rehypePlugins = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
  rehypeKatex,
];

function isProseTextFence(lang, text) {
  const l = (lang || '').toLowerCase();
  if (l !== 'text' && l !== 'plaintext' && l !== 'txt') return false;
  const body = String(text || '').trim();
  if (!body || body.length > 120) return false;
  if (/[{[\]`$=<>]|function |import |const |class |<\/?\w+/.test(body)) return false;
  return true;
}

function MarkdownRendererImpl({ content, streaming }) {
  const { chunks, openCode } = useMemo(
    () => splitMarkdownFences(content, streaming),
    [content, streaming],
  );

  if (!content) return null;

  return (
    <div className="markdown-body">
      {chunks.map((chunk, i) => {
        if (chunk.type === 'prose' && chunk.text && !isOrphanFenceChunk(chunk.text)) {
          const displayContent = escapeProse(chunk.text);
          return displayContent ? (
            <ReactMarkdown key={`prose-${i}`} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
              {displayContent}
            </ReactMarkdown>
          ) : null;
        }
        if (chunk.type === 'code' && chunk.text && chunk.text.trim()) {
          if (isProseTextFence(chunk.lang, chunk.text)) {
            return <p key={`code-prose-${i}`} className="my-1.5 leading-relaxed">{chunk.text.trim()}</p>;
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
        isProseTextFence(openCode.lang, openCode.text) && openCode.text.trim() ? (
          <p className="my-1.5 leading-relaxed">{openCode.text.trim()}</p>
        ) : (
          <CodeBlock language={openCode.lang || 'text'} streaming>
            {openCode.text}
          </CodeBlock>
        )
      )}
    </div>
  );
}

const MarkdownRenderer = memo(MarkdownRendererImpl, (prev, next) => (
  prev.content === next.content && prev.streaming === next.streaming
));

export default MarkdownRenderer;
