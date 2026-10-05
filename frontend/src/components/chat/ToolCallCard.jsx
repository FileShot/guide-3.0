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
    detail: (p, result) => {
      const items = result?.items || result?.result?.items;
      if (Array.isArray(items) && items.length) {
        const names = items.slice(0, 3).map((item) => item.name || item.path).filter(Boolean);
        return names.length ? `${items.length} — ${names.join(', ')}` : String(items.length);
      }
      return p?.dirPath || p?.path || '.';
    },
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
  browser_navigate: {
    Icon: Globe,
    pending: 'Navigating to',
    done: 'Navigated to',
    detail: (p) => {
      if (!p?.url) return null;
      try { return new URL(p.url).hostname + new URL(p.url).pathname.slice(0, 30); } catch { return p.url.slice(0, 40); }
    },
  },
  browser_snapshot: {
    Icon: Eye,
    pending: 'Capturing snapshot',
    done: 'Snapshot captured',
    detail: () => null,
  },
  browser_click: {
    Icon: Wrench,
    pending: 'Clicking',
    done: 'Clicked',
    detail: (p) => p?.ref ? `ref ${p.ref}` : p?.element || null,
  },
  browser_type: {
    Icon: Wrench,
    pending: 'Typing into',
    done: 'Typed into',
    detail: (p) => {
      const ref = p?.ref ? `ref ${p.ref}` : '';
      const text = p?.text ? ` "${p.text.slice(0, 20)}${p.text.length > 20 ? '…' : ''}"` : '';
      return ref + text || null;
    },
  },
  browser_fill_form: {
    Icon: Wrench,
    pending: 'Filling form',
    done: 'Filled form',
    detail: (p) => Array.isArray(p?.fields) ? `${p.fields.length} fields` : null,
  },
  browser_screenshot: {
    Icon: Eye,
    pending: 'Taking screenshot',
    done: 'Screenshot taken',
    detail: () => null,
  },
  browser_back: {
    Icon: Globe,
    pending: 'Going back',
    done: 'Went back',
    detail: () => null,
  },
  browser_evaluate: {
    Icon: Wrench,
    pending: 'Evaluating JS',
    done: 'Evaluated JS',
    detail: (p) => p?.code ? p.code.slice(0, 40) : null,
  },
  browser_scroll: {
    Icon: Wrench,
    pending: 'Scrolling',
    done: 'Scrolled',
    detail: (p) => p?.direction || null,
  },
  browser_wait: {
    Icon: Wrench,
    pending: 'Waiting',
    done: 'Waited',
    detail: (p) => p?.time ? `${p.time}s` : null,
  },
  ask_question: {
    Icon: Wrench,
    pending: 'Asking question',
    done: 'Question answered',
    detail: (p, r) => {
      const q = p?.question ? `"${p.question.slice(0, 30)}${p.question.length > 30 ? '…' : ''}"` : null;
      const a = typeof r === 'string' ? r : (r?.answer || r?.message || null);
      if (a) return q ? `${q} → ${a}` : a;
      return q;
    },
  },
  save_memory: {
    Icon: Wrench,
    pending: 'Saving memory',
    done: 'Saved memory',
    detail: (p) => p?.key || null,
  },
  get_memory: {
    Icon: Wrench,
    pending: 'Retrieving memory',
    done: 'Retrieved memory',
    detail: (p) => p?.key || null,
  },
  git_status: {
    Icon: Wrench,
    pending: 'Checking git status',
    done: 'Git status checked',
    detail: () => null,
  },
  git_commit: {
    Icon: Wrench,
    pending: 'Committing',
    done: 'Committed',
    detail: (p) => p?.message ? `"${p.message.slice(0, 30)}"` : null,
  },
  grep_search: {
    Icon: Search,
    pending: 'Searching',
    done: 'Searched',
    detail: (p) => p?.pattern ? `"${p.pattern.slice(0, 30)}"` : null,
  },
  replace_in_files: {
    Icon: FilePen,
    pending: 'Replacing in files',
    done: 'Replaced in files',
    detail: (p) => p?.pattern ? `"${p.pattern.slice(0, 25)}"` : null,
  },
  delete_file: {
    Icon: X,
    pending: 'Deleting',
    done: 'Deleted',
    detail: (p) => p?.filePath ? p.filePath.split(/[\\/]/).pop() : null,
  },
  rename_file: {
    Icon: FilePen,
    pending: 'Renaming',
    done: 'Renamed',
    detail: (p) => p?.oldPath ? p.oldPath.split(/[\\/]/).pop() : null,
  },
  install_packages: {
    Icon: Terminal,
    pending: 'Installing packages',
    done: 'Installed packages',
    detail: (p) => p?.packages || p?.command || null,
  },
  get_project_structure: {
    Icon: List,
    pending: 'Getting structure',
    done: 'Got structure',
    detail: () => null,
  },
  get_file_info: {
    Icon: FileText,
    pending: 'Getting file info',
    done: 'Got file info',
    detail: (p) => p?.filePath ? p.filePath.split(/[\\/]/).pop() : null,
  },
  undo_edit: {
    Icon: Wrench,
    pending: 'Undoing edit',
    done: 'Undone edit',
    detail: () => null,
  },
  write_todos: {
    Icon: List,
    pending: 'Writing todos',
    done: 'Wrote todos',
    detail: () => null,
  },
  generate_image: {
    Icon: Wrench,
    pending: 'Generating image',
    done: 'Generated image',
    detail: (p) => p?.prompt ? `"${p.prompt.slice(0, 30)}…"` : null,
  },
};

