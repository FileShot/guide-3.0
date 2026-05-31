/**
 * MarkdownRenderer — ReactMarkdown wrapper with syntax highlighting and custom components.
 * Streaming fast path: open code fences render as plain CodeBlock without full re-highlight.
 */
import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import CodeBlock from './CodeBlock';
import MermaidBlock from './MermaidBlock';
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

/** Split streaming markdown into stable prose + live code tail when fence is open. */
function splitStreamingMarkdown(content, streaming) {
  if (!content) return { stable: '', openCode: null };
  const lines = content.split('\n');
  let openFenceLen = 0;
  let openLang = '';
  let openFenceLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = lines[i].match(/^(`{3,})(\w*)/);
    if (fenceMatch) {
      const len = fenceMatch[1].length;
      if (openFenceLen === 0) {
        openFenceLen = len;
        openLang = fenceMatch[2] || '';
        openFenceLine = i;
      } else if (len >= openFenceLen) {
        openFenceLen = 0;
        openLang = '';
        openFenceLine = -1;
      }
    }
  }

  if (streaming && openFenceLen > 0 && openFenceLine >= 0) {
    const stableLines = lines.slice(0, openFenceLine + 1);
    const tailLines = lines.slice(openFenceLine + 1);
    return {
      stable: stableLines.join('\n'),
      openCode: { lang: openLang, text: tailLines.join('\n') },
    };
  }

  return { stable: content, openCode: null };
}

function escapeProse(content) {
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

function MarkdownRendererImpl({ content, streaming }) {
  const { stable, openCode } = useMemo(
    () => splitStreamingMarkdown(content, streaming),
    [content, streaming],
  );

  const displayContent = useMemo(() => escapeProse(stable), [stable]);

  if (!content) return null;

  return (
    <div className="markdown-body">
      {displayContent ? (
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
          {displayContent}
        </ReactMarkdown>
      ) : null}
      {openCode && (
        <CodeBlock language={openCode.lang || 'text'} streaming>
          {openCode.text}
        </CodeBlock>
      )}
    </div>
  );
}

const MarkdownRenderer = memo(MarkdownRendererImpl, (prev, next) => (
  prev.content === next.content && prev.streaming === next.streaming
));

export default MarkdownRenderer;
