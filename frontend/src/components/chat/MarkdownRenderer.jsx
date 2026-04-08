/**
 * MarkdownRenderer — ReactMarkdown wrapper with syntax highlighting and custom components.
 * Uses rehype-highlight for code, remark-gfm for tables/strikethrough.
 * Code blocks render via CodeBlock component with copy/apply toolbar.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import CodeBlock from './CodeBlock';
import MermaidBlock from './MermaidBlock';
import 'katex/dist/katex.min.css';

// R43-Fix-A: Sanitize children at the HAST→React boundary.
// rehype-highlight/rehype-katex can occasionally produce HAST nodes that
// hast-util-to-jsx-runtime fails to convert to valid React elements,
// especially during rapid streaming updates. These arrive as plain JS objects
// ({type:'text', value:'...'} or {type:'element', ...}). React 19 throws
// Error #185 when a plain object is rendered as a child.
function sanitizeChildren(children) {
  if (children == null || typeof children === 'string' || typeof children === 'number' || typeof children === 'boolean') {
    return children;
  }
  // Valid React element — has $$typeof
  if (children != null && typeof children === 'object' && children.$$typeof) {
    return children;
  }
  if (Array.isArray(children)) {
    return children.map(sanitizeChildren);
  }
  // Plain object — likely unconverted HAST node. Extract text value if available.
  if (typeof children === 'object') {
    if (children.value != null) return String(children.value);
    if (children.children) return sanitizeChildren(children.children);
    return String(children);
  }
  return children;
}

// Custom components for ReactMarkdown
const markdownComponents = {
  // Code blocks — delegate to CodeBlock for block code, inline stays styled
  pre({ children }) {
    return <>{children}</>;
  },

  code({ node, className, children, ...props }) {
    const isInline = !className && !node?.position?.start?.line;
    // Check if parent is a <pre> (block code) vs inline
    // rehype-highlight adds className like "language-javascript hljs"
    const hasLanguageClass = /language-/.test(className || '');

    // R43-Fix-A: Sanitize children before passing to React DOM
    const safeChildren = sanitizeChildren(children);

    if (hasLanguageClass || (node?.tagName === 'code' && node?.properties?.className)) {
      // Block code — render in CodeBlock (or MermaidBlock for mermaid)
      // Extract language, filtering out 'hljs' which rehype-highlight adds as a utility class
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

    // Inline code
    return (
      <code className="bg-vsc-input px-1.5 py-0.5 rounded text-vsc-sm text-vsc-text-bright" {...props}>
        {safeChildren}
      </code>
    );
  },

  // Tables — theme-aware
  table({ children }) {
    return (
      <div className="overflow-x-auto my-2 rounded-md border border-vsc-panel-border/40">
        <table className="w-full border-collapse text-vsc-sm">
          {children}
        </table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="bg-vsc-sidebar">{children}</thead>;
  },
  th({ children }) {
    return (
      <th className="px-3 py-1.5 text-left font-semibold text-vsc-text-bright border-b border-vsc-panel-border/40">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="px-3 py-1.5 border-b border-vsc-panel-border/20 text-vsc-text">
        {children}
      </td>
    );
  },

  // Blockquotes
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-vsc-accent pl-3 ml-0 my-2 text-vsc-text-dim italic">
        {children}
      </blockquote>
    );
  },

  // Horizontal rules
  hr() {
    return <hr className="border-vsc-panel-border/40 my-4" />;
  },

  // Links
  a({ href, children }) {
    return (
      <a
        href={href}
        className="text-vsc-accent hover:text-vsc-accent-hover hover:underline"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },

  // Images
  img({ src, alt }) {
    return (
      <img
        src={src}
        alt={alt || ''}
        className="max-w-full rounded-md border border-vsc-panel-border/40 my-2"
        loading="lazy"
      />
    );
  },

  // Paragraphs
  p({ children }) {
    return <p className="my-1.5 leading-relaxed">{children}</p>;
  },

  // Lists
  ul({ children }) {
    return <ul className="list-disc ml-5 my-1.5 space-y-0.5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="list-decimal ml-5 my-1.5 space-y-0.5">{children}</ol>;
  },

  // Headings
  h1({ children }) {
    return <h1 className="text-vsc-xl font-semibold mt-3 mb-1 text-vsc-text-bright">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="text-vsc-lg font-semibold mt-3 mb-1 text-vsc-text-bright">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="text-vsc-base font-semibold mt-2 mb-1 text-vsc-text-bright">{children}</h3>;
  },
};

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
  rehypeKatex,
];

export default function MarkdownRenderer({ content, streaming }) {
  if (!content) return null;

  // R48-Layer3: Auto-close unclosed code fences for ALL content, not just streaming.
  // When the model stops mid-fence (timeout, context shift, or preserved by D5-Rewrite),
  // the finalized message can have unclosed fences. Without auto-closing, ReactMarkdown
  // renders the code block as raw text. This applies the same fence-tracking logic
  // regardless of streaming state, ensuring the display never breaks from incomplete markdown.
  let displayContent = content;
  {
    const lines = content.split('\n');
    let openFenceLen = 0; // length of the opening fence backticks (0 = not inside a fence)
    // R51-Fix: Escape HTML entities outside code fences. When the model outputs HTML
    // tags (like <div>, <script>, <head>) in its prose text, ReactMarkdown strips them
    // silently — the tags vanish and their text children appear as a jumbled mess of
    // "naked code." By escaping < and > to &lt; &gt; outside of fences, the HTML appears
    // as visible code text in the chat instead of being stripped or rendered.
    const escapedLines = [];
    for (const line of lines) {
      const fenceMatch = line.match(/^(`{3,})/);
      if (fenceMatch) {
        const len = fenceMatch[1].length;
        if (openFenceLen === 0) {
          openFenceLen = len; // opening fence
        } else if (len >= openFenceLen) {
          openFenceLen = 0; // closing fence
        }
        // else: inner backticks with fewer ticks than opener — ignored
        escapedLines.push(line);
      } else if (openFenceLen > 0) {
        // Inside a code fence — leave as-is
        escapedLines.push(line);
      } else {
        // Outside a code fence — escape HTML tags so they render as visible text
        escapedLines.push(line.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      }
    }
    displayContent = escapedLines.join('\n');
    if (openFenceLen > 0) {
      displayContent += '\n' + '`'.repeat(openFenceLen);
    }
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {displayContent}
      </ReactMarkdown>
    </div>
  );
}
