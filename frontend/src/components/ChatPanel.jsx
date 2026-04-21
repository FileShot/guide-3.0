/**
 * ChatPanel — AI chat interface with streaming markdown rendering.
 * Features a cohesive unified input container with toolbar.
 */
import { useState, useRef, useEffect, useCallback, useMemo, Component } from 'react';
import useAppStore from '../stores/appStore';
import MarkdownRenderer from './chat/MarkdownRenderer';
import ToolCallCard from './chat/ToolCallCard';
import FileContentBlock from './chat/FileContentBlock';
import { Virtuoso } from 'react-virtuoso';
import {
  Send, Square, Trash2, Cpu, Loader, ChevronDown, ChevronRight, Brain,
  Paperclip, Mic, Zap, FileCode, ArrowUp, ChevronUp, Plus, Minus,
  Check, Undo2, X, Star, GripVertical, RotateCcw, Clock, Settings,
  Cloud, Key, FolderPlus, Sparkles, Eye, ImageIcon,
  CheckCircle2, Circle, Loader2, ListTodo, Bot, MessageSquare
} from 'lucide-react';

// guIDE Cloud AI — bundled providers with pre-seeded keys, rotated for rate-limit avoidance
const GUIDE_CLOUD_PROVIDERS = new Set(['cerebras', 'groq', 'sambanova', 'google', 'openrouter']);

// R43-Fix-B: Streaming-scoped error boundary.
// Catches React render errors in MarkdownRenderer during streaming and shows
// the raw text as fallback instead of crashing the entire app.
// Auto-recovers on next content update since props change triggers re-render.
class StreamingErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error) {
    console.warn('[StreamingErrorBoundary] MarkdownRenderer error caught:', error.message);
  }
  componentDidUpdate(prevProps) {
    // Auto-recover when content changes — the new content might render fine
    if (this.state.hasError && prevProps.fallbackContent !== this.props.fallbackContent) {
      this.setState({ hasError: false });
    }
  }
  render() {
    if (this.state.hasError) {
      // Show raw text as fallback
      return (
        <pre className="whitespace-pre-wrap text-vsc-sm text-vsc-text p-2">
          {this.props.fallbackContent || ''}
        </pre>
      );
    }
    return this.props.children;
  }
}