export default function ToolCallCard({ toolCall, count }) {
  const [expanded, setExpanded] = useState(false);

  const { functionName, params, result, status = 'pending', duration, generatingProgress, commandSlowProgress } = toolCall;
  const cfg = TOOL_MAP[functionName] || null;
  const Icon = cfg ? cfg.Icon : Wrench;
  const isPending = status === 'pending';
  const isGenerating = status === 'generating';
  const isError = status === 'error';

  const verb = cfg ? (isPending || isGenerating ? cfg.pending : cfg.done) : functionName;
  const detail = cfg?.detail ? cfg.detail(params || {}, result) : null;
  const countSuffix = count > 1 ? ` ×${count}` : '';
  const isFileWriteTool = (name) => name === 'write_file' || name === 'append_to_file' || name === 'edit_file';
  const formatGeneratingProgress = () => {
    const elapsedMs = generatingProgress?.elapsedMs ?? 0;
    const sec = Math.floor(elapsedMs / 1000);
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    const timeStr = min > 0 ? `${min}m ${rem}s` : `${sec}s`;
    const held = Math.max(
      generatingProgress?.fenceChars ?? 0,
      generatingProgress?.fileContentChars ?? 0,
      params?.contentChars ?? 0,
    );
    const kb = held > 0 ? Math.max(1, Math.round(held / 1024)) : 0;
    const filePath = generatingProgress?.filePath || params?.filePath || params?.path;
    const fileName = filePath ? filePath.split(/[\\/]/).pop() : null;
    const verb = functionName === 'append_to_file' ? 'Appending' : functionName === 'edit_file' ? 'Editing' : 'Writing';
    if (isFileWriteTool(functionName) && fileName && kb > 0) {
      return `${verb} ${fileName}… (${kb}KB generated, ${timeStr})`;
    }
    if (kb > 0) return `Generating ${functionName}… (${timeStr}, ${kb}KB held)`;
    return `Generating ${functionName}… (${timeStr})`;
  };
  const formatSlowCommand = () => {
    const elapsedMs = commandSlowProgress?.elapsedMs ?? 0;
    const sec = Math.floor(elapsedMs / 1000);
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    const timeStr = min > 0 ? `${min}m ${rem}s` : `${sec}s`;
    return `Command still running… (${timeStr})`;
  };
  const earlyWriteLabel = () => {
    const filePath = generatingProgress?.filePath || params?.filePath || params?.path;
    const fileName = filePath ? filePath.split(/[\\/]/).pop() : null;
    const held = Math.max(
      generatingProgress?.fenceChars ?? 0,
      generatingProgress?.fileContentChars ?? 0,
      params?.contentChars ?? 0,
    );
    const kb = held > 0 ? Math.max(1, Math.round(held / 1024)) : 0;
    if (isFileWriteTool(functionName) && fileName) {
      const verb = functionName === 'append_to_file' ? 'Appending' : functionName === 'edit_file' ? 'Editing' : 'Writing';
      return kb > 0 ? `${verb} ${fileName}… (${kb}KB)` : `${verb} ${fileName}…`;
    }
    if (kb > 0) return `Generating ${functionName}… (${kb}KB)`;
    return `Generating ${functionName}…`;
  };
  const showLiveMeter = isGenerating && generatingProgress && (
    (generatingProgress.elapsedMs ?? 0) >= 1000
    || (generatingProgress.fenceChars ?? 0) > 0
    || (generatingProgress.fileContentChars ?? 0) > 0
  );
  const errText = (() => {
    if (!isError) return '';
    const raw = result?.error || result?.message || (typeof result === 'string' ? result : '');
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > 72 ? `${s.slice(0, 72)}…` : s;
  })();
  const baseLine = isGenerating
    ? (showLiveMeter ? formatGeneratingProgress() : earlyWriteLabel())
    : (isPending && commandSlowProgress
      ? formatSlowCommand()
      : (detail ? `${verb} • ${detail}${countSuffix}` : `${verb}${countSuffix}`));
  const lineText = errText ? `${baseLine} — ${errText}` : baseLine;

  const hasExpandable = !!(params || (result !== undefined && result !== null));

  return (
    <div className="my-1 rounded-md">
      <button
        className={`flex items-center gap-1.5 w-full px-1.5 py-[3px] text-left rounded transition-colors hover:bg-vsc-list-hover/30 ${isError ? 'text-vsc-error/70' : 'text-vsc-text-dim'}`}
        onClick={() => hasExpandable && setExpanded(!expanded)}
        style={{ cursor: hasExpandable ? 'pointer' : 'default' }}
      >
        <Icon size={11} className="flex-shrink-0 opacity-60" />
        <span className={`text-[11px] truncate leading-tight ${isPending || isGenerating ? 'agent-shimmer' : ''}`}>
          {lineText}
        </span>
        <div className="flex items-center gap-1 ml-auto flex-shrink-0">
          {duration > 0 && !isPending && !isGenerating && (
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
              <div className="text-[10px] text-vsc-text-dim/50 tracking-wider font-medium mb-0.5">Parameters</div>
              <pre className="text-[10px] text-vsc-text-dim/60 overflow-auto max-h-[120px] whitespace-pre-wrap font-vsc-code bg-vsc-sidebar/50 rounded px-1.5 py-1">
                {(() => {
                  const p = typeof params === 'string' ? params : (params || {});
                  const gp = generatingProgress || {};
                  const live = (typeof p === 'object' && p && !Array.isArray(p)) ? { ...p } : {};
                  if (gp.filePath && !live.filePath) live.filePath = gp.filePath;
                  if (gp.fenceChars && !live.bytesHeld) live.bytesHeld = gp.fenceChars;
                  if (gp.fileContentChars && !live.contentChars) live.contentChars = gp.fileContentChars;
                  if (gp.elapsedMs && !live.elapsedMs) live.elapsedMs = gp.elapsedMs;
                  if (isGenerating && live.contentPreview) {
                    const prev = String(live.contentPreview);
                    live.contentPreview = prev.length > 240 ? `${prev.slice(0, 240)}…` : prev;
                  }
                  if (Object.keys(live).length > 0) {
                    return JSON.stringify(live, null, 2);
                  }
                  if (isGenerating) {
                    return JSON.stringify({ status: 'streaming_tool_payload', note: 'Waiting for first closed JSON field from model stream' }, null, 2);
                  }
                  return typeof p === 'string' ? p : JSON.stringify(p, null, 2);
                })()}
              </pre>
            </div>
          )}
          {result !== undefined && result !== null && (
            <div>
              <div className="text-[10px] text-vsc-text-dim/50 tracking-wider font-medium mb-0.5">Result</div>
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

