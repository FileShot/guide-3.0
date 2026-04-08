/**
 * MermaidBlock — Renders mermaid diagram code into an SVG.
 * Used by MarkdownRenderer when a code block has language "mermaid".
 */
import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    darkMode: true,
    primaryColor: '#3b82f6',
    primaryTextColor: '#e4e4e7',
    primaryBorderColor: '#4b5563',
    lineColor: '#6b7280',
    secondaryColor: '#1e293b',
    tertiaryColor: '#1e293b',
  },
});

let mermaidIdCounter = 0;

export default function MermaidBlock({ children }) {
  const containerRef = useRef(null);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(null);
  const code = typeof children === 'string' ? children : String(children).trim();

  useEffect(() => {
    if (!code) return;
    const id = `mermaid-${++mermaidIdCounter}`;
    mermaid.render(id, code)
      .then(({ svg: rendered }) => {
        setSvg(rendered);
        setError(null);
      })
      .catch((err) => {
        setError(err.message || 'Failed to render diagram');
        setSvg('');
      });
  }, [code]);

  if (error) {
    return (
      <div className="my-2 p-3 rounded-md border border-vsc-error/40 bg-vsc-error/5 text-vsc-sm text-vsc-error">
        <p className="font-medium mb-1">Mermaid Error</p>
        <pre className="text-[11px] whitespace-pre-wrap">{error}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-2 p-4 rounded-md bg-vsc-sidebar border border-vsc-panel-border/40 text-vsc-text-dim text-vsc-sm">
        Rendering diagram...
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-2 p-4 rounded-md bg-vsc-sidebar border border-vsc-panel-border/40 overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