// Finalized thinking block — shown on already-completed assistant messages.
// Collapsed by default (unlike streaming ThinkingBlock which auto-expands).
function FinalizedThinkingBlock({ text }) {
  const [expanded, setExpanded] = useState(true);
  const lines = text.split('\n').filter(l => l.trim());

  return (
    <div className="mb-1 overflow-hidden">
      <button
        className="w-full flex items-center gap-1 py-0.5 text-[10px] transition-colors leading-tight min-h-0"
        style={{ color: 'var(--vsc-text-dim, #858585)' }}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`text-[8px] transition-transform duration-150 flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}>
          &#9654;
        </span>
        <span className="font-medium whitespace-nowrap flex-shrink-0 text-vsc-text">
          <em>Thought for {lines.length} line{lines.length !== 1 ? 's' : ''}</em>
        </span>
        <Check size={9} className="ml-auto flex-shrink-0" style={{ color: '#4ec9b0' }} />
      </button>
      {expanded && (
        <div
          className="px-2 pb-1.5 text-[10px] whitespace-pre-wrap leading-relaxed max-h-[180px] overflow-y-auto text-vsc-text-dim"
          style={{ borderTop: '1px solid var(--vsc-panel-border, #2d2d2d)' }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

// R44-Fix-2: Stable Header component — defined at module level so Virtuoso
// receives a stable function reference. Reads state from store directly,
// not from ChatPanel closures. Prevents unmount/remount every 80ms render.
function StreamingHeader() {
  const modelLoaded = useAppStore(s => s.modelLoaded);
  const connected = useAppStore(s => s.connected);
  const todos = useAppStore(s => s.todos);

  return (
    <>
      {!modelLoaded && connected && (
        <div className="m-3 p-3 bg-vsc-sidebar rounded-lg border border-vsc-warning/20 text-vsc-sm">
          <div className="text-vsc-warning font-medium mb-1">No model loaded</div>
          <div className="text-vsc-text-dim text-vsc-xs">
            Load a GGUF model from the Settings panel to start chatting.
          </div>
        </div>
      )}
      {!connected && (
        <div className="m-3 p-3 bg-vsc-sidebar rounded-lg border border-vsc-error/20 text-vsc-sm">
          <div className="text-vsc-error font-medium mb-1">Not connected</div>
          <div className="text-vsc-text-dim text-vsc-xs">
            Waiting for backend server connection...
          </div>
        </div>
      )}
    </>
  );
}

// R44-Fix-2: Stable Footer component — defined at module level so Virtuoso
// receives a stable function reference. Reads state from store directly,
// not from ChatPanel closures. thinkingExpanded state lives here now.
// Prevents unmount/remount every 80ms which was causing:
// - code block stuttering (CodeBlock's MutationObserver + setInterval destroyed/recreated)
// - scroll position resetting to top
// - "Show More" click handlers lost
function StreamingFooter() {
  const chatStreaming = useAppStore(s => s.chatStreaming);
  const chatStreamingText = useAppStore(s => s.chatStreamingText);
  const chatThinkingText = useAppStore(s => s.chatThinkingText);
  const chatGeneratingTool = useAppStore(s => s.chatGeneratingTool);
  const chatIteration = useAppStore(s => s.chatIteration);
  const streamingSegments = useAppStore(s => s.streamingSegments);
  const streamingFileBlocks = useAppStore(s => s.streamingFileBlocks);
  const streamingToolCalls = useAppStore(s => s.streamingToolCalls);
  const modelInfo = useAppStore(s => s.modelInfo);

  // Thinking block state — VS Code style with elapsed time tracking
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const thinkStartRef = useRef(null);
  const wasThinkingRef = useRef(false);
  const thinkContentRef = useRef(null);

  // Track thinking start/end and elapsed time
  const isThinking = !!chatThinkingText && chatStreaming;
  useEffect(() => {
    if (isThinking && !wasThinkingRef.current) {
      // Thinking just started
      thinkStartRef.current = Date.now();
      setThinkingExpanded(true);
      wasThinkingRef.current = true;
    }
    if (!isThinking && wasThinkingRef.current) {
      // Thinking just ended
      if (thinkStartRef.current) {
        setElapsedSeconds(Math.round((Date.now() - thinkStartRef.current) / 1000));
      }
      wasThinkingRef.current = false;
    }
  }, [isThinking]);

  // Auto-scroll thinking content during streaming
  useEffect(() => {
    if (isThinking && thinkingExpanded && thinkContentRef.current) {
      thinkContentRef.current.scrollTop = thinkContentRef.current.scrollHeight;
    }
  }, [chatThinkingText, isThinking, thinkingExpanded]);

  if (!chatStreaming) return null;

  // Thinking label: "Reasoning..." while live, "Thought for Xs" after
  const thinkLabel = isThinking
    ? 'Reasoning...'
    : chatThinkingText
      ? `Thought for ${elapsedSeconds < 1 ? '<1' : elapsedSeconds}s`
      : null;

  return (
    <div className="chat-message assistant">
      <div className="text-vsc-xs text-vsc-text-dim mb-1 font-medium uppercase tracking-wider flex items-center gap-2">
        {(() => {
          const cp = useAppStore.getState().cloudProvider;
          if (cp) return GUIDE_CLOUD_PROVIDERS.has(cp) ? 'guIDE Cloud AI' : cp.charAt(0).toUpperCase() + cp.slice(1);
          return (modelInfo?.name || 'guIDE').split('/').pop().split('-Q')[0];
        })()}
        {chatIteration && chatIteration.iteration > 1 && (
          <>
            <span className="text-vsc-text-dim/60 font-normal normal-case tracking-normal">—</span>
            <span className="text-[10px] text-vsc-text-dim font-normal normal-case tracking-normal flex items-center gap-1">
              Starting: Step {chatIteration.iteration}/{chatIteration.maxIterations}
              <span className="inline-flex gap-[2px] ml-0.5">
                {[0, 80, 160].map(d => (
                  <span key={d} className="w-[3px] h-[3px] bg-vsc-text-dim/60 rounded-full animate-bounce inline-block" style={{ animationDelay: `${d}ms` }} />
                ))}
              </span>
            </span>
          </>
        )}
      </div>
      {chatThinkingText && (
        <div className="mb-2 overflow-hidden">
          <button
            className="w-full flex items-center gap-1 py-0.5 text-[10px] transition-colors leading-tight min-h-0"
            style={{ color: 'var(--vsc-text-dim, #858585)' }}
            onClick={() => setThinkingExpanded(!thinkingExpanded)}
          >
            <span className={`text-[8px] transition-transform duration-150 flex-shrink-0 ${thinkingExpanded ? 'rotate-90' : ''}`}>
              &#9654;
            </span>
            <span className="font-medium whitespace-nowrap flex-shrink-0 text-vsc-text">
              <em>{thinkLabel}</em>
            </span>
            {isThinking
              ? <Loader2 size={8} className="animate-spin ml-auto flex-shrink-0 text-vsc-text" />
              : <Check size={9} className="ml-auto flex-shrink-0" style={{ color: '#4ec9b0' }} />
            }
          </button>
          {thinkingExpanded && (
            <div
              ref={thinkContentRef}
              className="px-2 pb-1.5 text-[10px] whitespace-pre-wrap leading-relaxed max-h-[180px] overflow-y-auto text-vsc-text-dim"
              style={{ borderTop: '1px solid var(--vsc-panel-border, #2d2d2d)' }}
            >
              {chatThinkingText}
            </div>
          )}
        </div>
      )}
      {chatGeneratingTool && !chatGeneratingTool.done && (
        <div className="flex items-center gap-2 mb-2 text-vsc-xs text-vsc-accent">
          <Loader size={12} className="animate-spin" />
          <span>Generating: {chatGeneratingTool.functionName}</span>
        </div>
      )}
      {streamingSegments.map((seg, i) => {
        if (seg.type === 'text' && seg.content && seg.content.trim()) {
          const isLastSeg = i === streamingSegments.length - 1;
          return (
            <div key={`seg-text-${i}`}>
              <StreamingErrorBoundary fallbackContent={seg.content}>
                <MarkdownRenderer content={seg.content} streaming />
              </StreamingErrorBoundary>
              {isLastSeg && <span className="streaming-cursor" />}
            </div>
          );
        }
        if (seg.type === 'file') {
          const block = streamingFileBlocks[seg.index];
          if (!block) return null;
          return (
            <FileContentBlock
              key={`seg-file-${seg.index}`}
              filePath={block.filePath}
              language={block.language}
              fileName={block.fileName}
              content={block.content}
              complete={block.complete}
            />
          );
        }
        if (seg.type === 'tool') {
          const tc = streamingToolCalls[seg.toolIndex];
          if (!tc) return null;
          if (i > 0) {
            const prev = streamingSegments[i - 1];
            if (prev.type === 'tool') {
              const prevTc = streamingToolCalls[prev.toolIndex];
              if (prevTc && prevTc.functionName === tc.functionName) return null;
            }
          }
          let count = 1;
          for (let j = i + 1; j < streamingSegments.length; j++) {
            const next = streamingSegments[j];
            if (next.type !== 'tool') break;
            const nextTc = streamingToolCalls[next.toolIndex];
            if (!nextTc || nextTc.functionName !== tc.functionName) break;
            count++;
          }
          return <ToolCallCard key={`seg-tool-${seg.toolIndex}`} toolCall={tc} count={count} />;
        }
        return null;
      })}
      {!chatStreamingText && !chatThinkingText && streamingSegments.length === 0 && (
        <div className="flex items-center gap-1 py-2">
          <div className="w-1.5 h-1.5 bg-vsc-text-dim rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-1.5 h-1.5 bg-vsc-text-dim rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-1.5 h-1.5 bg-vsc-text-dim rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      )}
    </div>
  );
}

export default function ChatPanel() {
  const chatMessages = useAppStore(s => s.chatMessages);
  const chatStreaming = useAppStore(s => s.chatStreaming);
  const chatStreamingText = useAppStore(s => s.chatStreamingText);
  const chatThinkingText = useAppStore(s => s.chatThinkingText);
  const chatGeneratingTool = useAppStore(s => s.chatGeneratingTool);
  const chatContextUsage = useAppStore(s => s.chatContextUsage);
  const chatIteration = useAppStore(s => s.chatIteration);
  const modelInfo = useAppStore(s => s.modelInfo);
  const modelLoaded = useAppStore(s => s.modelLoaded);
  const projectPath = useAppStore(s => s.projectPath);
  const addChatMessage = useAppStore(s => s.addChatMessage);
  const setChatStreaming = useAppStore(s => s.setChatStreaming);
  const clearChat = useAppStore(s => s.clearChat);
  const todos = useAppStore(s => s.todos);
  const connected = useAppStore(s => s.connected);
  const availableModels = useAppStore(s => s.availableModels);
  const activeTabId = useAppStore(s => s.activeTabId);
  const openTabs = useAppStore(s => s.openTabs);
  const editorSelection = useAppStore(s => s.editorSelection);
  const setActiveActivity = useAppStore(s => s.setActiveActivity);

  const chatFilesChanged = useAppStore(s => s.chatFilesChanged);
  const setChatFilesChanged = useAppStore(s => s.setChatFilesChanged);
  const chatAttachments = useAppStore(s => s.chatAttachments);
  const addChatAttachment = useAppStore(s => s.addChatAttachment);
  const removeChatAttachment = useAppStore(s => s.removeChatAttachment);
  const clearChatAttachments = useAppStore(s => s.clearChatAttachments);
  const streamingFileBlocks = useAppStore(s => s.streamingFileBlocks);
  const streamingSegments = useAppStore(s => s.streamingSegments);
  const streamingToolCalls = useAppStore(s => s.streamingToolCalls);
  const messageQueue = useAppStore(s => s.messageQueue);
  const addQueuedMessage = useAppStore(s => s.addQueuedMessage);
  const removeQueuedMessage = useAppStore(s => s.removeQueuedMessage);
  const updateQueuedMessage = useAppStore(s => s.updateQueuedMessage);
  const cloudProvider = useAppStore(s => s.cloudProvider);

  const [input, setInput] = useState('');
  const [chatMode, setChatMode] = useState('agent'); // 'agent' | 'plan' | 'ask'
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modeDropdownRef = useRef(null);
  const inputRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const virtuosoRef = useRef(null);
  const atBottomRef = useRef(true);
  const [filesChangedExpanded, setFilesChangedExpanded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [fileContextDismissed, setFileContextDismissed] = useState(false);
  const [savedSessions, setSavedSessions] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState('current');
  const sessionSaveTimerRef = useRef(null);
  const historyMenuRef = useRef(null);

  // Load saved sessions from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem('guide-chat-sessions');
      if (raw) setSavedSessions(JSON.parse(raw));
    } catch (_) {}
  }, []);

  // Close mode dropdown on click outside
  useEffect(() => {
    if (!modeDropdownOpen) return;
    const handler = (e) => {
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target)) {
        setModeDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modeDropdownOpen]);

  // Auto-save current session to localStorage when messages change
  useEffect(() => {
    if (chatMessages.length < 2) return; // need at least user + assistant
    if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = setTimeout(() => {
      try {
        const userMsg = chatMessages.find(m => m.role === 'user');
        const title = userMsg?.content?.slice(0, 60) || 'Chat session';
        const sessionId = chatMessages[0]?.id || `s-${Date.now()}`;
        const raw = localStorage.getItem('guide-chat-sessions');
        const existing = raw ? JSON.parse(raw) : [];
        // Replace existing session with same first message id, or prepend
        const filtered = existing.filter(s => s.id !== sessionId);
        const updated = [{ id: sessionId, title, messages: chatMessages, timestamp: Date.now(), projectPath: projectPath || null }, ...filtered].slice(0, 10);
        localStorage.setItem('guide-chat-sessions', JSON.stringify(updated));
        setSavedSessions(updated);
      } catch (_) {}
    }, 3000);
    return () => { if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current); };
  }, [chatMessages]);

  // Close history popover when clicking outside
  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (e) => {
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target)) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [historyOpen]);

  const handleFileAttach = useCallback((files) => {
    for (const file of files) {
      const url = URL.createObjectURL(file);
      addChatAttachment({
        name: file.name,
        type: file.type,
        url,
        size: file.size,
      });
    }
  }, [addChatAttachment]);

  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) handleFileAttach([file]);
      }
    }
  }, [handleFileAttach]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) {
      handleFileAttach(Array.from(e.dataTransfer.files));
    }
  }, [handleFileAttach]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = '28px';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }
  }, [input]);

  // Reset file context dismissal when active tab changes
  useEffect(() => { setFileContextDismissed(false); }, [activeTabId]);

  // Track whether the user manually scrolled away during streaming.
  // A wheel-up or pointer-driven scroll sets this flag; reaching the bottom clears it.
  const userScrolledAwayRef = useRef(false);
  useEffect(() => {
    if (!chatStreaming) userScrolledAwayRef.current = false;
  }, [chatStreaming]);
  const handleUserWheel = useCallback((e) => {
    if (!chatStreaming) return;
    if (e.deltaY < 0) {
      userScrolledAwayRef.current = true;
    }
  }, [chatStreaming]);

  // Auto-scroll during streaming.
  // Uses rAF to avoid layout thrashing. Does NOT fire if the user deliberately
  // scrolled up. Clears the flag when the user scrolls back to the bottom.
  useEffect(() => {
    if (!chatStreaming) return;
    if (userScrolledAwayRef.current) return;
    requestAnimationFrame(() => {
      if (virtuosoRef.current && !userScrolledAwayRef.current) {
        virtuosoRef.current.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' });
      }
    });
  }, [chatStreaming, chatStreamingText, streamingSegments, streamingToolCalls]);

  // Scroll to the newly finalized assistant message.
  // When streaming ends, the streaming state is cleared on the same frame that
  // chatMessages grows by one. The streaming-scroll effect above early-returns
  // (chatStreaming is now false), so the new message can land below the fold
  // and the panel appears blank until the user clicks or scrolls. Scrolling
  // when chatMessages.length changes keeps the new message visible.
  useEffect(() => {
    if (userScrolledAwayRef.current) return;
    requestAnimationFrame(() => {
      if (virtuosoRef.current && !userScrolledAwayRef.current) {
        virtuosoRef.current.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' });
      }
    });
  }, [chatMessages.length]);

  // Core send logic — takes explicit text param so queue auto-send can use it
  const doSend = useCallback(async (text) => {
    if (!text || chatStreaming) return;

    const serializeAttachments = async (attachments) => {
      const out = [];
      for (const a of attachments) {
        if (!a || typeof a !== 'object') continue;
        const entry = {
          id: a.id,
          name: a.name,
          type: a.type,
          size: a.size,
          data: null,
        };
        try {
          const resp = await fetch(a.url);
          const blob = await resp.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('Attachment read failed'));
            reader.readAsDataURL(blob);
          });
          if (typeof dataUrl === 'string') {
            const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (m) {
              entry.mimeType = m[1];
              entry.data = m[2];
            } else {
              entry.data = dataUrl;
            }
          }
          out.push(entry);
        } catch (_) {
          out.push(entry);
        }
      }
      return out;
    };

    const attachmentsSnapshot = Array.isArray(chatAttachments) ? [...chatAttachments] : [];
    const serializedAttachments = await serializeAttachments(attachmentsSnapshot);

    setInput('');
    const imageAttachments = attachmentsSnapshot.filter(a => (a.type || '').startsWith('image/'));
    addChatMessage({ role: 'user', content: text, imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined });

    if (attachmentsSnapshot.length > 0) clearChatAttachments();
    const store = useAppStore.getState();
    store.setChatStreaming(true);

    try {
      const activeTab = store.openTabs.find(t => t.id === store.activeTabId);
      const s = store.settings;
      const _chatContext = {
        projectPath: store.projectPath,
        currentFile: (!fileContextDismissed && activeTab) ? { path: activeTab.path, content: activeTab.content } : null,
        selectedCode: null,
        conversationHistory: [],
        attachments: serializedAttachments,
        cloudProvider: store.cloudProvider,
        cloudModel: store.cloudModel,
        params: {
          chatMode,
          planMode: chatMode === 'plan',
          askOnly: chatMode === 'ask',
          temperature: s.temperature,
          maxTokens: s.maxResponseTokens,
          topP: s.topP,
          topK: s.topK,
          repeatPenalty: s.repeatPenalty,
          seed: s.seed,
          thinkingBudget: s.thinkingBudget,
          reasoningEffort: s.reasoningEffort,
          maxIterations: s.maxIterations,
          generationTimeoutSec: s.generationTimeoutSec,
          snapshotMaxChars: s.snapshotMaxChars,
          enableThinkingFilter: s.enableThinkingFilter,
          enableGrammar: s.enableGrammar,
          systemPrompt: s.systemPrompt,
          customInstructions: s.customInstructions,
          gpuPreference: s.gpuPreference,
          gpuLayers: s.gpuLayers,
          contextSize: s.contextSize,
        },
      };
      const attachmentSummary = serializedAttachments.length > 0
        ? `\n\n[Attached context]\n${serializedAttachments.map((a, idx) => `- ${idx + 1}. ${a.name || 'attachment'} (${a.type || 'unknown'}, ${a.size || 0} bytes)`).join('\n')}`
        : '';
      const modelInputText = text + attachmentSummary;
      const result = window.electronAPI?.aiChat
        ? await window.electronAPI.aiChat(modelInputText, _chatContext)
        : await (await import('../api/websocket')).invoke('ai-chat', modelInputText, _chatContext);

      // Quota exceeded — show upgrade prompt instead of empty message
      if (result?.isQuotaError || result?.error === '__QUOTA_EXCEEDED__') {
        // Check if user has an account
        let isAuthenticated = false;
        try {
          const statusRes = await fetch('/api/license/status');
          const status = await statusRes.json();
          isAuthenticated = status?.isAuthenticated || false;
        } catch (_) {}

        if (!isAuthenticated) {
          // No account — prompt to create one first
          useAppStore.getState().addChatMessage({
            role: 'assistant',
            content: '',
            quotaExceeded: true,
            needsAccount: true,
          });
        } else {
          // Has account but free plan — prompt to upgrade
          useAppStore.getState().addChatMessage({
            role: 'assistant',
            content: '',
            quotaExceeded: true,
            needsAccount: false,
          });
        }
        return;
      }

      // Finalization: compose segments chronologically
      // R33-Phase4: Use streamingSegments for correct ordering
      // R27-B: Use fresh getState() — store snapshot from L125 is stale after long await
      // R35-L4: Store segment structure on message for rendering with FileContentBlock
      // R46-G: Flush any pending text token buffer BEFORE reading segments.
      // Without this, last tokens stuck in the 80ms buffer get dropped from the finalized message.
      {
        const preFlush = useAppStore.getState();
        if (preFlush._textTokenTimer) clearTimeout(preFlush._textTokenTimer);
        if (preFlush._textTokenBuffer) {
          const buf = preFlush._textTokenBuffer;
          const newText = preFlush.chatStreamingText + buf;
          const segs = preFlush.streamingSegments;
          let newSegs;
          if (segs.length > 0 && segs[segs.length - 1].type === 'text') {
            newSegs = [...segs];
            newSegs[newSegs.length - 1] = { ...newSegs[newSegs.length - 1], content: newSegs[newSegs.length - 1].content + buf };
          } else {
            newSegs = [...segs, { type: 'text', content: buf }];
          }
          useAppStore.setState({ chatStreamingText: newText, streamingSegments: newSegs, _textTokenBuffer: null, _textTokenTimer: null });
        }
      }
      const state = useAppStore.getState();
      const segments = state.streamingSegments;
      const fileBlocks = state.streamingFileBlocks;
      const finalToolCalls = state.streamingToolCalls;
      const thinkingText = state.chatThinkingText || '';

      // Build text-only content for search/backwards compat
      let messageContent = '';
      // Build structured segment data for rendering with FileContentBlock
      const messageSegments = [];
      const messageFileBlocks = [];

      if (segments.length > 0) {
        for (const seg of segments) {
          if (seg.type === 'text') {
            messageContent += seg.content;
            messageSegments.push({ type: 'text', content: seg.content });
          } else if (seg.type === 'file') {
            const block = fileBlocks[seg.index];
            if (block) {
              // Text fallback: still include as markdown fence for content field
              messageContent += `\n\`\`\`${block.language || 'text'}\n${block.content}\n\`\`\`\n`;
              // Structured data: reference into messageFileBlocks array
              messageSegments.push({ type: 'file', index: messageFileBlocks.length });
              messageFileBlocks.push({
                filePath: block.filePath,
                language: block.language,
                fileName: block.fileName,
                content: block.content,
              });
            }
          } else if (seg.type === 'tool') {
            // R40: Preserve tool segments in finalized message
            messageSegments.push({ type: 'tool', toolIndex: seg.toolIndex });
          }
        }
      } else {
        // Fallback: no segments (shouldn't happen but defensive)
        messageContent = state.chatStreamingText || result?.text || '';
        if (fileBlocks.length > 0) {
          for (const block of fileBlocks) {
            messageContent += `\n\`\`\`${block.language || 'text'}\n${block.content}\n\`\`\`\n`;
            messageSegments.push({ type: 'file', index: messageFileBlocks.length });
            messageFileBlocks.push({
              filePath: block.filePath,
              language: block.language,
              fileName: block.fileName,
              content: block.content,
            });
          }
        }
        if (!messageSegments.length && messageContent) {
          messageSegments.push({ type: 'text', content: messageContent });
        }
      }
      if (fileBlocks.length > 0) {
        useAppStore.getState().clearFileContentBlocks();
      }
      // R40: Create message if there's text content OR tool calls
      const hasContent = messageContent && messageContent.trim();
      const hasToolCalls = finalToolCalls.length > 0;
      const hasThinking = thinkingText && thinkingText.trim();

      // R51-Diag: Log finalization state so we can trace vanishing messages
      console.log('[ChatPanel] Finalization:', {
        segmentsLen: segments.length,
        messageContentLen: messageContent.length,
        hasContent: !!hasContent,
        hasToolCalls,
        hasThinking: !!hasThinking,
        streamingTextLen: state.chatStreamingText?.length || 0,
        resultTextLen: result?.text?.length || 0,
        resultSuccess: result?.success,
      });

      // R51-Fix: Also save messages that have ONLY thinking content (no text/tools).
      // Without this, thinking-only responses vanish on finalization because
      // setChatStreaming(false) clears chatThinkingText.
      // Also: safety net — if content was visible during streaming but finalization
      // would discard it, force-create the message with the streaming text.
      if (hasContent || hasToolCalls || hasThinking) {
        // If only thinking and no content, use result.text or a minimal placeholder
        if (!hasContent && !hasToolCalls && hasThinking) {
          messageContent = result?.text || '*The model reasoned but produced no text output.*';
          if (!messageSegments.length) {
            messageSegments.push({ type: 'text', content: messageContent });
          }
        }
        useAppStore.getState().addChatMessage({
          role: 'assistant',
          content: messageContent || '',
          // R35-L4: Structured data for rendering with FileContentBlock
          segments: messageSegments.length > 0 ? messageSegments : undefined,
          fileBlocks: messageFileBlocks.length > 0 ? messageFileBlocks : undefined,
          toolCalls: hasToolCalls ? finalToolCalls : undefined,
          thinking: thinkingText || undefined,
          // R46-A: Store model name for display on finalized messages
          // R47-A: Use cloud model name when cloud provider is active
          model: store.cloudProvider
            ? (GUIDE_CLOUD_PROVIDERS.has(store.cloudProvider) ? 'guIDE Cloud AI' : store.cloudModel || store.cloudProvider)
            : (useAppStore.getState().modelInfo?.name || undefined),
        });
      } else if (state.chatStreamingText && state.chatStreamingText.trim()) {
        // R51-Safety: Content was visible during streaming but segments/messageContent
        // is empty — something went wrong in segment tracking. Preserve the visible text.
        console.warn('[ChatPanel] R51-Safety: streamingText had content but messageContent was empty — forcing message creation');
        useAppStore.getState().addChatMessage({
          role: 'assistant',
          content: state.chatStreamingText,
          thinking: thinkingText || undefined,
          model: store.cloudProvider
            ? (GUIDE_CLOUD_PROVIDERS.has(store.cloudProvider) ? 'guIDE Cloud AI' : store.cloudModel || store.cloudProvider)
            : (useAppStore.getState().modelInfo?.name || undefined),
        });
      } else if (result && result.success === false && result.error) {
        // v2.2.10: Display backend error messages (e.g. "Provider not configured")
        useAppStore.getState().addChatMessage({
          role: 'assistant',
          content: `Error: ${result.error}`,
        });
      } else if (result?.text && result.text.trim()) {
        // R51-Safety: Backend returned text but nothing made it to streaming state.
        // This can happen if IPC events were lost or arrived after handle reply.
        console.warn('[ChatPanel] R51-Safety: result.text had content but streaming state was empty — forcing message creation');
        useAppStore.getState().addChatMessage({
          role: 'assistant',
          content: result.text,
          thinking: thinkingText || undefined,
          model: store.cloudProvider
            ? (GUIDE_CLOUD_PROVIDERS.has(store.cloudProvider) ? 'guIDE Cloud AI' : store.cloudModel || store.cloudProvider)
            : (useAppStore.getState().modelInfo?.name || undefined),
        });
      }
    } catch (err) {
      useAppStore.getState().addChatMessage({ role: 'assistant', content: `Error: ${err.message}` });
    } finally {
      useAppStore.getState().setChatStreaming(false);
    }
  }, [chatStreaming, addChatMessage, chatMode, chatAttachments, clearChatAttachments, fileContextDismissed]);

  // handleSend: reads from input state
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (text) doSend(text);
  }, [input, doSend]);

  // handleSendQueued: sends explicit text (for queue auto-processing)
  const handleSendQueued = useCallback((text) => {
    if (text) doSend(text);
  }, [doSend]);

  // Auto-process message queue: when streaming ends and queue has items, send next
  const prevStreamingRef = useRef(chatStreaming);
  useEffect(() => {
    if (prevStreamingRef.current && !chatStreaming) {
      const queue = useAppStore.getState().messageQueue;
      if (queue.length > 0) {
        const next = queue[0];
        useAppStore.getState().removeQueuedMessage(next.id);
        // Brief delay so finalization renders before next send
        setTimeout(() => handleSendQueued(next.text), 500);
      }
    }
    prevStreamingRef.current = chatStreaming;
  }, [chatStreaming, handleSendQueued]);

  const [stopPending, setStopPending] = useState(false);

  const handleStop = useCallback(async () => {
    if (stopPending) return;
    setStopPending(true);
    try {
      if (window.electronAPI?.agentPause) {
        await window.electronAPI.agentPause();
      } else {
        await (await import('../api/websocket')).invoke('agent-pause');
      }
    } catch (_) {}
    // Re-enable after a short cooldown so the user can issue a second stop
    // if the first one races with a still-streaming chunk.
    setTimeout(() => setStopPending(false), 1000);
  }, [stopPending]);

  const handleClear = useCallback(async () => {
    clearChat();
    setActiveConversationId('current');
    try {
      await fetch('/api/session/clear', { method: 'POST' });
    } catch (_) {}
  }, [clearChat]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = input.trim();
      if (!text) return;
      if (chatStreaming) {
        // Queue message while AI is streaming
        addQueuedMessage(text);
        setInput('');
      } else {
        handleSend();
      }
    }
  };

  const contextPct = chatContextUsage
    ? Math.round((chatContextUsage.used / chatContextUsage.total) * 100)
    : 0;

  const modelDisplayName = cloudProvider
    ? (GUIDE_CLOUD_PROVIDERS.has(cloudProvider) ? 'guIDE Cloud AI' : cloudProvider.charAt(0).toUpperCase() + cloudProvider.slice(1))
    : modelInfo
      ? (modelInfo.family || modelInfo.name || '').split('/').pop().slice(0, 20)
      : 'No Model';

  const filteredSessions = useMemo(() => (
    projectPath ? savedSessions.filter(s => s.projectPath === projectPath) : savedSessions
  ), [savedSessions, projectPath]);

  const currentTitle = useMemo(() => {
    if (chatMessages.length === 0) return 'Current';
    const firstUser = chatMessages.find(m => m.role === 'user');
    return firstUser?.content?.slice(0, 24) || 'Current';
  }, [chatMessages]);

  const currentSessionId = chatMessages[0]?.id || 'current';
  const conversationTabs = useMemo(() => {
    const tabs = [{ id: 'current', title: currentTitle, isCurrent: true }];
    for (const s of filteredSessions) {
      if (s.id === currentSessionId) continue;
      tabs.push({ id: s.id, title: s.title || 'Chat session', isCurrent: false, session: s });
      if (tabs.length >= 2) break; // current + 1 recent max; rest via ··· history
    }
    return tabs;
  }, [filteredSessions, currentSessionId, currentTitle]);

  const openSavedSession = useCallback((session) => {
    useAppStore.setState({ chatMessages: session.messages || [] });
    setActiveConversationId(session.id);
    setHistoryOpen(false);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-[35px] flex items-center justify-between px-3 border-b border-vsc-panel-border/50 no-select flex-shrink-0 bg-vsc-sidebar/80 backdrop-blur-sm shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]">
        <div className="flex items-center gap-2 text-vsc-sm font-medium text-vsc-text min-w-0">
          <span className="text-vsc-text flex-shrink-0">Chat</span>
          {modelInfo && (
            <span className="text-[10px] text-vsc-text-dim/70 truncate max-w-[140px]" title={modelInfo.name}>
              {(modelInfo.name || '').split('.gguf')[0]}
            </span>
          )}
          {chatStreaming && <Loader size={12} className="animate-spin text-vsc-accent flex-shrink-0" />}
        </div>
        <div className="flex items-center gap-1 relative" ref={historyMenuRef}>
          <button className="p-1 hover:bg-vsc-list-hover rounded" title="New Chat" onClick={handleClear}>
            <Plus size={14} className="text-vsc-text-dim" />
          </button>
          <button className="p-1 hover:bg-vsc-list-hover rounded" title="Conversation History" onClick={() => setHistoryOpen(v => !v)}>
            <Clock size={14} className={`${historyOpen ? 'text-vsc-accent' : 'text-vsc-text-dim'}`} />
          </button>
          <button className="p-1 hover:bg-vsc-list-hover rounded" title="Settings" onClick={() => setActiveActivity('settings')}>
            <Settings size={14} className="text-vsc-text-dim" />
          </button>
          <button className="p-1 hover:bg-vsc-list-hover rounded" title="Clear Chat" onClick={handleClear}>
            <Trash2 size={14} className="text-vsc-text-dim" />
          </button>

          {historyOpen && (
            <div className="absolute right-0 top-[32px] z-20 w-[320px] max-h-[320px] overflow-y-auto rounded-lg border border-vsc-panel-border/70 bg-vsc-sidebar/95 backdrop-blur-md shadow-[0_10px_30px_rgba(0,0,0,0.35)] p-1.5">
              <div className="text-[10px] font-medium text-vsc-text-dim uppercase tracking-wider px-1 py-1">History</div>
              {filteredSessions.length === 0 ? (
                <div className="text-[11px] text-vsc-text-dim px-2 py-2">No saved sessions for this workspace.</div>
              ) : (
                filteredSessions.map((session) => (
                  <button
                    key={session.id}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-vsc-list-hover/60 transition-colors group"
                    onClick={() => openSavedSession(session)}
                  >
                    <Clock size={11} className="text-vsc-text-dim/60 flex-shrink-0" />
                    <span className="text-[11px] text-vsc-text truncate flex-1">{session.title}</span>
                    <span className="text-[9px] text-vsc-text-dim/50 flex-shrink-0">
                      {new Date(session.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Conversation tabs */}
      <div className="flex items-center border-b border-vsc-panel-border/40 bg-vsc-sidebar/55 no-select">
        {conversationTabs.map((tab) => (
          <button
            key={tab.id}
            className={`px-3 h-[30px] text-[11px] truncate max-w-[140px] border-b-2 transition-colors flex-shrink-0 ${
              (tab.id === 'current' ? activeConversationId === 'current' : activeConversationId === tab.id)
                ? 'border-vsc-accent text-vsc-text'
                : 'border-transparent text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover/30'
            }`}
            title={tab.title}
            onClick={() => {
              if (tab.isCurrent) { setActiveConversationId('current'); return; }
              openSavedSession(tab.session);
            }}
          >
            {tab.title}
          </button>
        ))}
        {filteredSessions.length > 1 && (
          <button
            className="px-2 h-[30px] text-[11px] text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover/30 border-b-2 border-transparent flex-shrink-0"
            title="More conversations"
            onClick={() => setHistoryOpen(v => !v)}
          >···</button>
        )}
      </div>

      {/* Messages area (virtualized) */}
      <div className="flex-1 min-h-0 bg-gradient-to-b from-transparent to-vsc-bg/20" onWheel={handleUserWheel}>
        {/* Session history shown when chat is empty — filtered to current project */}
        {chatMessages.length === 0 && savedSessions.length > 0 && (() => {
          const filtered = projectPath
            ? savedSessions.filter(s => s.projectPath === projectPath)
            : savedSessions;
          if (filtered.length === 0) return null;
          return (
          <div className="px-3 py-3">
            <div className="text-[10px] font-medium text-vsc-text-dim uppercase tracking-wider mb-2">Recent Chats</div>
            <div className="flex flex-col gap-0.5">
              {filtered.map(session => (
                <div
                  key={session.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-vsc-list-hover/50 transition-colors group cursor-pointer"
                  onClick={() => useAppStore.setState({ chatMessages: session.messages })}
                >
                  <Clock size={11} className="text-vsc-text-dim/50 flex-shrink-0" />
                  <span className="text-[11px] text-vsc-text truncate flex-1">{session.title}</span>
                  <span className="text-[9px] text-vsc-text-dim/40 flex-shrink-0">
                    {new Date(session.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                  <button
                    className="p-0.5 text-vsc-text-dim/30 hover:text-vsc-error opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Delete session"
                    onClick={(e) => {
                      e.stopPropagation();
                      const updated = savedSessions.filter(s => s.id !== session.id);
                      setSavedSessions(updated);
                      localStorage.setItem('guide-chat-sessions', JSON.stringify(updated));
                    }}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
          );
        })()}
        <Virtuoso
          ref={virtuosoRef}
          data={chatMessages}
          followOutput="auto"
          atBottomStateChange={(atBottom) => {
            atBottomRef.current = atBottom;
            if (atBottom) userScrolledAwayRef.current = false;
          }}
          atBottomThreshold={120}
          initialTopMostItemIndex={chatMessages.length > 0 ? chatMessages.length - 1 : 0}
          className="scrollbar-thin"
          components={{
            Header: StreamingHeader,
            Footer: StreamingFooter,
          }}
          itemContent={(idx, msg) => (
            <>
              {/* Checkpoint divider */}
              {idx > 0 && msg.role === 'user' && chatMessages[idx - 1]?.role === 'assistant' && (
                <div className="flex items-center gap-2 px-4 my-2">
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-vsc-panel-border/40 to-transparent" />
                  <button
                    className="flex items-center gap-1 text-[9px] text-vsc-text-dim/60 hover:text-vsc-text-dim px-1.5 py-0.5 rounded-md border border-vsc-panel-border/40 bg-vsc-bg/30 hover:bg-vsc-list-hover/30 transition-colors shadow-[0_1px_4px_rgba(0,0,0,0.2)]"
                    title="Restore conversation to this point"
                    onClick={() => {
                      // R46-D: Truncate chat to this checkpoint (keep messages up to the assistant reply before this user message)
                      const truncated = chatMessages.slice(0, idx);
                      useAppStore.setState({ chatMessages: truncated });
                      // Clear streaming state in case it's active
                      useAppStore.getState().setChatStreaming(false);
                    }}
                  >
                    <RotateCcw size={8} />
                    <Clock size={8} />
                    <span>
                      {chatMessages[idx - 1]?.timestamp
                        ? new Date(chatMessages[idx - 1].timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        : `Turn ${Math.ceil(idx / 2)}`
                      }
                    </span>
                  </button>
                  <div className="flex-1 h-px bg-gradient-to-r from-transparent via-vsc-panel-border/40 to-transparent" />
                </div>
              )}
              {msg.role === 'system' ? (
                <div className="text-vsc-xs text-vsc-text-dim italic px-2 py-1 border-l-2 border-vsc-panel-border/50">
                  {msg.content}
                </div>
              ) : (
                <div className={`chat-message ${msg.role}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-vsc-xs font-medium uppercase tracking-wider text-vsc-text-dim">
                      {msg.role === 'user' ? 'You' : (msg.model || modelInfo?.name || 'guIDE').split('/').pop().split('-Q')[0]}
                    </span>
                    {msg.timestamp && (
                      <span className="text-[10px] text-vsc-text-dim/50">
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  {msg.role === 'assistant' ? (
                    <>
                      {/* Quota exceeded upgrade prompt */}
                      {msg.quotaExceeded ? (
                        <QuotaExceededPrompt needsAccount={msg.needsAccount} />
                      ) : (
                      <>
                      {/* Persisted thinking block — shown collapsed for finalized messages */}
                      {msg.thinking && <FinalizedThinkingBlock text={msg.thinking} />}
                      {/* R35-L4: Use segments + FileContentBlock for file blocks when available */}
                      {msg.segments && (msg.fileBlocks || msg.toolCalls) ? (
                        msg.segments.map((seg, i) => {
                          if (seg.type === 'text' && seg.content && seg.content.trim()) {
                            return <MarkdownRenderer key={`seg-${i}`} content={seg.content} />;
                          }
                          if (seg.type === 'file') {
                            const block = msg.fileBlocks?.[seg.index];
                            if (!block) return null;
                            return (
                              <FileContentBlock
                                key={`file-${i}`}
                                filePath={block.filePath}
                                language={block.language}
                                fileName={block.fileName}
                                content={block.content}
                                complete={true}
                              />
                            );
                          }
                          if (seg.type === 'tool') {
                            const tc = msg.toolCalls?.[seg.toolIndex];
                            if (!tc) return null;
                            // Duplicate collapse: skip if previous segment is same tool name
                            if (i > 0) {
                              const prev = msg.segments[i - 1];
                              if (prev.type === 'tool') {
                                const prevTc = msg.toolCalls?.[prev.toolIndex];
                                if (prevTc && prevTc.functionName === tc.functionName) return null;
                              }
                            }
                            let count = 1;
                            for (let j = i + 1; j < msg.segments.length; j++) {
                              const next = msg.segments[j];
                              if (next.type !== 'tool') break;
                              const nextTc = msg.toolCalls?.[next.toolIndex];
                              if (!nextTc || nextTc.functionName !== tc.functionName) break;
                              count++;
                            }
                            return <ToolCallCard key={`tool-${i}`} toolCall={tc} count={count} />;
                          }
                          return null;
                        })
                      ) : (
                        <MarkdownRenderer content={msg.content} />
                      )}
                      </>
                      )}
                    </>
                  ) : (
                    <>
                      {Array.isArray(msg.imageAttachments) && msg.imageAttachments.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-2">
                          {msg.imageAttachments.map((img, idx) => (
                            <a
                              key={img.id || `${img.name || 'image'}-${idx}`}
                              href={img.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block"
                              title={img.name || 'Attached image'}
                            >
                              <img
                                src={img.url}
                                alt={img.name || 'Attached image'}
                                className="h-16 w-16 rounded-md border border-vsc-panel-border/60 object-cover"
                              />
                            </a>
                          ))}
                        </div>
                      )}
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        />
      </div>

      {/* ─── Unified Input Container ──────────────────────── */}
      <div className="flex-shrink-0 p-2 relative">
        <div className="rounded-xl border border-vsc-panel-border/60 bg-vsc-sidebar/88 backdrop-blur-sm overflow-visible shadow-[0_8px_30px_rgba(0,0,0,0.28),0_1px_0_rgba(255,255,255,0.03)_inset]">

          {/* Todo list progress (collapsible) */}
          {todos.length > 0 && <TodoDropdown todos={todos} />}

          {/* Context indicator badges */}
          {(() => {
            const activeFile = openTabs.find(t => t.id === activeTabId);
            return ((activeFile && !fileContextDismissed) || editorSelection) ? (
              <div className="flex items-center gap-1.5 px-3 pt-2 pb-0.5">
                {activeFile && !fileContextDismissed && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-vsc-accent/10 text-vsc-accent text-[10px] rounded-md group">
                    <FileCode size={10} />
                    {activeFile.name}
                    <button
                      className="ml-0.5 p-0.5 rounded-full hover:bg-vsc-accent/20 opacity-50 group-hover:opacity-100 transition-opacity"
                      onClick={() => setFileContextDismissed(true)}
                      title="Remove file from context"
                    >
                      <X size={8} />
                    </button>
                  </span>
                )}
                {editorSelection && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-vsc-warning/10 text-vsc-warning text-[10px] rounded-md">
                    {editorSelection.chars} chars ({editorSelection.lines} {editorSelection.lines === 1 ? 'line' : 'lines'}) selected
                  </span>
                )}
              </div>
            ) : null;
          })()}

          {/* Files changed by AI — VS Code-style banner */}
          {chatFilesChanged.length > 0 && (
            <div className="border-b border-vsc-panel-border/30">
              {/* Single-line summary with Keep/Undo text buttons */}
              <div className="flex items-center gap-1.5 px-3 py-1">
                <button
                  className="flex items-center gap-1 text-[11px] text-vsc-text-dim hover:text-vsc-text transition-colors"
                  onClick={() => setFilesChangedExpanded(!filesChangedExpanded)}
                >
                  {filesChangedExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <span className="font-medium">
                    {chatFilesChanged.length} file{chatFilesChanged.length !== 1 ? 's' : ''} changed
                  </span>
                </button>
                {/* Aggregate diff stats */}
                {(() => {
                  const added = chatFilesChanged.reduce((s, f) => s + (f.linesAdded || 0), 0);
                  const removed = chatFilesChanged.reduce((s, f) => s + (f.linesRemoved || 0), 0);
                  return (
                    <>
                      {added > 0 && <span className="text-[11px] text-vsc-success font-medium">+{added}</span>}
                      {removed > 0 && <span className="text-[11px] text-vsc-error font-medium">-{removed}</span>}
                    </>
                  );
                })()}
                <div className="flex-1" />
                <button
                  className="px-2 py-0.5 rounded text-[11px] font-medium text-vsc-success hover:bg-vsc-success/10 transition-colors"
                  title="Keep all changes"
                  onClick={() => setChatFilesChanged([])}
                >
                  Keep
                </button>
                <button
                  className="px-2 py-0.5 rounded text-[11px] font-medium text-vsc-text-dim hover:bg-vsc-list-hover hover:text-vsc-text transition-colors"
                  title="Undo all changes"
                  onClick={() => setChatFilesChanged([])}
                >
                  Undo
                </button>
              </div>
              {/* Expanded file list */}
              {filesChangedExpanded && (
                <div className="px-3 pb-1.5 flex flex-col gap-0.5 max-h-[100px] overflow-y-auto scrollbar-thin">
                  {chatFilesChanged.map(f => (
                    <div key={f.path} className="flex items-center gap-1 text-[11px] rounded px-1 py-0.5 hover:bg-vsc-list-hover/50 group">
                      <span className="text-vsc-text truncate flex-1">{f.name}</span>
                      {(f.linesAdded > 0) && <span className="text-vsc-success">+{f.linesAdded}</span>}
                      {(f.linesRemoved > 0) && <span className="text-vsc-error">-{f.linesRemoved}</span>}
                      <button
                        className="p-0.5 text-vsc-success hover:bg-vsc-success/10 rounded opacity-0 group-hover:opacity-100 text-[10px] font-medium transition-opacity"
                        title="Keep changes"
                        onClick={() => {
                          const tab = useAppStore.getState().openTabs.find(t => t.path === f.path);
                          if (tab) useAppStore.getState().markTabSaved(tab.id);
                          setChatFilesChanged(chatFilesChanged.filter(cf => cf.path !== f.path));
                        }}
                      >
                        Keep
                      </button>
                      <button
                        className="p-0.5 text-vsc-text-dim hover:text-vsc-error rounded opacity-0 group-hover:opacity-100"
                        title="Undo"
                        onClick={() => {
                          const tab = useAppStore.getState().openTabs.find(t => t.path === f.path);
                          if (tab?.originalContent != null) {
                            useAppStore.getState().updateTabContent(tab.id, tab.originalContent);
                            const api = window.electronAPI;
                            if (api?.apiFetch) {
                              api.apiFetch('/api/files/write', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ path: f.path, content: tab.originalContent }),
                              });
                            }
                          }
                          setChatFilesChanged(chatFilesChanged.filter(cf => cf.path !== f.path));
                        }}
                      >
                        <Undo2 size={9} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Attachment previews */}
          {chatAttachments.length > 0 && (
            <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-0.5 overflow-x-auto scrollbar-none">
              {chatAttachments.map(a => (
                <div key={a.id} className="relative group flex-shrink-0">
                  {a.type.startsWith('image/') ? (
                    <img
                      src={a.url}
                      alt={a.name}
                      className="h-12 w-12 object-cover rounded-md border border-vsc-panel-border/40"
                    />
                  ) : (
                    <div className="h-12 px-2 flex items-center gap-1 bg-vsc-panel-border/20 rounded-md border border-vsc-panel-border/40">
                      <FileCode size={12} className="text-vsc-text-dim flex-shrink-0" />
                      <span className="text-[10px] text-vsc-text truncate max-w-[80px]">{a.name}</span>
                    </div>
                  )}
                  <button
                    className="absolute -top-1 -right-1 w-4 h-4 bg-vsc-error rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => removeChatAttachment(a.id)}
                  >
                    <X size={10} className="text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Message queue */}
          {messageQueue.length > 0 && (
            <div className="border-b border-vsc-panel-border/30 px-3 py-1.5">
              <div className="text-[10px] font-medium text-vsc-text-dim mb-1">Queue ({messageQueue.length})</div>
              <div className="flex flex-col gap-1 max-h-[80px] overflow-y-auto scrollbar-thin">
                {messageQueue.map((msg, i) => (
                  <div key={msg.id} className="flex items-center gap-1 group">
                    <span className="text-[9px] text-vsc-text-dim/60 w-3 text-right flex-shrink-0">{i + 1}</span>
                    <input
                      className="flex-1 text-[10px] bg-transparent border-none outline-none text-vsc-text px-1 py-0.5 rounded hover:bg-vsc-list-hover/30 focus:bg-vsc-list-hover/50"
                      value={msg.text}
                      onChange={(e) => updateQueuedMessage(msg.id, e.target.value)}
                    />
                    <button
                      className="p-0.5 text-vsc-text-dim hover:text-vsc-error opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => removeQueuedMessage(msg.id)}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Textarea */}
          <div
            className={`px-3 pt-2 pb-1 ${dragOver ? 'bg-vsc-accent/5 ring-1 ring-vsc-accent/30 ring-inset' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <textarea
              ref={textareaRef}
              className="w-full bg-transparent border-none outline-none text-vsc-base text-vsc-text resize-none placeholder:text-vsc-text-dim"
              placeholder={chatStreaming ? 'Type to queue a message...' : (modelLoaded ? 'Ask anything...' : 'Load a model to start...')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              disabled={!connected}
              rows={1}
              style={{ minHeight: '28px', maxHeight: '200px' }}
            />
          </div>

          {/* Bottom Toolbar */}
          <div className="flex items-center px-2 pb-1.5 pt-0.5 gap-1">
            {/* Attach */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              accept="image/*,.txt,.md,.js,.jsx,.ts,.tsx,.py,.json,.yaml,.yml,.html,.css,.rs,.go,.java"
              onChange={(e) => { handleFileAttach(Array.from(e.target.files)); e.target.value = ''; }}
            />
            <button
              className="p-1.5 hover:bg-vsc-list-hover rounded-md transition-colors text-vsc-text-dim hover:text-vsc-text"
              title="Attach file"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={14} />
            </button>

            {/* Mic */}
            <button
              className="p-1.5 hover:bg-vsc-list-hover rounded-md transition-colors text-vsc-text-dim hover:text-vsc-text"
              title="Voice input"
            >
              <Mic size={14} />
            </button>

            {/* Separator */}
            <div className="w-px h-4 bg-vsc-panel-border/50 mx-0.5" />

            {/* Mode selector — Dropdown */}
            {(() => {
              const modes = [
                { id: 'agent', label: 'Agent', icon: Bot, desc: 'Autonomous with tool calls', color: 'text-vsc-text', bg: 'bg-vsc-list-hover/60' },
                { id: 'plan', label: 'Plan', icon: FileCode, desc: 'Plan before executing', color: 'text-vsc-text', bg: 'bg-vsc-list-hover/60' },
                { id: 'ask', label: 'Ask', icon: MessageSquare, desc: 'Question and answer only', color: 'text-vsc-text', bg: 'bg-vsc-list-hover/60' },
              ];
              const current = modes.find(m => m.id === chatMode) || modes[0];
              return (
                <div className="relative" ref={modeDropdownRef}>
                  <button
                    className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${current.bg} ${current.color} hover:bg-vsc-list-hover`}
                    onClick={() => setModeDropdownOpen(!modeDropdownOpen)}
                  >
                    <current.icon size={11} />
                    <span>{current.label}</span>
                    <ChevronUp size={9} className={`ml-0.5 transition-transform ${modeDropdownOpen ? '' : 'rotate-180'}`} />
                  </button>
                  {modeDropdownOpen && (
                    <div className="absolute bottom-full left-0 mb-1 w-52 bg-vsc-dropdown border border-vsc-panel-border rounded-lg shadow-xl z-50 py-1 overflow-hidden">
                      {modes.map(mode => (
                        <button
                          key={mode.id}
                          className={`w-full flex items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-vsc-list-hover ${
                            chatMode === mode.id ? 'bg-vsc-list-hover/50' : ''
                          }`}
                          onClick={() => { setChatMode(mode.id); setModeDropdownOpen(false); }}
                        >
                          <mode.icon size={14} className={`mt-0.5 flex-shrink-0 ${chatMode === mode.id ? 'text-vsc-accent' : 'text-vsc-text-dim'}`} />
                          <div className="min-w-0">
                            <div className={`text-[11px] font-semibold ${chatMode === mode.id ? 'text-vsc-text' : 'text-vsc-text'}`}>{mode.label}</div>
                            <div className="text-[10px] text-vsc-text-dim leading-tight">{mode.desc}</div>
                          </div>
                          {chatMode === mode.id && <Check size={12} className="ml-auto mt-0.5 flex-shrink-0 text-vsc-accent" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Separator */}
            <div className="w-px h-4 bg-vsc-panel-border/50 mx-0.5" />

            {/* Model picker */}
            <div>
              <button
                className="flex items-center gap-1 px-2 py-1 rounded-md text-vsc-xs text-vsc-text-dim hover:bg-vsc-list-hover hover:text-vsc-text transition-colors"
                onClick={() => setModelPickerOpen(!modelPickerOpen)}
                title="Select model"
              >
                {cloudProvider ? <Cloud size={12} className="text-vsc-accent" /> : <Cpu size={12} />}
                <span className="truncate max-w-[80px]">{modelDisplayName}</span>
                <ChevronUp size={10} className={`transition-transform ${modelPickerOpen ? '' : 'rotate-180'}`} />
              </button>
            </div>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Send / Stop */}
            {chatStreaming ? (
              <button
                className="p-1.5 bg-vsc-error/20 hover:bg-vsc-error/30 text-vsc-error rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={handleStop}
                disabled={stopPending}
                title={stopPending ? 'Stopping…' : 'Stop generation'}
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                className="p-1.5 bg-vsc-accent hover:bg-vsc-accent-hover text-white rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={handleSend}
                disabled={!input.trim() || !connected}
                title="Send message"
              >
                <ArrowUp size={14} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>

        {/* Model picker dropdown — positioned relative to outer container */}
        {modelPickerOpen && (
          <ModelPickerDropdown
            onClose={() => setModelPickerOpen(false)}
            models={availableModels}
            currentModel={modelInfo}
          />
        )}
      </div>
    </div>
  );
}

// ── Quota Exceeded Prompt ──────────────────────────────────────────────────
function QuotaExceededPrompt({ needsAccount }) {
  const setActiveActivity = useAppStore(s => s.setActiveActivity);
  const [upgrading, setUpgrading] = useState(false);

  const handleUpgrade = async () => {
    setUpgrading(true);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'pro' }),
      });
      const data = await res.json();
      if (data?.success && data.url) {
        window.open(data.url, '_blank');
      } else {
        // If checkout fails (e.g. not signed in), go to account panel
        setActiveActivity('account');
      }
    } catch (_) {
      setActiveActivity('account');
    }
    setUpgrading(false);
  };

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Zap size={16} className="text-amber-400" />
        <span className="font-medium text-vsc-text">Daily limit reached</span>
      </div>
      <p className="text-vsc-sm text-vsc-text-dim mb-3">
        You've used all 20 free Cloud AI messages for today.
        {needsAccount
          ? ' Create a free account to continue, or upgrade to Pro for 5,000 messages per day.'
          : ' Upgrade to Pro for 5,000 messages per day, or switch to a local model for unlimited usage.'}
      </p>
      <div className="flex gap-2">
        {needsAccount ? (
          <button
            onClick={() => setActiveActivity('account')}
            className="px-3 py-1.5 bg-vsc-accent text-white text-vsc-xs rounded hover:bg-vsc-accent/80 transition-colors font-medium"
          >
            Create Account
          </button>
        ) : (
          <button
            onClick={handleUpgrade}
            disabled={upgrading}
            className="px-3 py-1.5 bg-vsc-accent text-white text-vsc-xs rounded hover:bg-vsc-accent/80 transition-colors font-medium"
          >
            {upgrading ? 'Opening...' : 'Upgrade to Pro'}
          </button>
        )}
        <button
          onClick={() => setActiveActivity('models')}
          className="px-3 py-1.5 border border-vsc-panel-border text-vsc-text-dim text-vsc-xs rounded hover:bg-vsc-list-hover transition-colors"
        >
          Use Local Model
        </button>
      </div>
    </div>
  );
}

// ── Vision capability lookup ──────────────────────────────────────────────────
const VISION_MODEL_SUBSTRINGS = {
  openai:     ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  anthropic:  ['claude-sonnet-4', 'claude-3-5-sonnet', 'claude-3-haiku'],
  google:     ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-3'],
  xai:        ['grok-3', 'grok-3-mini'],
  openrouter: ['gemini', 'gpt-4o', 'claude-3', 'pixtral', 'llava', 'vision', 'multimodal'],
  mistral:    ['pixtral'],
};

function isVisionModel(provider, modelId) {
  const substrings = VISION_MODEL_SUBSTRINGS[provider];
  if (!substrings) return false;
  const lower = (modelId || '').toLowerCase();
  return substrings.some(s => lower.includes(s.toLowerCase()));
}

// ── Provider metadata for display & signup URLs ──────────────────────────────
const PROVIDER_INFO = {
  groq:       { signupUrl: 'https://console.groq.com/keys', free: true, placeholder: 'gsk_...', note: 'Ultra-fast, 1000 RPM, best free tier' },
  cerebras:   { signupUrl: 'https://cloud.cerebras.ai/', free: true, placeholder: 'csk-...', note: 'Ultra-fast, 7-key rotation built-in' },
  google:     { signupUrl: 'https://aistudio.google.com/apikey', free: true, placeholder: 'AIza...', note: '1M context, 15 RPM' },
  sambanova:  { signupUrl: 'https://cloud.sambanova.ai/apis', free: true, placeholder: 'aaede...', note: 'Free inference (limited daily quota)' },
  openrouter: { signupUrl: 'https://openrouter.ai/keys', free: true, placeholder: 'sk-or-...', note: '100+ free models' },
  apifreellm: { signupUrl: 'https://apifreellm.com', free: true, placeholder: 'apf_...', note: 'Free API access' },
  nvidia:     { signupUrl: 'https://build.nvidia.com/explore', free: true, placeholder: 'nvapi-...', note: 'Free NIM inference' },
  cohere:     { signupUrl: 'https://dashboard.cohere.com/api-keys', free: true, placeholder: 'trial key...', note: '1000 calls/mo, no CC' },
  mistral:    { signupUrl: 'https://console.mistral.ai/api-keys', free: true, placeholder: 'key...', note: 'Free tier, rate limited' },
  huggingface:{ signupUrl: 'https://huggingface.co/settings/tokens', free: true, placeholder: 'hf_...', note: 'Free inference API' },
  cloudflare: { signupUrl: 'https://dash.cloudflare.com/', free: true, placeholder: 'accountId:apiToken', note: '10K neurons/day free' },
  together:   { signupUrl: 'https://api.together.xyz/settings/api-keys', free: false, placeholder: '...' },
  fireworks:  { signupUrl: 'https://fireworks.ai/account/api-keys', free: false, placeholder: '...' },
  openai:     { signupUrl: 'https://platform.openai.com/api-keys', free: false, placeholder: 'sk-...' },
  anthropic:  { signupUrl: 'https://console.anthropic.com/settings/keys', free: false, placeholder: 'sk-ant-...' },
  xai:        { signupUrl: 'https://console.x.ai/', free: false, placeholder: 'xai-...' },
  perplexity: { signupUrl: 'https://www.perplexity.ai/settings/api', free: false, placeholder: 'pplx-...', note: 'Web-search grounded responses' },
  deepseek:   { signupUrl: 'https://platform.deepseek.com/api_keys', free: false, placeholder: 'sk-...', note: 'V3 + R1 reasoning' },
  ai21:       { signupUrl: 'https://studio.ai21.com/account/api-key', free: false, placeholder: 'key...', note: 'Jamba 256K context' },
  deepinfra:  { signupUrl: 'https://deepinfra.com/dash/api_keys', free: false, placeholder: 'key...', note: 'Pay-per-use, cheap inference' },
  hyperbolic: { signupUrl: 'https://app.hyperbolic.xyz/settings', free: false, placeholder: 'key...' },
  novita:     { signupUrl: 'https://novita.ai/settings/key-management', free: false, placeholder: 'key...' },
  moonshot:   { signupUrl: 'https://platform.moonshot.cn/console/api-keys', free: false, placeholder: 'key...', note: 'Kimi K2 agentic model' },
  upstage:    { signupUrl: 'https://console.upstage.ai/api-keys', free: false, placeholder: 'up-...' },
  lepton:     { signupUrl: 'https://dashboard.lepton.ai/', free: false, placeholder: 'key...' },
};

function ModelPickerDropdown({ onClose, models, currentModel }) {
  const addNotification = useAppStore(s => s.addNotification);
  const modelLoading = useAppStore(s => s.modelLoading);
  const modelLoadProgress = useAppStore(s => s.modelLoadProgress);
  const favoriteModels = useAppStore(s => s.favoriteModels);
  const toggleFavoriteModel = useAppStore(s => s.toggleFavoriteModel);
  const cloudProvider = useAppStore(s => s.cloudProvider);
  const cloudModel = useAppStore(s => s.cloudModel);
  const setCloudProvider = useAppStore(s => s.setCloudProvider);
  const setCloudModel = useAppStore(s => s.setCloudModel);

  const [searchFilter, setSearchFilter] = useState('');
  const modelFileInputRef = useRef(null);
  const [expandedProviders, setExpandedProviders] = useState({});
  const [inlineKeyValues, setInlineKeyValues] = useState({});
  const [inlineKeyStatus, setInlineKeyStatus] = useState({}); // 'saved' | 'error'
  const [keyTestBusy, setKeyTestBusy] = useState({});
  const [providerTestStatus, setProviderTestStatus] = useState({}); // 'ok' | 'fail'
  const [openRouterModels, setOpenRouterModels] = useState(null);
  const [openRouterSearch, setOpenRouterSearch] = useState('');
  const [showCloudProviders, setShowCloudProviders] = useState(false);
  const [showFreeProviders, setShowFreeProviders] = useState(true);
  const [showPremiumProviders, setShowPremiumProviders] = useState(false);
  const [showRecommended, setShowRecommended] = useState(false);
  const [showOtherModels, setShowOtherModels] = useState(false);
  const [recommendedModels, setRecommendedModels] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(new Map());
  const [allProviders, setAllProviders] = useState([]);

  // Fetch all provider key status on mount
  useEffect(() => {
    fetch('/api/cloud/providers').then(r => r.json()).then(d => {
      setAllProviders(d.all || []);
    }).catch(() => {});
  }, []);

  // Fetch recommended models when section opened
  useEffect(() => {
    if (showRecommended && !recommendedModels) {
      fetch('/api/models/recommend').then(r => r.json()).then(d => {
        setRecommendedModels(d);
      }).catch(() => {});
    }
  }, [showRecommended, recommendedModels]);

  const toggleProvider = (provider) => {
    setExpandedProviders(prev => ({ ...prev, [provider]: !prev[provider] }));
    // Fetch OpenRouter catalog on first expand
    if (provider === 'openrouter' && !openRouterModels) {
      fetch('/api/cloud/models/openrouter').then(r => r.json()).then(d => {
        setOpenRouterModels(d.models || []);
      }).catch(() => {});
    }
  };

  const saveInlineKey = async (provider) => {
    const key = (inlineKeyValues[provider] || '').trim();
    try {
      await fetch('/api/cloud/apikey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key }),
      });
      setInlineKeyStatus(prev => ({ ...prev, [provider]: key ? 'saved' : 'cleared' }));
      // Refresh provider list
      const r = await fetch('/api/cloud/providers');
      const d = await r.json();
      setAllProviders(d.all || []);
      setTimeout(() => setInlineKeyStatus(prev => ({ ...prev, [provider]: null })), 2000);
    } catch {
      setInlineKeyStatus(prev => ({ ...prev, [provider]: 'error' }));
    }
  };

  const testProviderKey = async (provider) => {
    setKeyTestBusy(prev => ({ ...prev, [provider]: true }));
    try {
      const r = await fetch(`/api/cloud/test/${encodeURIComponent(provider)}`);
      const d = await r.json();
      setProviderTestStatus(prev => ({ ...prev, [provider]: d.success ? 'ok' : 'fail' }));
    } catch {
      setProviderTestStatus(prev => ({ ...prev, [provider]: 'fail' }));
    } finally {
      setKeyTestBusy(prev => ({ ...prev, [provider]: false }));
      setTimeout(() => setProviderTestStatus(prev => ({ ...prev, [provider]: null })), 3000);
    }
  };

  const disconnectProvider = async (provider) => {
    await fetch('/api/cloud/apikey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, key: '' }),
    });
    setInlineKeyValues(prev => ({ ...prev, [provider]: '' }));
    const r = await fetch('/api/cloud/providers');
    const d = await r.json();
    setAllProviders(d.all || []);
    if (cloudProvider === provider) {
      setCloudProvider(null);
      setCloudModel(null);
    }
  };

  const selectCloudModel = (provider, modelId) => {
    setCloudProvider(provider);
    setCloudModel(modelId);
    fetch('/api/cloud/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model: modelId }),
    }).catch(() => {});
    onClose();
  };

  const isUsingCloud = !!cloudProvider;

  // Local models
  const llmModels = (models || []).filter(m => m.modelType === 'llm' || !m.modelType);
  const diffusionModels = (models || []).filter(m => m.modelType === 'diffusion');
  const filtered = searchFilter
    ? llmModels.filter(m =>
        (m.name || '').toLowerCase().includes(searchFilter.toLowerCase()) ||
        (m.family || '').toLowerCase().includes(searchFilter.toLowerCase())
      )
    : llmModels;

  const sorted = [...filtered].sort((a, b) => {
    const aFav = favoriteModels.includes(a.path);
    const bFav = favoriteModels.includes(b.path);
    if (aFav && !bFav) return -1;
    if (!aFav && bFav) return 1;
    return 0;
  });

  const loadModel = (modelPath) => {
    setCloudProvider(null);
    setCloudModel(null);
    fetch('/api/models/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath }),
    }).then(r => r.json()).then(d => {
      if (!d.success) addNotification({ type: 'error', message: d.error });
    }).catch(e => addNotification({ type: 'error', message: e.message }));
    onClose();
  };

  const reloadModel = () => {
    if (!currentModel?.path) return;
    fetch('/api/models/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath: currentModel.path }),
    }).then(r => r.json()).then(d => {
      if (!d.success) addNotification({ type: 'error', message: d.error || 'Failed to reload model' });
      else addNotification({ type: 'info', message: 'Model reloaded' });
    }).catch(e => addNotification({ type: 'error', message: e.message }));
    onClose();
  };

  const unloadModel = () => {
    fetch('/api/models/unload', { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        if (d.success) addNotification({ type: 'info', message: 'Model unloaded' });
      })
      .catch(() => {});
    onClose();
  };

  // Get provider info helper
  const getProviderLabel = (provider) => {
    const labels = {
      graysoft: 'GraySoft Cloud', openai: 'OpenAI', anthropic: 'Anthropic',
      google: 'Google Gemini', xai: 'xAI Grok', openrouter: 'OpenRouter',
      groq: 'Groq', apifreellm: 'APIFreeLLM', cerebras: 'Cerebras',
      sambanova: 'SambaNova', together: 'Together AI', fireworks: 'Fireworks AI',
      nvidia: 'NVIDIA NIM', cohere: 'Cohere', mistral: 'Mistral AI',
      huggingface: 'Hugging Face', cloudflare: 'Cloudflare Workers AI',
      perplexity: 'Perplexity', deepseek: 'DeepSeek', ai21: 'AI21 Labs',
      deepinfra: 'DeepInfra', hyperbolic: 'Hyperbolic', novita: 'Novita AI',
      moonshot: 'Moonshot AI', upstage: 'Upstage', lepton: 'Lepton AI',
    };
    return labels[provider] || provider;
  };

  // Build favorites list (cloud + local)
  const cloudFavorites = favoriteModels
    .filter(f => f.startsWith('cloud:'))
    .map(f => {
      const [, provider, ...rest] = f.split(':');
      return { key: f, provider, modelId: rest.join(':') };
    });
  const localFavorites = sorted.filter(m => favoriteModels.includes(m.path));

  const freeProviders = Object.entries(PROVIDER_INFO).filter(([, v]) => v.free).map(([k]) => k);
  const premiumProviders = Object.entries(PROVIDER_INFO).filter(([, v]) => !v.free).map(([k]) => k);

  // Render a single provider section
  const renderProviderSection = (provider) => {
    const info = PROVIDER_INFO[provider];
    if (!info) return null;
    const provData = allProviders.find(p => p.provider === provider);
    const hasKey = provData?.hasKey || false;
    const isExpanded = expandedProviders[provider];
    const label = getProviderLabel(provider);

    return (
      <div key={provider} className="border-b border-vsc-panel-border/20">
        <button
          className="w-full text-left px-2 py-1.5 text-[11px] hover:bg-vsc-list-hover/50 flex items-center gap-2 transition-colors"
          onClick={() => toggleProvider(provider)}
        >
          {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <Cloud size={11} className={hasKey ? 'text-vsc-success' : 'text-vsc-text-dim'} />
          <span className="flex-1 text-vsc-text">{label}</span>
          {hasKey && <span className="text-[9px] text-vsc-success px-1 py-0.5 bg-vsc-success/10 rounded">Connected</span>}
          {info.free && !hasKey && <span className="text-[9px] text-vsc-accent px-1 py-0.5 bg-vsc-accent/10 rounded">Free</span>}
        </button>

        {isExpanded && (
          <div className="px-2 pb-2 bg-vsc-bg/30">
            {/* Inline API key input */}
            <div className="flex items-center gap-1 mt-1">
              <Key size={10} className="text-vsc-text-dim flex-shrink-0" />
              <input
                type="password"
                className="flex-1 px-1.5 py-1 bg-vsc-input border border-vsc-panel-border/50 rounded text-[11px] text-vsc-text outline-none focus:border-vsc-accent/50"
                placeholder={info.placeholder}
                value={inlineKeyValues[provider] || ''}
                onChange={e => setInlineKeyValues(prev => ({ ...prev, [provider]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') saveInlineKey(provider); }}
              />
              <button
                className="px-1.5 py-1 text-[10px] bg-vsc-accent text-white rounded hover:bg-vsc-accent-hover transition-colors"
                onClick={() => saveInlineKey(provider)}
              >
                Save
              </button>
              {inlineKeyStatus[provider] === 'saved' && <Check size={12} className="text-vsc-success" />}
              {inlineKeyStatus[provider] === 'error' && <X size={12} className="text-vsc-error" />}
            </div>

            {/* Signup link */}
            <a
              href={info.signupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block mt-1 text-[10px] text-vsc-accent hover:underline"
            >
              Get {info.free ? 'free' : ''} API key &rarr;
            </a>

            {info.note && (
              <div className="mt-0.5 text-[10px] text-vsc-text-dim">{info.note}</div>
            )}

            {/* Test key button */}
            {hasKey && (
              <div className="flex items-center gap-2 mt-1.5">
                <button
                  className="px-2 py-0.5 text-[10px] text-vsc-text-dim border border-vsc-panel-border/50 rounded hover:bg-vsc-list-hover transition-colors disabled:opacity-50"
                  onClick={() => testProviderKey(provider)}
                  disabled={keyTestBusy[provider]}
                >
                  {keyTestBusy[provider] ? <Loader size={10} className="animate-spin inline" /> : 'Test key'}
                </button>
                {providerTestStatus[provider] === 'ok' && <span className="text-[10px] text-vsc-success">Key works</span>}
                {providerTestStatus[provider] === 'fail' && <span className="text-[10px] text-vsc-error">Key failed</span>}
              </div>
            )}

            {/* Provider models */}
            {hasKey && provider === 'openrouter' ? (
              // OpenRouter special: live catalog
              <div className="mt-2">
                <input
                  type="text"
                  className="w-full px-1.5 py-1 bg-vsc-input border border-vsc-panel-border/50 rounded text-[10px] text-vsc-text outline-none focus:border-vsc-accent/50 mb-1"
                  placeholder="Search OpenRouter models..."
                  value={openRouterSearch}
                  onChange={e => setOpenRouterSearch(e.target.value)}
                />
                {openRouterModels ? (
                  <div className="max-h-[200px] overflow-y-auto scrollbar-thin">
                    {(() => {
                      const s = openRouterSearch.toLowerCase();
                      const filt = s ? openRouterModels.filter(m => (m.name || m.id || '').toLowerCase().includes(s)) : openRouterModels;
                      const freeModels = filt.filter(m => m.id?.includes(':free'));
                      const paidModels = filt.filter(m => !m.id?.includes(':free'));
                      return (
                        <>
                          {freeModels.length > 0 && (
                            <>
                              <div className="text-[9px] text-vsc-success uppercase tracking-wider px-1 py-0.5 font-medium">Free</div>
                              {freeModels.slice(0, 50).map(m => (
                                <button
                                  key={m.id}
                                  className={`w-full text-left px-1.5 py-1 text-[10px] hover:bg-vsc-list-hover rounded flex items-center gap-1.5 ${
                                    cloudProvider === 'openrouter' && cloudModel === m.id ? 'bg-vsc-list-active' : ''
                                  }`}
                                  onClick={() => selectCloudModel('openrouter', m.id)}
                                >
                                  <span className="truncate flex-1 text-vsc-text">{m.name || m.id}</span>
                                  {isVisionModel('openrouter', m.id) && <Eye size={9} className="text-vsc-accent flex-shrink-0" title="Vision" />}
                                  <button
                                    className="p-0.5 flex-shrink-0"
                                    onClick={e => { e.stopPropagation(); toggleFavoriteModel(`cloud:openrouter:${m.id}`); }}
                                  >
                                    <Star size={9} className={favoriteModels.includes(`cloud:openrouter:${m.id}`) ? 'text-yellow-400 fill-yellow-400' : 'text-vsc-text-dim/30'} />
                                  </button>
                                </button>
                              ))}
                            </>
                          )}
                          {paidModels.length > 0 && (
                            <>
                              <div className="text-[9px] text-vsc-text-dim uppercase tracking-wider px-1 py-0.5 mt-1 font-medium">Paid</div>
                              {paidModels.slice(0, 50).map(m => (
                                <button
                                  key={m.id}
                                  className={`w-full text-left px-1.5 py-1 text-[10px] hover:bg-vsc-list-hover rounded flex items-center gap-1.5 ${
                                    cloudProvider === 'openrouter' && cloudModel === m.id ? 'bg-vsc-list-active' : ''
                                  }`}
                                  onClick={() => selectCloudModel('openrouter', m.id)}
                                >
                                  <span className="truncate flex-1 text-vsc-text">{m.name || m.id}</span>
                                  {isVisionModel('openrouter', m.id) && <Eye size={9} className="text-vsc-accent flex-shrink-0" title="Vision" />}
                                  <button
                                    className="p-0.5 flex-shrink-0"
                                    onClick={e => { e.stopPropagation(); toggleFavoriteModel(`cloud:openrouter:${m.id}`); }}
                                  >
                                    <Star size={9} className={favoriteModels.includes(`cloud:openrouter:${m.id}`) ? 'text-yellow-400 fill-yellow-400' : 'text-vsc-text-dim/30'} />
                                  </button>
                                </button>
                              ))}
                            </>
                          )}
                        </>
                      );
                    })()}
                  </div>
                ) : (
                  <div className="text-[10px] text-vsc-text-dim py-2 flex items-center gap-1"><Loader size={10} className="animate-spin" /> Loading catalog...</div>
                )}
              </div>
            ) : hasKey ? (
              // Regular provider models
              <div className="mt-1.5 max-h-[150px] overflow-y-auto scrollbar-thin">
                {(() => {
                  // Fetch provider models from static data (same as server)
                  const provModels = allProviders.find(p => p.provider === provider);
                  return (
                    <ProviderModelList
                      provider={provider}
                      cloudProvider={cloudProvider}
                      cloudModel={cloudModel}
                      selectCloudModel={selectCloudModel}
                      favoriteModels={favoriteModels}
                      toggleFavoriteModel={toggleFavoriteModel}
                    />
                  );
                })()}
              </div>
            ) : null}

            {/* Disconnect */}
            {hasKey && (
              <button
                className="mt-1.5 text-[10px] text-vsc-error hover:underline"
                onClick={() => disconnectProvider(provider)}
              >
                Disconnect {label}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute bottom-full left-0 right-0 mb-1 max-h-[500px] overflow-hidden z-50 bg-vsc-sidebar border border-vsc-panel-border rounded-lg shadow-xl glass-strong flex flex-col">
        {/* Search */}
        <div className="p-2 border-b border-vsc-panel-border/50">
          <div className="text-vsc-xs font-medium text-vsc-text-dim uppercase tracking-wider px-1 mb-1.5">Models</div>
          <input
            type="text"
            className="w-full px-2 py-1 bg-vsc-input border border-vsc-panel-border/50 rounded text-vsc-xs text-vsc-text outline-none focus:border-vsc-accent/50"
            placeholder="Search models..."
            value={searchFilter}
            onChange={e => setSearchFilter(e.target.value)}
            autoFocus
          />
        </div>

        {/* Loading indicator */}
        {modelLoading && (
          <div className="px-3 py-2 border-b border-vsc-panel-border/30 flex items-center gap-2 text-vsc-xs text-vsc-accent">
            <Loader size={12} className="animate-spin" />
            <span>Loading model... {modelLoadProgress > 0 ? `${modelLoadProgress}%` : ''}</span>
          </div>
        )}

        <div className="overflow-y-auto flex-1 scrollbar-thin">

          {/* ── Favorites ──────────────────────────────────────── */}
          {(cloudFavorites.length > 0 || localFavorites.length > 0) && (
            <div className="border-b border-vsc-panel-border/30">
              <div className="px-2 py-1 text-[10px] text-vsc-text-dim uppercase tracking-wider bg-vsc-sidebar/80 flex items-center gap-1">
                <Star size={10} className="text-yellow-400" /> Favorites
              </div>
              {cloudFavorites.map(({ key, provider, modelId }) => (
                <button
                  key={key}
                  className={`w-full text-left px-2 py-1.5 text-[11px] hover:bg-vsc-list-hover flex items-center gap-2 ${
                    cloudProvider === provider && cloudModel === modelId ? 'bg-vsc-list-active' : ''
                  }`}
                  onClick={() => selectCloudModel(provider, modelId)}
                >
                  <Cloud size={11} className="text-vsc-accent flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-vsc-text">{modelId}</div>
                    <div className="text-[10px] text-vsc-text-dim">{getProviderLabel(provider)}</div>
                  </div>
                  {isVisionModel(provider, modelId) && <Eye size={9} className="text-vsc-accent flex-shrink-0" />}
                  <button
                    className="p-0.5 flex-shrink-0"
                    onClick={e => { e.stopPropagation(); toggleFavoriteModel(key); }}
                  >
                    <Star size={10} className="text-yellow-400 fill-yellow-400" />
                  </button>
                </button>
              ))}
              {localFavorites.map(m => (
                <button
                  key={m.path}
                  className={`w-full text-left px-2 py-1.5 text-[11px] hover:bg-vsc-list-hover flex items-center gap-2 ${
                    !isUsingCloud && currentModel?.path === m.path ? 'bg-vsc-list-active' : ''
                  }`}
                  onClick={() => loadModel(m.path)}
                >
                  <Cpu size={11} className="flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-vsc-text">{m.name}</div>
                    <div className="text-[10px] text-vsc-text-dim">{m.sizeFormatted}</div>
                  </div>
                  <button
                    className="p-0.5 flex-shrink-0"
                    onClick={e => { e.stopPropagation(); toggleFavoriteModel(m.path); }}
                  >
                    <Star size={10} className="text-yellow-400 fill-yellow-400" />
                  </button>
                </button>
              ))}
            </div>
          )}

          {/* ── Current model (unload option) ─────────────────── */}
          {currentModel && !isUsingCloud && (
            <div className="p-1 border-b border-vsc-panel-border/30">
              <div className="px-2 py-1.5 rounded-md bg-vsc-list-active">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-vsc-xs font-medium text-vsc-text-bright truncate">{currentModel.name}</div>
                    <div className="text-[10px] text-vsc-text-dim flex items-center gap-2 mt-0.5">
                      {currentModel.family && <span>{currentModel.family}</span>}
                      {currentModel.contextSize && <span>{currentModel.contextSize} ctx</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-vsc-success" title="Loaded" />
                    <button
                      className="px-1.5 py-0.5 text-[10px] text-vsc-text-dim hover:text-vsc-accent hover:bg-vsc-accent/10 rounded transition-colors"
                      onClick={reloadModel}
                      disabled={modelLoading}
                    >
                      Reload
                    </button>
                    <button
                      className="px-1.5 py-0.5 text-[10px] text-vsc-text-dim hover:text-vsc-error hover:bg-vsc-error/10 rounded transition-colors"
                      onClick={unloadModel}
                      disabled={modelLoading}
                    >
                      Unload
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Cloud Providers ────────────────────────────────── */}
          <div className="border-b border-vsc-panel-border/30">
            <button
              className="w-full flex items-center gap-2 px-2 py-1.5 text-[10px] text-vsc-text-dim uppercase tracking-wider bg-vsc-sidebar/80 hover:bg-vsc-list-hover/30 transition-colors"
              onClick={() => setShowCloudProviders(!showCloudProviders)}
            >
              {showCloudProviders ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              <Cloud size={10} /> Cloud Providers
              <span className="text-vsc-text-dim/60 ml-auto">{allProviders.filter(p => p.hasKey).length} connected</span>
            </button>

            {showCloudProviders && (
              <div>
                {/* guIDE Cloud AI — bundled entry */}
                <button
                  className={`w-full text-left px-2 py-2 text-[11px] hover:bg-vsc-list-hover flex items-center gap-2 border-b border-vsc-panel-border/20 ${
                    GUIDE_CLOUD_PROVIDERS.has(cloudProvider) ? 'bg-vsc-list-active' : ''
                  }`}
                  onClick={() => selectCloudModel('cerebras', 'gpt-oss-120b')}
                >
                  <Sparkles size={12} className="text-vsc-accent flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-vsc-text font-medium">guIDE Cloud AI</div>
                    <div className="text-[10px] text-vsc-text-dim">Auto-routes to fastest free provider</div>
                  </div>
                  {GUIDE_CLOUD_PROVIDERS.has(cloudProvider) && <Check size={12} className="text-vsc-accent flex-shrink-0" />}
                </button>

                {/* Add Your Own Key — Free */}
                <div>
                  <button
                    className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] text-vsc-success hover:bg-vsc-list-hover/30 transition-colors"
                    onClick={() => setShowFreeProviders(!showFreeProviders)}
                  >
                    {showFreeProviders ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                    <Key size={9} />
                    <span className="font-medium">Add Your Own Key</span>
                    <span className="text-vsc-success/60">&mdash; Free</span>
                  </button>
                  {showFreeProviders && freeProviders.map(p => renderProviderSection(p))}
                </div>

                {/* Premium Providers */}
                <div>
                  <button
                    className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] text-vsc-text-dim hover:bg-vsc-list-hover/30 transition-colors"
                    onClick={() => setShowPremiumProviders(!showPremiumProviders)}
                  >
                    {showPremiumProviders ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                    <Key size={9} />
                    <span className="font-medium">Premium Providers</span>
                  </button>
                  {showPremiumProviders && premiumProviders.map(p => renderProviderSection(p))}
                </div>
              </div>
            )}
          </div>

          {/* ── Quick Add — Recommended Models ────────────────── */}
          <div className="border-b border-vsc-panel-border/30">
            <button
              className="w-full flex items-center gap-2 px-2 py-1.5 text-[10px] text-vsc-text-dim uppercase tracking-wider bg-vsc-sidebar/80 hover:bg-vsc-list-hover/30 transition-colors"
              onClick={() => setShowRecommended(!showRecommended)}
            >
              {showRecommended ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              <FolderPlus size={10} /> Quick Add — Download Models
            </button>

            {showRecommended && (
              <div className="max-h-[300px] overflow-y-auto">
                {!recommendedModels ? (
                  <div className="px-3 py-2 text-[10px] text-vsc-text-dim flex items-center gap-1">
                    <Loader size={10} className="animate-spin" /> Detecting hardware...
                  </div>
                ) : (
                  <>
                    {recommendedModels.vramMB > 0 && (
                      <div className="px-2 py-1 text-[10px] text-vsc-text-dim border-b border-vsc-panel-border/20">
                        GPU VRAM: {Math.round(recommendedModels.vramMB / 1024 * 10) / 10}GB &mdash; models up to {recommendedModels.maxModelGB}GB
                      </div>
                    )}
                    {/* Fits in VRAM */}
                    {(recommendedModels.fits || []).map(m => {
                      const isAlreadyDownloaded = llmModels.some(am => am.fileName === m.file || (am.name || '').includes(m.file));
                      const dlProgress = downloadProgress.get(m.file);
                      return (
                        <div key={m.file} className="px-2 py-1.5 text-[11px] flex items-center gap-2 border-b border-vsc-panel-border/20 hover:bg-vsc-list-hover/30 transition-colors">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-vsc-text font-medium truncate">{m.name}</span>
                              <span className="text-[9px] text-vsc-text-dim">{m.size}GB</span>
                              {m.tags?.map(t => (
                                <span key={t} className={`text-[8px] px-1 py-0.5 rounded ${
                                  t === 'coding' ? 'bg-vsc-accent/15 text-vsc-accent' :
                                  t === 'reasoning' ? 'bg-purple-500/15 text-purple-400' :
                                  'bg-vsc-panel-border/30 text-vsc-text-dim'
                                }`}>{t}</span>
                              ))}
                            </div>
                            <div className="text-[10px] text-vsc-text-dim">{m.desc}</div>
                            {dlProgress && (
                              <div className="mt-1 flex items-center gap-1.5">
                                <div className="flex-1 h-1 bg-vsc-panel-border/30 rounded-full overflow-hidden">
                                  <div className="h-full bg-vsc-accent rounded-full transition-all duration-300" style={{ width: `${dlProgress.progress}%` }} />
                                </div>
                                <span className="text-[9px] text-vsc-text-dim whitespace-nowrap">{dlProgress.downloadedMB}/{dlProgress.totalMB}MB</span>
                                <button
                                  className="text-[9px] text-vsc-error hover:text-vsc-error"
                                  onClick={() => {
                                    fetch('/api/models/hf/cancel', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ id: m.file }),
                                    });
                                    setDownloadProgress(prev => { const next = new Map(prev); next.delete(m.file); return next; });
                                  }}
                                  title="Cancel download"
                                >
                                  <X size={9} />
                                </button>
                              </div>
                            )}
                          </div>
                          {isAlreadyDownloaded ? (
                            <span className="text-[9px] text-vsc-success flex-shrink-0 flex items-center gap-0.5">
                              <Check size={10} /> Installed
                            </span>
                          ) : dlProgress ? (
                            <span className="text-[10px] text-vsc-accent flex-shrink-0">{dlProgress.progress}%</span>
                          ) : (
                            <button
                              className="p-1 bg-vsc-accent text-white rounded hover:bg-vsc-accent-hover flex-shrink-0 transition-colors"
                              onClick={async () => {
                                setDownloadProgress(prev => {
                                  const next = new Map(prev);
                                  next.set(m.file, { progress: 0, downloadedMB: '0', totalMB: String(Math.round(m.size * 1024)) });
                                  return next;
                                });
                                try {
                                  const result = await fetch('/api/models/hf/download', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ url: m.downloadUrl, fileName: m.file }),
                                  }).then(r => r.json());
                                  if (result.alreadyExists) {
                                    setDownloadProgress(prev => { const next = new Map(prev); next.delete(m.file); return next; });
                                  } else if (!result.success) {
                                    addNotification({ type: 'error', message: result.error || 'Download failed' });
                                    setDownloadProgress(prev => { const next = new Map(prev); next.delete(m.file); return next; });
                                  }
                                } catch (e) {
                                  addNotification({ type: 'error', message: e.message });
                                  setDownloadProgress(prev => { const next = new Map(prev); next.delete(m.file); return next; });
                                }
                              }}
                              title={`Download ${m.name} (${m.size}GB)`}
                            >
                              <FolderPlus size={12} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {/* Other models — may exceed VRAM */}
                    {(recommendedModels.other || []).length > 0 && (
                      <>
                        <button
                          className="w-full px-2 py-1 text-[10px] text-vsc-text-dim bg-vsc-bg/30 hover:text-vsc-text flex items-center gap-1"
                          onClick={() => setShowOtherModels(!showOtherModels)}
                        >
                          {showOtherModels ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                          Other Models ({recommendedModels.other.length}) &mdash; may exceed {recommendedModels.maxModelGB}GB limit
                        </button>
                        {showOtherModels && (recommendedModels.other || []).map(m => {
                          const isAlreadyDownloaded = llmModels.some(am => am.fileName === m.file || (am.name || '').includes(m.file));
                          const dlProgress = downloadProgress.get(m.file);
                          return (
                            <div key={m.file} className="px-2 py-1 text-[11px] flex items-center gap-2 border-b border-vsc-panel-border/20 opacity-60 hover:opacity-100 hover:bg-vsc-list-hover/30 transition-all">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1">
                                  <span className="text-vsc-text">{m.name}</span>
                                  <span className="text-[9px] text-vsc-error">{m.size}GB</span>
                                </div>
                                <div className="text-[10px] text-vsc-text-dim">{m.desc}</div>
                                {dlProgress && (
                                  <div className="mt-0.5 flex items-center gap-1.5">
                                    <div className="flex-1 h-1 bg-vsc-panel-border/30 rounded-full overflow-hidden">
                                      <div className="h-full bg-vsc-accent rounded-full transition-all duration-300" style={{ width: `${dlProgress.progress}%` }} />
                                    </div>
                                    <span className="text-[9px] text-vsc-text-dim">{dlProgress.downloadedMB}/{dlProgress.totalMB}MB</span>
                                    <button className="text-[9px] text-vsc-error" onClick={() => {
                                      fetch('/api/models/hf/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.file }) });
                                      setDownloadProgress(prev => { const next = new Map(prev); next.delete(m.file); return next; });
                                    }}><X size={9} /></button>
                                  </div>
                                )}
                              </div>
                              {isAlreadyDownloaded ? (
                                <span className="text-[9px] text-vsc-success flex-shrink-0 flex items-center gap-0.5"><Check size={10} /> Installed</span>
                              ) : dlProgress ? (
                                <span className="text-[10px] text-vsc-accent flex-shrink-0">{dlProgress.progress}%</span>
                              ) : (
                                <button
                                  className="p-1 bg-vsc-panel-border/30 text-vsc-text rounded hover:bg-vsc-panel-border/50 flex-shrink-0"
                                  onClick={async () => {
                                    setDownloadProgress(prev => { const next = new Map(prev); next.set(m.file, { progress: 0, downloadedMB: '0', totalMB: String(Math.round(m.size * 1024)) }); return next; });
                                    try {
                                      const result = await fetch('/api/models/hf/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: m.downloadUrl, fileName: m.file }) }).then(r => r.json());
                                      if (result.alreadyExists) { setDownloadProgress(prev => { const next = new Map(prev); next.delete(m.file); return next; }); }
                                    } catch {}
                                  }}
                                  title={`Download ${m.name} (${m.size}GB) — may not fit`}
                                >
                                  <FolderPlus size={12} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* ── Local LLM Models ──────────────────────────────── */}
          <div className="px-2 py-1 text-[10px] text-vsc-text-dim uppercase tracking-wider bg-vsc-sidebar/80 border-b border-vsc-panel-border/30 border-t flex items-center gap-1">
            <Cpu size={10} /> Local Models
          </div>
          {sorted.length === 0 ? (
            <div className="p-2 text-[11px] text-vsc-text-dim">
              No local models found. Add .gguf files below.
            </div>
          ) : (
            sorted.map(m => {
              const isCurrent = !isUsingCloud && currentModel?.path === m.path;
              const isFav = favoriteModels.includes(m.path);
              return (
                <button
                  key={m.path}
                  className={`w-full text-left px-2 py-1.5 text-[11px] hover:bg-vsc-list-hover flex items-center gap-2 ${
                    isCurrent ? 'bg-vsc-list-active' : ''
                  }`}
                  onClick={() => !isCurrent && loadModel(m.path)}
                >
                  <Cpu size={11} className="flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-vsc-text">{m.name}</div>
                    <div className="text-[10px] text-vsc-text-dim">
                      {m.sizeFormatted}
                      {m.details?.quantization && <> &bull; {m.details.quantization}</>}
                      {m.details?.parameters && <> &bull; {m.details.parameters}</>}
                    </div>
                  </div>
                  <button
                    className="p-0.5 flex-shrink-0 hover:bg-vsc-list-hover rounded"
                    onClick={e => { e.stopPropagation(); toggleFavoriteModel(m.path); }}
                    title={isFav ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    <Star size={10} className={isFav ? 'text-yellow-400 fill-yellow-400' : 'text-vsc-text-dim/30'} />
                  </button>
                  {isCurrent && <Check size={11} className="text-vsc-accent flex-shrink-0" />}
                </button>
              );
            })
          )}

          {/* ── Image Models (only if diffusion models exist) ── */}
          {diffusionModels.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] text-purple-400 uppercase tracking-wider bg-vsc-sidebar/80 border-b border-vsc-panel-border/30 border-t flex items-center gap-1">
                <ImageIcon size={10} /> Image Models
              </div>
              {diffusionModels.map(m => (
                <button
                  key={m.path}
                  className={`w-full text-left px-2 py-1.5 text-[11px] hover:bg-purple-900/20 flex items-center gap-2 ${
                    currentModel?.activeImageModelPath === m.path ? 'bg-purple-900/20' : ''
                  }`}
                  onClick={() => {
                    setCloudProvider(null);
                    setCloudModel(null);
                    // Switch image model via API
                    fetch('/api/models/load', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ modelPath: m.path }),
                    });
                    onClose();
                  }}
                >
                  <ImageIcon size={11} className="flex-shrink-0 text-purple-400" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-vsc-text">{m.name}</div>
                    <div className="text-[10px] text-vsc-text-dim">{m.sizeFormatted}{m.details?.quantization && <> &bull; {m.details.quantization}</>}</div>
                  </div>
                </button>
              ))}
            </>
          )}

          {/* Add Model Files + Rescan */}
          <input
            ref={modelFileInputRef}
            type="file"
            multiple
            accept=".gguf"
            className="hidden"
            onChange={async (e) => {
              const files = Array.from(e.target.files);
              if (!files.length) return;
              try {
                const formData = new FormData();
                files.forEach(f => formData.append('models', f));
                const resp = await fetch('/api/models/upload', { method: 'POST', body: formData });
                const data = await resp.json();
                if (data.success) {
                  addNotification({ type: 'info', message: `Added ${data.saved.length} model file(s).` });
                  onClose();
                } else {
                  addNotification({ type: 'error', message: data.error || 'Upload failed.' });
                }
              } catch (err) {
                addNotification({ type: 'error', message: 'Failed to upload model files.' });
              }
              e.target.value = '';
            }}
          />
          <button
            className="w-full text-left px-2 py-1.5 text-[11px] text-vsc-accent hover:bg-vsc-list-hover border-t border-vsc-panel-border/30 flex items-center gap-2"
            onClick={async () => {
              if (window.electronAPI?.modelsAdd) {
                try {
                  const result = await window.electronAPI.modelsAdd();
                  if (result?.success) {
                    try { await window.electronAPI?.modelsScan(); } catch { await fetch('/api/models/scan', { method: 'POST' }); }
                    onClose();
                  }
                } catch {
                  addNotification({ type: 'error', message: 'Failed to add model files.' });
                }
              } else {
                // Browser fallback — open file picker
                modelFileInputRef.current?.click();
              }
            }}
          >
            <FolderPlus size={11} />
            Add Model Files...
          </button>
          <button
            className="w-full text-left px-2 py-1.5 text-[11px] text-vsc-text-dim hover:bg-vsc-list-hover"
            onClick={async () => {
              try {
                await window.electronAPI?.modelsScan();
              } catch {
                await fetch('/api/models/scan', { method: 'POST' });
              }
              onClose();
            }}
          >
            &#x21BB; Rescan models
          </button>
        </div>
      </div>
    </>
  );
}

// Sub-component: renders model list for a specific cloud provider
function ProviderModelList({ provider, cloudProvider, cloudModel, selectCloudModel, favoriteModels, toggleFavoriteModel }) {
  const [models, setModels] = useState(null);

  useEffect(() => {
    fetch(`/api/cloud/models/${encodeURIComponent(provider)}`)
      .then(r => r.json())
      .then(d => setModels(d.models || []))
      .catch(() => setModels([]));
  }, [provider]);

  if (!models) {
    return <div className="text-[10px] text-vsc-text-dim py-1 flex items-center gap-1"><Loader size={10} className="animate-spin" /> Loading...</div>;
  }

  return models.map(m => (
    <button
      key={m.id}
      className={`w-full text-left px-1.5 py-1 text-[10px] hover:bg-vsc-list-hover rounded flex items-center gap-1.5 ${
        cloudProvider === provider && cloudModel === m.id ? 'bg-vsc-list-active' : ''
      }`}
      onClick={() => selectCloudModel(provider, m.id)}
    >
      <span className="truncate flex-1 text-vsc-text">{m.name || m.id}</span>
      {isVisionModel(provider, m.id) && <Eye size={9} className="text-vsc-accent flex-shrink-0" title="Vision" />}
      <button
        className="p-0.5 flex-shrink-0"
        onClick={e => { e.stopPropagation(); toggleFavoriteModel(`cloud:${provider}:${m.id}`); }}
      >
        <Star size={9} className={favoriteModels.includes(`cloud:${provider}:${m.id}`) ? 'text-yellow-400 fill-yellow-400' : 'text-vsc-text-dim/30'} />
      </button>
      {cloudProvider === provider && cloudModel === m.id && <Check size={10} className="text-vsc-accent flex-shrink-0" />}
    </button>
  ));
}

function TodoDropdown({ todos }) {
  const [expanded, setExpanded] = useState(false);
  const done = todos.filter(t => t.status === 'done').length;
  const total = todos.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const allDone = done === total;
  const inProgress = todos.find(t => t.status === 'in-progress');

  // Truncate active task text for collapsed header
  const activeText = inProgress?.text
    ? inProgress.text.length > 42 ? inProgress.text.slice(0, 42) + '...' : inProgress.text
    : null;

  return (
    <div className="border-b border-vsc-panel-border/30">
      <button
        className="w-full flex items-center gap-1.5 px-2.5 py-1 text-[10px] transition-colors hover:bg-vsc-list-hover/50"
        style={{ color: 'var(--vsc-text)' }}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex-shrink-0 text-vsc-text-dim">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <ListTodo size={10} className="flex-shrink-0" style={{ color: allDone ? '#89d185' : 'var(--vsc-accent)' }} />
        {activeText && !expanded ? (
          <>
            <span className="truncate min-w-0" style={{ color: '#dcdcaa' }}>{activeText}</span>
            <span className="flex-shrink-0 ml-auto pl-2 text-vsc-text-dim">{done}/{total}</span>
          </>
        ) : (
          <>
            <span className="font-medium flex-shrink-0" style={{ color: allDone ? '#89d185' : 'var(--vsc-text)' }}>
              {allDone ? 'Plan complete' : 'Plan'}
            </span>
            <span className="ml-1 flex-shrink-0 text-vsc-text-dim">{done}/{total}</span>
            <div className="flex-1 mx-2 h-[3px] rounded-full overflow-hidden min-w-[24px]" style={{ backgroundColor: 'var(--vsc-selection, #264f78)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${pct}%`, backgroundColor: allDone ? '#89d185' : 'var(--vsc-accent)' }}
              />
            </div>
          </>
        )}
      </button>
      {expanded && (
        <div
          className="px-2.5 pb-1 pt-0.5 space-y-0 overflow-y-auto scrollbar-thin"
          style={{ borderTop: '1px solid var(--vsc-panel-border, #2d2d2d)', maxHeight: '150px' }}
        >
          {todos.map(todo => (
            <div
              key={todo.id}
              className="flex items-start gap-1.5 py-[1px] text-[10px] transition-all duration-200"
              style={{
                color: todo.status === 'done' ? 'var(--vsc-text-dim)' : todo.status === 'in-progress' ? '#dcdcaa' : 'var(--vsc-text)',
                textDecoration: todo.status === 'done' ? 'line-through' : 'none',
                opacity: todo.status === 'done' ? 0.6 : 1,
              }}
            >
              {todo.status === 'done'
                ? <CheckCircle2 size={11} className="flex-shrink-0" style={{ color: '#89d185' }} />
                : todo.status === 'in-progress'
                  ? <Loader2 size={11} className="animate-spin flex-shrink-0" style={{ color: 'var(--vsc-accent)' }} />
                  : <Circle size={11} className="flex-shrink-0 text-vsc-text-dim" />
              }
              <span className="leading-snug">{todo.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
