/**
 * ToolCallCard — VS Code Copilot-style compact tool activity line.
 * Shows "[icon] Action • detail" on a single compact line.
 * Click to expand parameters/result. Does NOT affect FileContentBlock (code blocks).
 */
import { useState } from 'react';
import {
  ChevronRight, ChevronDown,
  Eye, FilePen, FilePlus, FolderPlus, Terminal, Globe, Search, List,
  FileSearch, Wrench, Pencil, FileText, X, FolderOpen,
} from 'lucide-react';

// Map functionName → { Icon, pending verb, done verb, detail fn }
const TOOL_MAP = {
  read_file: {
    Icon: Eye,
    pending: 'Reading',
    done: 'Read',
    detail: (p) => {
      const name = p?.filePath ? p.filePath.split(/[\\/]/).pop() : '';
      const range = (p?.startLine && p?.endLine)
        ? `, lines ${p.startLine} to ${p.endLine}`
        : p?.startLine ? `, from line ${p.startLine}` : '';
      return name ? `${name}${range}` : null;
    },
  },
  write_file: {
    Icon: FilePen,
    pending: 'Writing',
    done: 'Wrote',
    detail: (p) => p?.filePath ? p.filePath.split(/[\\/]/).pop() : null,
  },
  edit_file: {
    Icon: Pencil,
    pending: 'Editing',
    done: 'Edited',
    detail: (p) => p?.filePath ? p.filePath.split(/[\\/]/).pop() : null,
  },
  append_to_file: {
    Icon: FilePlus,
    pending: 'Appending to',
    done: 'Appended to',
    detail: (p) => p?.filePath ? p.filePath.split(/[\\/]/).pop() : null,
  },
  run_command: {
    Icon: Terminal,
    pending: 'Running',
    done: 'Ran',
    detail: (p) => {
      if (!p?.command) return null;
      const cmd = p.command.slice(0, 55);
      return p.command.length > 55 ? `${cmd}…` : cmd;
    },
  },
  create_directory: {
    Icon: FolderPlus,
    pending: 'Creating',
    done: 'Created',
    detail: (p) => p?.dirPath || p?.path || null,
  },
  list_directory: {
    Icon: List,
    pending: 'Listing',
    done: 'Listed',
    detail: (p) => p?.dirPath || p?.path || '.',
  },
  find_files: {
    Icon: FileSearch,
    pending: 'Finding',
    done: 'Found',
    detail: (p) => p?.pattern || null,
  },
  fetch_webpage: {
    Icon: Globe,
    pending: 'Fetching',
    done: 'Fetched',
    detail: (p) => {
      if (!p?.url) return null;
      try { return new URL(p.url).hostname; } catch { return p.url.slice(0, 40); }
    },
  },
  web_search: {
    Icon: Search,
    pending: 'Searching',
    done: 'Searched',
    detail: (p) => p?.query ? `"${p.query.slice(0, 30)}${p.query.length > 30 ? '…' : ''}"` : null,
  },
  search_codebase: {
    Icon: Search,
    pending: 'Searching',
    done: 'Searched',
    detail: (p) => p?.query ? `"${p.query.slice(0, 30)}${p.query.length > 30 ? '…' : ''}"` : null,
  },
  analyze_error: {
    Icon: FileText,
    pending: 'Analyzing',
    done: 'Analyzed',
    detail: (p) => p?.errorMessage ? p.errorMessage.slice(0, 40) : null,
  },
  open_folder: {
    Icon: FolderOpen,
    pending: 'Opening',
    done: 'Opened',
    detail: (p) => p?.dirPath || p?.path || null,
  },
};

export default function ToolCallCard({ toolCall, count }) {
  const [expanded, setExpanded] = useState(false);

  const { functionName, params, result, status = 'pending', duration } = toolCall;
  const cfg = TOOL_MAP[functionName] || null;
  const Icon = cfg ? cfg.Icon : Wrench;
  const isPending = status === 'pending';
  const isError = status === 'error';

  const verb = cfg ? (isPending ? cfg.pending : cfg.done) : functionName;
  const detail = cfg?.detail ? cfg.detail(params || {}) : null;
  const countSuffix = count > 1 ? ` ×${count}` : '';
  const lineText = detail ? `${verb} • ${detail}${countSuffix}` : `${verb}${countSuffix}`;

  const hasExpandable = !!(params || (result !== undefined && result !== null));

  return (
    <div className="my-px">
      <button
        className={`flex items-center gap-1.5 w-full px-1.5 py-[3px] text-left rounded transition-colors hover:bg-vsc-list-hover/30 ${isError ? 'text-vsc-error/70' : 'text-vsc-text-dim'}`}
        onClick={() => hasExpandable && setExpanded(!expanded)}
        style={{ cursor: hasExpandable ? 'pointer' : 'default' }}
      >
        <Icon size={11} className="flex-shrink-0 opacity-60" />
        <span className={`text-[11px] truncate leading-tight ${isPending ? 'agent-shimmer' : ''}`}>
          {lineText}
        </span>
        <div className="flex items-center gap-1 ml-auto flex-shrink-0">
          {duration > 0 && !isPending && (
            <span className="text-[10px] opacity-40">
              {duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`}
            </span>
          )}
          {isError && <X size={10} className="text-vsc-error/70 flex-shrink-0" />}
          {hasExpandable && (
            expanded
              ? <ChevronDown size={10} className="opacity-30 flex-shrink-0" />
              : <ChevronRight size={10} className="opacity-30 flex-shrink-0" />
          )}
        </div>
      </button>

      {expanded && hasExpandable && (
        <div className="ml-5 pl-2 border-l border-vsc-panel-border/20 mt-0.5 mb-1">
          {params && (
            <div className="mb-1">
              <div className="text-[10px] text-vsc-text-dim/50 uppercase tracking-wider font-medium mb-0.5">Parameters</div>
              <pre className="text-[10px] text-vsc-text-dim/60 overflow-auto max-h-[120px] whitespace-pre-wrap font-vsc-code bg-vsc-sidebar/50 rounded px-1.5 py-1">
                {typeof params === 'string' ? params : JSON.stringify(params, null, 2)}
              </pre>
            </div>
          )}
          {result !== undefined && result !== null && (
            <div>
              <div className="text-[10px] text-vsc-text-dim/50 uppercase tracking-wider font-medium mb-0.5">Result</div>
              <pre className={`text-[10px] overflow-auto max-h-[120px] whitespace-pre-wrap font-vsc-code bg-vsc-sidebar/50 rounded px-1.5 py-1 ${isError ? 'text-vsc-error/70' : 'text-vsc-text-dim/60'}`}>
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

