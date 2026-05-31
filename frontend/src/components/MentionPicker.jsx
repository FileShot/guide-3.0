/**
 * MentionPicker — @ file/folder and @docs autocomplete for chat input.
 */
import { useMemo, useEffect, useState } from 'react';
import { File, Folder, BookOpen } from 'lucide-react';

function flattenTree(items, base = '') {
  const out = [];
  for (const item of items || []) {
    const rel = base ? `${base}/${item.name}` : item.name;
    if (item.type === 'directory') {
      out.push({ path: rel, name: item.name, isDir: true });
      if (item.children) out.push(...flattenTree(item.children, rel));
    } else {
      out.push({ path: rel, name: item.name, isDir: false });
    }
  }
  return out;
}

export default function MentionPicker({ fileTree, query, mentionType = 'file', onSelect, onSelectDoc, onClose }) {
  const [docResults, setDocResults] = useState([]);
  const [docLoading, setDocLoading] = useState(false);

  const fileEntries = useMemo(() => {
    const all = flattenTree(fileTree);
    const q = (query || '').toLowerCase();
    if (!q) return all.slice(0, 12);
    return all.filter(e => e.path.toLowerCase().includes(q)).slice(0, 12);
  }, [fileTree, query]);

  useEffect(() => {
    if (mentionType !== 'docs') {
      setDocResults([]);
      return;
    }
    let cancelled = false;
    setDocLoading(true);
    fetch(`/api/docs/search?q=${encodeURIComponent(query || '')}&limit=12`)
      .then(r => r.json())
      .then(d => {
        if (!cancelled) setDocResults(d.results || []);
      })
      .catch(() => {
        if (!cancelled) setDocResults([]);
      })
      .finally(() => {
        if (!cancelled) setDocLoading(false);
      });
    return () => { cancelled = true; };
  }, [mentionType, query]);

  if (mentionType === 'special') {
    const specials = [
      { id: 'codebase', label: '@codebase', hint: 'Semantic search over project' },
      { id: 'selection', label: '@selection', hint: 'Current editor selection' },
      { id: 'web', label: '@web/', hint: 'Web search context' },
    ].filter(s => !query || s.label.toLowerCase().includes((query || '').toLowerCase()));
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1 max-h-[200px] overflow-y-auto bg-vsc-sidebar border border-vsc-panel-border rounded-lg shadow-xl z-50 py-1">
        {specials.map(s => (
          <button
            key={s.id}
            type="button"
            className="w-full flex flex-col items-start px-3 py-1.5 text-left text-vsc-xs hover:bg-vsc-list-hover text-vsc-text"
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect?.({ path: s.id === 'web' ? '' : s.id, isDir: false, special: s.id });
              onClose?.();
            }}
          >
            <span className="font-medium text-vsc-accent">{s.label}</span>
            <span className="text-vsc-text-dim text-[10px]">{s.hint}</span>
          </button>
        ))}
      </div>
    );
  }

  if (mentionType === 'docs') {
    if (docLoading && !docResults.length) {
      return (
        <div className="absolute bottom-full left-0 right-0 mb-1 bg-vsc-sidebar border border-vsc-panel-border rounded-lg shadow-xl z-50 p-2 text-vsc-xs text-vsc-text-dim">
          Searching docs...
        </div>
      );
    }
    if (!docResults.length) {
      return (
        <div className="absolute bottom-full left-0 right-0 mb-1 bg-vsc-sidebar border border-vsc-panel-border rounded-lg shadow-xl z-50 p-2 text-vsc-xs text-vsc-text-dim">
          No matching docs — index with POST /api/docs/index or open a project with docs/
        </div>
      );
    }
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1 max-h-[200px] overflow-y-auto bg-vsc-sidebar border border-vsc-panel-border rounded-lg shadow-xl z-50 py-1">
        {docResults.map(entry => (
          <button
            key={entry.path}
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-vsc-xs hover:bg-vsc-list-hover text-vsc-text"
            onMouseDown={(e) => {
              e.preventDefault();
              onSelectDoc?.(entry);
              onClose?.();
            }}
          >
            <BookOpen size={12} className="text-vsc-accent shrink-0" />
            <span className="truncate font-medium">{entry.title || entry.path}</span>
            <span className="text-vsc-text-dim truncate ml-auto">{entry.path}</span>
          </button>
        ))}
      </div>
    );
  }

  if (!fileEntries.length) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1 bg-vsc-sidebar border border-vsc-panel-border rounded-lg shadow-xl z-50 p-2 text-vsc-xs text-vsc-text-dim">
        No matching files
      </div>
    );
  }

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 max-h-[200px] overflow-y-auto bg-vsc-sidebar border border-vsc-panel-border rounded-lg shadow-xl z-50 py-1">
      {fileEntries.map(entry => (
        <button
          key={entry.path}
          type="button"
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-vsc-xs hover:bg-vsc-list-hover text-vsc-text"
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(entry);
            onClose?.();
          }}
        >
          {entry.isDir ? <Folder size={12} className="text-vsc-accent shrink-0" /> : <File size={12} className="text-vsc-text-dim shrink-0" />}
          <span className="truncate">{entry.path}</span>
        </button>
      ))}
    </div>
  );
}
