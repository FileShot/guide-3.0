/**

 * App — Root component. Connects WebSocket, routes events to store, renders layout.

 */

import { useEffect, useCallback, useRef } from 'react';

import useAppStore from './stores/appStore';

import ThemeProvider from './components/ThemeProvider';

import Layout from './components/Layout';

import ErrorBoundary from './components/ErrorBoundary';

import NewProjectDialog from './components/NewProjectDialog';

import WelcomeScreen from './components/WelcomeScreen';

import WelcomeGuide from './components/WelcomeGuide';

import FirstRunWizard from './components/FirstRunWizard';
import { openFileFromReadResponse } from './utils/openFileFromRead';
import { handleLspDiagnostics } from './lib/lspBridge';
import isPocket from './lib/isPocket';

function pocketWelcomeDismissed() {
  try {
    return sessionStorage.getItem('pocket-welcome-dismissed') === '1';
  } catch (_) {
    return false;
  }
}
import { createDisplayPaceQueue } from './utils/displayPaceQueue';
import { traceUi } from './lib/traceUi';



export default function App() {

  const store = useAppStore();

  const settingsHydratedFromBackendRef = useRef(false);

  const lastSyncedSettingsJsonRef = useRef('');

  const paceEnabledRef = useRef(false);
  const paceStreamRef = useRef(null);
  const applyEventRef = useRef((event, data, _opts) => {});
  const streamFlushRafRef = useRef(null);

  if (!paceStreamRef.current) {
    paceStreamRef.current = createDisplayPaceQueue({
      tokensPerSec: 50,
      onTrace: (evt, fields) => traceUi(evt, fields),
      onFlush: (channel, chunk) => {
        const st = useAppStore.getState();
        if (channel === 'thinking') st.appendThinkingToken(chunk);
        else st.appendStreamToken(chunk);
      },
      onFlushEvent: (event, data) => {
        applyEventRef.current(event, data, { fromPaceQueue: true });
      },
    });
  }

  const scheduleStreamFlushRaf = () => {
    if (streamFlushRafRef.current) return;
    streamFlushRafRef.current = requestAnimationFrame(() => {
      streamFlushRafRef.current = null;
      useAppStore.getState().flushPendingStreamTokens?.();
    });
  };

  const PACED_UI_EVENTS = new Set(['tool-generating', 'tool-executing', 'mcp-tool-results']);

  const handleEvent = useCallback((event, data, opts = {}) => {

    const s = useAppStore.getState();
    const fromPaceQueue = !!opts.fromPaceQueue;

    if (!fromPaceQueue && paceEnabledRef.current && PACED_UI_EVENTS.has(event)) {
      paceStreamRef.current?.enqueueEvent(event, data);
      return;
    }

    if (event !== 'output-log') {
      traceUi('handleEvent', {
        event,
        data,
        epoch: s.activeChatEpoch,
        chatGenerationEpoch: s.chatGenerationEpoch,
        chatStreaming: s.chatStreaming,
        fromPaceQueue,
      });
    }

    switch (event) {

      case 'connection-ready':

        // Fetch initial state

        fetch('/api/models').then(r => r.json()).then(d => {

          s.setAvailableModels(d.models || []);

          s.setModelState({ modelLoaded: d.status?.isReady || false, modelInfo: d.status?.modelInfo || null });

        }).catch(() => {});

        fetch('/api/media/status').then(r => r.json()).then(st => {

          if (st?.loaded) {
            s.setActiveMediaModel(st);
            s.setModelState({ modelLoaded: false, modelLoading: false, modelInfo: null });
          }

        }).catch(() => {});

        fetch('/api/project/current').then(r => r.json()).then(d => {

          const pocketWeb = window.__POCKET__ || isPocket();
          if (pocketWeb && !pocketWelcomeDismissed()) return;

          if (d.projectPath) {

            s.setProjectPath(d.projectPath);

            fetch(`/api/files/tree?path=${encodeURIComponent(d.projectPath)}`).then(r => r.json()).then(t => {

              s.setFileTree(t.items || []);

            }).catch(() => {});

          }

        }).catch(() => {});

        fetch('/api/settings').then(r => r.json()).then(d => {

          s.setSettings(d);

          if (d?.lastCloudProvider) {
            s.setCloudProvider(d.lastCloudProvider);
            s.setCloudModel(d.lastCloudModel || null);
          }

          settingsHydratedFromBackendRef.current = true;

          lastSyncedSettingsJsonRef.current = JSON.stringify(d || {});

          s.setSettingsSyncState({ status: 'saved', error: null, at: Date.now() });

        }).catch(() => {

          s.setSettingsSyncState({ status: 'error', error: 'Failed to load settings from backend', at: null });

        });

        break;



      // LLM streaming events

      case 'llm-stream-config':

        paceEnabledRef.current = !!data?.paceDisplay;

        if (!data?.paceDisplay) {

          paceStreamRef.current?.reset();

        }

        break;

      case 'llm-stream-end':

        paceStreamRef.current?.flushNow();

        paceEnabledRef.current = false;

        if (s.planSession?.status === 'building') {
          s.setPlanSession({ ...s.planSession, status: 'done' });
        }

        break;

      case 'llm-token':

        if (paceEnabledRef.current) {

          paceStreamRef.current?.enqueue('text', data);

        } else {

          s.appendStreamToken(data);

          scheduleStreamFlushRaf();

        }

        break;

      case 'file-content-start':

        s.startFileContentBlock(data);

        break;

      case 'file-content-token':

        s.appendFileContentToken(data);

        break;

      case 'file-content-end':

        s.endFileContentBlock(data);

        break;

      case 'file-content-block-complete':

        s.addCompleteFileContentBlock(data);

        break;

      case 'file-content-lint':

        if (data?.filePath && data?.diagnostics) s.setFileLintErrors(data.filePath, data.diagnostics);

        break;

      case 'llm-thinking-token':

        if (paceEnabledRef.current) {

          paceStreamRef.current?.enqueue('thinking', data);

        } else {

          s.appendThinkingToken(data);

        }

        break;

      case 'llm-tool-generating':

        s.setChatGeneratingTool(data);

        break;

      case 'llm-iteration-begin':

        break;

      case 'llm-replace-last':

        s.replaceLastStreamingChunk(data.originalLength, data.replacement, data.channel);

        break;



      // Context & progress

      case 'context-usage':

        s.setChatContextUsage(data);

        break;

      case 'agentic-progress':

        s.setChatIteration(data);

        break;

      case 'token-stats':

        s.setTokenStats(data);

        break;

      case 'generation-error':

        if (s.activeChatEpoch !== s.chatGenerationEpoch) break;

        if (!s.chatStreaming) break;

        s.addChatMessage({

          role: 'assistant',

          content: '',

          isError: true,

          errorMessage: data?.message || 'Generation failed',

          errorSuggestion: data?.usageLimit ? '' : (data?.suggestion || ''),

          usageLimit: !!data?.usageLimit,

          needsAccount: data?.needsAccount != null
            ? !!data.needsAccount
            : data?.tier === 'guest',

          usageTier: data?.tier || null,

        });

        break;

      case 'generation-warning':

        // VRAM/context warnings go to statusbar only — NOT as intrusive notification overlay

        s.setVramWarning(data?.message || '');

        break;



      // Tool events — backend sends arrays: [{tool, params}, ...]

      case 'tool-executing': {

        if (s.activeChatEpoch !== s.chatGenerationEpoch) break;

        console.log('[App] tool-executing:', JSON.stringify(data).substring(0, 200));

        const items = Array.isArray(data) ? data : [data];

        if (!Array.isArray(items)) {

          console.error('[App] tool-executing: data is not iterable!', data);

          break;

        }

        for (const item of items) {

          if (!item || typeof item !== 'object') {

            console.warn('[App] tool-executing: skipping non-object item', item);

            continue;

          }

          const toolName = item.tool || item.functionName || item.name;

          // Check if a 'generating' card already exists for this tool — update it instead of duplicating

          const existing = s.streamingToolCalls.find(tc => tc.functionName === toolName && tc.status === 'generating');

          if (existing) {

            s.updateStreamingToolCall(toolName, {

              params: item.params || item.arguments,

              status: 'pending',

              startTime: Date.now(),

            });

          } else {

            s.addStreamingToolCall({

              functionName: toolName,

              params: item.params || item.arguments,

              status: 'pending',

              startTime: Date.now(),

            });

          }

        }

        break;

      }

      case 'tool-generating': {

        // Model is actively generating a tool call — show a generating indicator

        const toolName = data?.tool || 'tool';

        s.addStreamingToolCall({

          functionName: toolName,

          params: {},

          status: 'generating',

          startTime: Date.now(),

        });

        break;

      }

      case 'tool-generating-progress': {

        const toolName = data?.tool || 'tool';

        s.updateStreamingToolCall(toolName, {

          status: 'generating',

          generatingProgress: {

            elapsedMs: data?.elapsedMs ?? 0,

            fenceChars: data?.fenceChars ?? 0,

            filePath: data?.filePath,

          },

          params: data?.filePath ? { filePath: data.filePath } : {},

        });

        break;

      }

      case 'command-slow-warning': {

        const toolName = data?.tool || 'run_command';

        s.updateStreamingToolCall(toolName, {

          commandSlowProgress: {

            elapsedMs: data?.elapsedMs ?? 0,

            command: data?.command,

          },

        });

        break;

      }

      case 'mcp-tool-results': {

        console.log('[App] mcp-tool-results:', JSON.stringify(data).substring(0, 200));

        const results = Array.isArray(data) ? data : [data];

        if (!Array.isArray(results)) {

          console.error('[App] mcp-tool-results: data is not iterable!', data);

          break;

        }

        for (const item of results) {

          if (!item || typeof item !== 'object') {

            console.warn('[App] mcp-tool-results: skipping non-object item', item);

            continue;

          }

          const name = item.tool || item.functionName || item.name;

          s.updateStreamingToolCall(name, {

            status: item.result?.error || item.success === false ? 'error' : 'success',

            result: item.result,

            duration: Date.now() - (s.streamingToolCalls.find(tc => tc.functionName === name && tc.status === 'pending')?.startTime || Date.now()),

          });

        }

        break;

      }

      case 'tool-checkpoint': {

        // Attach checkpoint metadata to the last assistant message so the
        // restore button in ChatPanel can find the turnId for file restore.
        const cpData = Array.isArray(data) ? data[data.length - 1] : data;
        if (cpData?.turnId) {
          const { chatMessages } = s;
          // Find the last assistant message
          for (let i = chatMessages.length - 1; i >= 0; i--) {
            if (chatMessages[i].role === 'assistant') {
              const updated = [...chatMessages];
              updated[i] = { ...updated[i], checkpoint: { turnId: cpData.turnId, timestamp: cpData.timestamp, fileCount: cpData.fileCount } };
              useAppStore.setState({ chatMessages: updated });
              console.log(`[App] tool-checkpoint: attached turnId=${cpData.turnId} to msg[${i}]`);
              break;
            }
          }
        }

        break;

      }



      // File events

      case 'files-changed': {
        const deletedPaths = Array.isArray(data?.deletedPaths) ? data.deletedPaths : [];
        const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
        if (deletedPaths.length > 0) {
          const st = useAppStore.getState();
          for (const dp of deletedPaths) {
            const n = norm(dp);
            const tab = st.openTabs.find((t) => norm(t.path) === n);
            if (tab) st.closeTab(tab.id);
            if (st.fileLintErrors?.[dp]) {
              const nextLint = { ...st.fileLintErrors };
              delete nextLint[dp];
              useAppStore.setState({ fileLintErrors: nextLint });
            }
          }
          st.setChatFilesChanged(st.chatFilesChanged.filter((f) => !deletedPaths.some((dp) => norm(f.path) === norm(dp))));
          const previewUrl = st.viewportNavigateUrl || '';
          if (previewUrl && deletedPaths.some((dp) => {
            const n = norm(dp);
            return norm(previewUrl).includes(n) || previewUrl.startsWith('file://') && norm(previewUrl).includes(n);
          })) {
            st.resetBrowserPreview();
          }
        }
        if (s.projectPath) {
          fetch(`/api/files/tree?path=${encodeURIComponent(s.projectPath)}`).then(r => r.json()).then(t => {
            s.setFileTree(t.items || []);
          }).catch(() => {});
        }
        break;
      }

      case 'open-file':

        if (typeof data === 'string') {

          fetch(`/api/files/read?path=${encodeURIComponent(data)}`).then(r => r.json()).then(openFileFromReadResponse).catch(() => {});

        }

        break;

      case 'agent-file-modified':

        if (data?.filePath) {

          const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
          const fileNorm = normPath(data.filePath);
          const dismissed = s.dismissedStreamingTabPaths || [];
          const autoOpen = s.settings?.autoOpenAgentFiles !== false;
          let tab = s.openTabs.find(t => normPath(t.path) === fileNorm);

          if (!tab && autoOpen && !dismissed.includes(fileNorm)) {
            const fileName = data.filePath.split(/[\\/]/).pop() || data.filePath;
            s.openFile({
              path: data.filePath,
              name: fileName,
              extension: fileName.includes('.') ? fileName.split('.').pop() : '',
              content: data.newContent || '',
              originalContent: data.originalContent != null ? data.originalContent : '',
            });
            tab = useAppStore.getState().openTabs.find(t => normPath(t.path) === fileNorm);
          } else if (!tab && (data.newContent != null || data.originalContent != null)) {
            // Tab dismissed or auto-open off — skip opening; content still lands on disk.
          } else if (tab && data.originalContent != null) {
            const newContent = data.newContent || '';
            const baseline = data.originalContent;
            useAppStore.setState({
              openTabs: useAppStore.getState().openTabs.map((t) =>
                t.id === tab.id
                  ? { ...t, content: newContent, originalContent: baseline, modified: newContent !== baseline }
                  : t,
              ),
            });
            tab = useAppStore.getState().openTabs.find(t => t.id === tab.id);
          } else if (tab) {
            // R51-Fix: Don't markTabSaved — keep the tab in a modified state

            // so dirty diff decorations (green/red gutter) show the AI's changes.

            // originalContent stays as-is (the pre-AI state), content gets updated.

            s.updateTabContent(tab.id, data.newContent || '');
          }

          // R51-Fix: Populate chatFilesChanged so the keep/undo banner appears

          // above the chat input when the AI creates or modifies files.

          const fileName = data.filePath.split(/[\\/]/).pop() || data.filePath;

          if (!data.preview) {

            const oldContent = data.originalContent ?? tab?.originalContent ?? tab?.content ?? '';

            const newContent = data.newContent || '';

            const oldLines = oldContent.split('\n').length;

            const newLines = newContent.split('\n').length;

            s.addChatFileChanged({

              path: data.filePath,

              name: fileName,

              linesAdded: data.isNew ? newLines : Math.max(0, newLines - oldLines),

              linesRemoved: data.isNew ? 0 : Math.max(0, oldLines - newLines),

            });

            s.syncComposerFiles();

          }

        }

        break;



      case 'background-agent-complete':

        s.upsertBackgroundAgentJob({

          id: data?.jobId,

          task: data?.task,

          status: data?.status,

          result: data?.result,

          error: data?.error,

          completedAt: Date.now(),

        });

        s.addNotification({

          type: data?.status === 'completed' ? 'info' : 'error',

          message: data?.status === 'completed'

            ? `Background agent finished: ${(data?.task || '').slice(0, 60)}`

            : `Background agent failed: ${data?.error || 'Unknown error'}`,

          duration: 6000,

        });

        break;



      case 'sub-agent-spawned':

        if (data?.id) {

          s.addSubAgentBadge({ id: data.id, task: data.task || 'Sub-agent', status: 'running' });

        }

        break;



      case 'sub-agent-completed':

        if (data?.id) {

          s.updateSubAgentBadge(data.id, {

            status: data.success ? 'done' : 'error',

          });

        }

        break;



      // Model events

      case 'llm-status':

        s.setLlmStatus(data);

        if (data?.state === 'ready') {
          s.setModelState({ modelLoaded: true, modelLoading: false, modelInfo: data.modelInfo });
          const samp = data.modelInfo?.sampling;
          if (samp && typeof samp === 'object') {
            const cur = useAppStore.getState().settings;
            const next = {
              ...cur,
              ...(typeof samp.temperature === 'number' ? { temperature: samp.temperature, _defaultTemperature: samp.temperature } : {}),
              ...(typeof samp.topP === 'number' ? { topP: samp.topP, _defaultTopP: samp.topP } : {}),
              ...(typeof samp.topK === 'number' ? { topK: samp.topK, _defaultTopK: samp.topK } : {}),
              ...(typeof samp.repeatPenalty === 'number' ? { repeatPenalty: samp.repeatPenalty, _defaultRepeatPenalty: samp.repeatPenalty } : {}),
              ...(typeof samp.presencePenalty === 'number' ? { presencePenalty: samp.presencePenalty, _defaultPresencePenalty: samp.presencePenalty } : {}),
              ...(typeof samp.frequencyPenalty === 'number' ? { frequencyPenalty: samp.frequencyPenalty, _defaultFrequencyPenalty: samp.frequencyPenalty } : {}),
            };
            try { localStorage.setItem('guIDE-settings', JSON.stringify(next)); } catch (_) {}
            useAppStore.setState({ settings: next, settingsSkipDebounceUntil: Date.now() + 2000 });
            lastSyncedSettingsJsonRef.current = JSON.stringify(next);
          }
        } else if (data?.state === 'loading') {

          s.setModelState({ modelLoading: true, modelLoadProgress: data.progress || 0 });

        } else if (data?.state === 'error') {

          s.setModelState({ modelLoading: false });

          s.addNotification({ type: 'error', message: `Model error: ${data.message}` });

        }

        break;

      case 'model-unloaded': {

        s.setModelState({ modelLoaded: false, modelLoading: false, modelInfo: null });

        break;

      }

      case 'media-model-loaded': {
        s.setActiveMediaModel(data);
        s.setModelState({ modelLoaded: false, modelLoading: false, modelInfo: null });
        if (data?.mediaReadiness && data.mediaReadiness.ready === false) {
          const missing = (data.mediaReadiness.missing || []).join(', ');
          s.setMediaStatus({
            phase: 'error',
            message: missing
              ? `${data.ggufArchitecture || 'Media'}: needs ${missing} — HF token may be required (Settings → Media)`
              : `${data.ggufArchitecture || 'Media'}: companions missing — check Settings → Media`,
          });
        }
        break;
      }

      case 'media-model-unloaded':
        s.setActiveMediaModel(null);
        break;

      case 'media-aux-progress':
        if (data?.phase === 'start' && data.message) {
          s.setMediaStatus({ phase: 'download', message: data.message, label: data.label });
        } else if (data?.phase === 'progress' && data.pct != null) {
          s.setMediaStatus({
            phase: 'download',
            message: `Downloading ${data.label || 'weights'}… ${data.pct}%`,
            pct: data.pct,
            label: data.label,
          });
        } else if (data?.phase === 'done' && data.label) {
          s.setMediaStatus({ phase: 'download', message: `${data.label} ready`, label: data.label });
          setTimeout(() => {
            const cur = useAppStore.getState().mediaStatus;
            if (cur?.phase === 'download' && cur?.label === data.label) s.clearMediaStatus();
          }, 3000);
        } else if (data?.phase === 'error') {
          s.setMediaStatus({ phase: 'error', message: data.error || 'Could not prepare generation' });
        } else if (data?.phase === '5d-fix' && data.message) {
          s.setMediaStatus({ phase: 'generating', message: data.message });
        }
        break;

      case 'media-generating':
        s.applyMediaGenerating(data);
        s.setMediaStatus({
          phase: 'generating',
          message: data?.mediaType === 'video' ? 'Generating video…' : 'Generating image…',
          startedAt: data?.startedAt || Date.now(),
          mediaType: data?.mediaType,
        });
        break;

      case 'media-gen-progress': {
        const elapsedSec = data?.elapsedMs != null ? Math.floor(data.elapsedMs / 1000) : 0;
        const stepPart = data?.step && data?.totalSteps ? ` step ${data.step}/${data.totalSteps}` : '';
        const durPart = data?.estDurationSec ? ` · ~${data.estDurationSec}s clip` : '';
        const cpuPart = data?.sdCpuFallback ? ' · CPU' : '';
        s.setMediaStatus({
          phase: 'generating',
          message: data?.label || `Generating… ${elapsedSec}s${stepPart}${durPart}${cpuPart}`,
          startedAt: data?.startedAt,
          mediaType: data?.videoFrames ? 'video' : undefined,
          sdCpuFallback: data?.sdCpuFallback,
        });
        break;
      }

      case 'media-complete':
        s.applyMediaComplete(data);
        s.setMediaStatus({
          phase: 'done',
          message: data?.mediaType === 'video' ? 'Video ready' : 'Image ready',
        });
        setTimeout(() => useAppStore.getState().clearMediaStatus(), 3000);
        break;

      case 'media-error':
        s.applyMediaError(data);
        s.setMediaStatus({
          phase: 'error',
          message: data?.error || 'Media generation failed',
        });
        break;

      case 'model-loaded': {

        s.setActiveMediaModel(null);
        s.setModelState({ modelLoaded: true, modelLoading: false, modelInfo: data });

        if (data?.runtimeThinkingMode != null) {
          const cur = useAppStore.getState().settings;
          if (cur.thinkingMode !== data.runtimeThinkingMode) {
            const next = { ...cur, thinkingMode: data.runtimeThinkingMode };
            try { localStorage.setItem('guIDE-settings', JSON.stringify(next)); } catch (_) {}
            useAppStore.setState({
              settings: next,
              settingsSkipDebounceUntil: Date.now() + 2000,
            });
            lastSyncedSettingsJsonRef.current = JSON.stringify(next);
          }
        }

        if (data?.sampling && typeof data.sampling === 'object') {
          const cur = useAppStore.getState().settings;
          const samp = data.sampling;
          const next = {
            ...cur,
            ...(typeof samp.temperature === 'number' ? { temperature: samp.temperature, _defaultTemperature: samp.temperature } : {}),
            ...(typeof samp.topP === 'number' ? { topP: samp.topP, _defaultTopP: samp.topP } : {}),
            ...(typeof samp.topK === 'number' ? { topK: samp.topK, _defaultTopK: samp.topK } : {}),
            ...(typeof samp.repeatPenalty === 'number' ? { repeatPenalty: samp.repeatPenalty, _defaultRepeatPenalty: samp.repeatPenalty } : {}),
            ...(typeof samp.presencePenalty === 'number' ? { presencePenalty: samp.presencePenalty, _defaultPresencePenalty: samp.presencePenalty } : {}),
            ...(typeof samp.frequencyPenalty === 'number' ? { frequencyPenalty: samp.frequencyPenalty, _defaultFrequencyPenalty: samp.frequencyPenalty } : {}),
          };
          try { localStorage.setItem('guIDE-settings', JSON.stringify(next)); } catch (_) {}
          useAppStore.setState({
            settings: next,
            settingsSkipDebounceUntil: Date.now() + 2000,
          });
          lastSyncedSettingsJsonRef.current = JSON.stringify(next);
        }

        break;
      }

      case 'model-loading':

        s.setModelState({ modelLoading: true });

        break;

      case 'model-error':

        s.setModelState({ modelLoading: false });

        s.addNotification({ type: 'error', message: data?.error || 'Model load error' });

        break;

      case 'models-updated':

        if (Array.isArray(data)) s.setAvailableModels(data);

        break;



      // Project

      case 'project-opened':

        if (data?.path) {

          s.setProjectPath(data.path);

          fetch(`/api/files/tree?path=${encodeURIComponent(data.path)}`).then(r => r.json()).then(t => {

            s.setFileTree(t.items || []);

          }).catch(() => {});

        }

        break;



      // Todo

      case 'todo-update':

        if (Array.isArray(data)) s.setTodos(data);

        break;



      case 'plan-ready':

        if (data) {
          const cur = s.planSession;
          const curStatus = cur?.status;
          if (curStatus === 'building' || curStatus === 'done' || curStatus === 'dismissed') {
            break;
          }
          s.setPlanSession({
            id: data.path || cur?.id || `plan-${Date.now()}`,
            path: data.path,
            fullPath: data.fullPath,
            content: data.content,
            title: data.title || 'Implementation Plan',
            overview: data.overview || '',
            todos: Array.isArray(data.todos) ? data.todos : [],
            status: curStatus === 'planning' || !curStatus ? 'ready' : (curStatus === 'ready' ? 'ready' : 'ready'),
          });
        }

        break;



      case 'plan-todos-updated':

        if (data?.todos) {
          const current = s.planSession;
          if (current) {
            s.setPlanSession({
              ...current,
              todos: data.todos,
              status: current.status === 'planning' ? 'ready' : current.status,
            });
          }
        }

        break;



      // Ask question from model

      case 'ask-question':

        if (data) s.setPendingQuestion(data);

        break;



      // Permission request from execution policy

      case 'permission-request':

        if (data) s.setPendingPermission(data);

        break;



      // Agent pause

      case 'agent-paused':

        break;



      // File content accumulation update

      case 'llm-file-acc-update':

        // R27-D: Update the streaming file block with full accumulated content

        if (data?.filePath && data?.fullContent) {

          s.updateFileBlockContent({ filePath: data.filePath, fullContent: data.fullContent });

        }

        break;



      // Model download events

      case 'download-started':

        s.updateModelDownload(data.id, { ...data, status: 'downloading', percent: 0 });

        break;

      case 'download-progress':

        s.updateModelDownload(data.id, { ...data, status: 'downloading' });

        break;

      case 'download-complete':

        s.updateModelDownload(data.id, { ...data, status: 'complete' });

        s.addNotification({ type: 'info', message: `Downloaded: ${data.fileName}` });

        break;

      case 'download-error':

        s.updateModelDownload(data.id, { ...data, status: 'error' });

        s.addNotification({ type: 'error', message: `Download failed: ${data.error}` });

        break;

      case 'download-cancelled':

        s.removeModelDownload(data.id);

        break;



      // Debug events

      case 'debug-event':

        s.handleDebugEvent(data);

        break;

      case 'output-log':

        if (typeof data === 'string') s.appendOutputLog(data);

        else s.appendOutputLog(data?.message ?? data?.text ?? '', data?.channel || data?.level || 'Main');

        break;

      case 'debug-console':

        if (typeof data === 'string') s.appendDebugConsole(data);

        else s.appendDebugConsole(data?.text ?? data?.output ?? '');

        break;



      default:

        break;

    }

  }, []);

  useEffect(() => {
    applyEventRef.current = handleEvent;
  }, [handleEvent]);

  // Hydrate the application version from package.json (via Electron IPC or
  // websocket fallback) into the global store exactly once. Every UI surface
  // that needs to display "guIDE <version>" reads from useAppStore.appVersion
  // so there is a single source of truth and no hardcoded version strings.
  useEffect(() => {

    let cancelled = false;

    (async () => {

      try {

        const v = window.electronAPI?.getAppVersion

          ? await window.electronAPI.getAppVersion()

          : (await (await import('./api/websocket')).invoke('get-app-version'));

        if (!cancelled && v) useAppStore.getState().setAppVersion(v);

      } catch (e) { console.warn('[App] appVersion hydrate failed:', e?.message || e); }

    })();

    return () => { cancelled = true; };

  }, []);

  // Pocket: load settings over HTTP immediately (do not wait for WS apiFetch)
  useEffect(() => {
    if (!window.__POCKET__ && !isPocket()) return;
    const nativeFetch = window.__nativeFetch || window.fetch;
    let cancelled = false;
    (async () => {
      try {
        const r = await nativeFetch('/api/settings', { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (cancelled || !d || d.error) return;
        const s = useAppStore.getState();
        s.setSettings(d);
        if (d?.lastCloudProvider) {
          s.setCloudProvider(d.lastCloudProvider);
          s.setCloudModel(d.lastCloudModel || null);
        }
        settingsHydratedFromBackendRef.current = true;
        lastSyncedSettingsJsonRef.current = JSON.stringify(d || {});
        s.setSettingsSyncState({ status: 'saved', error: null, at: Date.now() });
      } catch (_) {
        if (!cancelled) {
          useAppStore.getState().setSettingsSyncState({
            status: 'error',
            error: 'Failed to load settings from backend',
            at: null,
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {

    // Global error handlers for debugging "not iterable" and other frontend errors

    window.onerror = (message, source, lineno, colno, error) => {

      console.error('[App] window.onerror:', message, 'at', source, lineno, colno, error);

    };

    window.onunhandledrejection = (event) => {

      console.error('[App] window.onunhandledrejection:', event.reason);

    };

    const api = window.electronAPI;

    if (!api) {

      // Fallback: legacy WebSocket mode (dev server without Electron)

      import('./api/websocket').then(({ connect }) => {

        connect(handleEvent, (connected) => useAppStore.getState().setConnected(connected));

      });

      return;

    }

    const isPocketWeb = window.__POCKET__ || isPocket();
    let connectionReadyFired = false;

    const fireConnectionReady = () => {
      if (connectionReadyFired) return;
      connectionReadyFired = true;
      handleEvent('connection-ready', null);
    };

    if (isPocketWeb) {
      useAppStore.getState().setConnected(false);
    } else {
      useAppStore.getState().setConnected(true);
      fireConnectionReady();
    }

    // Register IPC event listeners — each returns a cleanup function

    const cleanups = [

      isPocketWeb && api.onConnectionChange
        ? api.onConnectionChange((connected) => {
            useAppStore.getState().setConnected(connected);
            if (connected) fireConnectionReady();
          })
        : null,

      api.onLlmToken?.((d) => handleEvent('llm-token', d)),

      api.onLlmThinkingToken?.((d) => handleEvent('llm-thinking-token', d)),

      api.onLlmToolGenerating?.((d) => handleEvent('llm-tool-generating', d)),

      api.onLlmIterationBegin?.((d) => handleEvent('llm-iteration-begin', d)),

      api.onLlmReplaceLast?.((d) => handleEvent('llm-replace-last', d)),

      api.onLlmStreamConfig?.((d) => handleEvent('llm-stream-config', d)),

      api.onLlmStreamEnd?.((d) => handleEvent('llm-stream-end', d)),

      api.onLlmStatus?.((d) => handleEvent('llm-status', d)),

      api.onLlmFileAccUpdate?.((d) => handleEvent('llm-file-acc-update', d)),

      api.onFileContentStart?.((d) => handleEvent('file-content-start', d)),

      api.onFileContentToken?.((d) => handleEvent('file-content-token', d)),

      api.onFileContentEnd?.((d) => handleEvent('file-content-end', d)),

      api.onFileContentBlockComplete?.((d) => handleEvent('file-content-block-complete', d)),

      api.onContextUsage?.((d) => handleEvent('context-usage', d)),

      api.onAgenticProgress?.((d) => handleEvent('agentic-progress', d)),

      api.onTokenStats?.((d) => handleEvent('token-stats', d)),

      api.onGenerationError?.((d) => handleEvent('generation-error', d)),

      api.onGenerationWarning?.((d) => handleEvent('generation-warning', d)),

      api.onToolExecuting?.((d) => handleEvent('tool-executing', d)),

      api.onToolGenerating?.((d) => handleEvent('tool-generating', d)),

      api.onToolGeneratingProgress?.((d) => handleEvent('tool-generating-progress', d)),

      api.onCommandSlowWarning?.((d) => handleEvent('command-slow-warning', d)),

      api.onShowViewportBrowser?.(() => useAppStore.getState().openBrowserTab()),

      api.onPreviewNavigate?.((data) => {

        const url = data?.url;

        if (url) useAppStore.getState().setViewportNavigateUrl(url);

        useAppStore.getState().openBrowserTab();

      }),

      api.onMcpToolResults?.((d) => handleEvent('mcp-tool-results', d)),

      api.onToolCheckpoint?.((d) => handleEvent('tool-checkpoint', d)),

      api.onFilesChanged?.((d) => handleEvent('files-changed', d)),

      api.onOpenFile?.((d) => handleEvent('open-file', d)),

      api.onAgentFileModified?.((d) => handleEvent('agent-file-modified', d)),

      api.onFileContentLint?.((d) => handleEvent('file-content-lint', d)),

      api.onModelLoaded?.((d) => handleEvent('model-loaded', d)),

      api.onModelUnloaded?.((d) => handleEvent('model-unloaded', d)),

      api.onModelLoading?.((d) => handleEvent('model-loading', d)),

      api.onModelError?.((d) => handleEvent('model-error', d)),

      api.onModelsUpdated?.((d) => handleEvent('models-updated', d)),

      api.onMediaModelLoaded?.((d) => handleEvent('media-model-loaded', d)),

      api.onMediaModelUnloaded?.((d) => handleEvent('media-model-unloaded', d)),


      api.onMediaAuxProgress?.((d) => handleEvent('media-aux-progress', d)),
      api.onMediaGenerating?.((d) => handleEvent('media-generating', d)),
      api.onMediaGenProgress?.((d) => handleEvent('media-gen-progress', d)),

      api.onMediaComplete?.((d) => handleEvent('media-complete', d)),

      api.onMediaError?.((d) => handleEvent('media-error', d)),

      api.onProjectOpened?.((d) => handleEvent('project-opened', d)),

      api.onTodoUpdate?.((d) => handleEvent('todo-update', d)),

      api.onPlanReady?.((d) => handleEvent('plan-ready', d)),

      api.onPlanTodosUpdated?.((d) => handleEvent('plan-todos-updated', d)),

      api.onAskQuestion?.((d) => handleEvent('ask-question', d)),

      api.onPermissionRequest?.((d) => handleEvent('permission-request', d)),

      api.onAgentPaused?.((d) => handleEvent('agent-paused', d)),

      api.onDownloadStarted?.((d) => handleEvent('download-started', d)),

      api.onDownloadProgress?.((d) => handleEvent('download-progress', d)),

      api.onDownloadComplete?.((d) => handleEvent('download-complete', d)),

      api.onDownloadError?.((d) => handleEvent('download-error', d)),

      api.onDownloadCancelled?.((d) => handleEvent('download-cancelled', d)),

      api.onDebugEvent?.((d) => handleEvent('debug-event', d)),

      api.onOutputLog?.((d) => handleEvent('output-log', d)),

      api.onDebugConsole?.((d) => handleEvent('debug-console', d)),

      api.onLspDiagnostics?.((d) => handleLspDiagnostics(d)),

      api.onBackgroundAgentComplete?.((d) => handleEvent('background-agent-complete', d)),

      api.onSubAgentSpawned?.((d) => handleEvent('sub-agent-spawned', d)),

      api.onSubAgentCompleted?.((d) => handleEvent('sub-agent-completed', d)),

    ].filter(Boolean);



    return () => cleanups.forEach(fn => fn());

  }, [handleEvent]);



  // Persist settings to backend (debounced) so model loads and restarts use the same values users see in UI.

  useEffect(() => {

    const s = useAppStore.getState();

    const settings = s.settings;

    const settingsJson = JSON.stringify(settings || {});



    // Wait until initial /api/settings hydration completes to avoid writing defaults over saved backend config.

    if (!settingsHydratedFromBackendRef.current) return;

    // No-op if nothing changed since last successful sync.

    if (settingsJson === lastSyncedSettingsJsonRef.current) return;

    if ((s.settingsSkipDebounceUntil || 0) > Date.now()) return;

    s.setSettingsSyncState({ status: 'saving', error: null, at: s.settingsLastSyncedAt });



    const t = setTimeout(() => {
      window.electronAPI?.uiLog?.(`App.jsx settings debounce POST jsonLen=${settingsJson.length}`);
      fetch('/api/settings', {

        method: 'POST',

        headers: { 'Content-Type': 'application/json' },

        body: settingsJson,

      })

        .then(r => r.json())

        .then(() => {

          lastSyncedSettingsJsonRef.current = settingsJson;

          useAppStore.getState().setSettingsSyncState({ status: 'saved', error: null, at: Date.now() });

        })

        .catch((e) => {

          useAppStore.getState().setSettingsSyncState({

            status: 'error',

            error: e?.message || 'Failed to save settings to backend',

            at: useAppStore.getState().settingsLastSyncedAt,

          });

        });

    }, 300);



    return () => clearTimeout(t);

  }, [store.settings]);



  // Listen for native Electron menu actions (sent via IPC from appMenu.js)

  useEffect(() => {

    if (!window.electronAPI?.onMenuAction) return;

    window.electronAPI.onMenuAction((action) => {

      const s = useAppStore.getState();

      switch (action) {

        case 'newFile': {

          const name = prompt('New file name:');

          if (!name) return;

          const base = s.projectPath;

          if (!base) { s.addNotification({ type: 'error', message: 'Open a folder first' }); return; }

          fetch('/api/files/create', {

            method: 'POST', headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ path: `${base}/${name}`, content: '' }),

          }).then(r => r.json()).then(d => {

            if (d.error) s.addNotification({ type: 'error', message: d.error });

            else s.openFile({ path: d.path, name, extension: name.split('.').pop(), content: '' });

          }).catch(e => s.addNotification({ type: 'error', message: e.message }));

          return;

        }

        case 'newWindow': {

          if (window.electronAPI?.newWindow) window.electronAPI.newWindow();

          return;

        }

        case 'openFolder': {

          if (window.electronAPI?.openFolderDialog) {

            window.electronAPI.openFolderDialog().then(folderPath => {

              if (folderPath) {

                fetch('/api/project/open', {

                  method: 'POST', headers: { 'Content-Type': 'application/json' },

                  body: JSON.stringify({ projectPath: folderPath }),

                }).then(r => r.json()).then(d => {

                  if (!d.error) s.setProjectPath(folderPath);

                }).catch(() => {});

              }

            });

          }

          return;

        }

        case 'save': {

          const tab = s.openTabs.find(t => t.id === s.activeTabId);

          if (tab && tab.modified) {

            fetch('/api/files/write', {

              method: 'POST', headers: { 'Content-Type': 'application/json' },

              body: JSON.stringify({ filePath: tab.path, content: tab.content }),

            }).then(r => r.json()).then(res => {

              if (res.success) s.markTabSaved(tab.id);

            }).catch(() => {});

          }

          return;

        }

        case 'saveAll':

          s.addNotification({ type: 'info', message: 'All files saved' });

          return;

        case 'closeTab':

          if (s.activeTabId) s.closeTab(s.activeTabId);

          return;

        case 'closeAllTabs':

          s.openTabs.forEach(t => s.closeTab(t.id));

          return;

        case 'find':

        case 'replace':

          // Let Monaco handle these via keyboard events

          return;

        case 'findInFiles':

          s.setActiveActivity('search');

          return;

        case 'commandPalette':

          s.toggleCommandPalette();

          return;

        case 'showExplorer':

          s.setActiveActivity('explorer');

          return;

        case 'showSearch':

          s.setActiveActivity('search');

          return;

        case 'showGit':

          s.setActiveActivity('git');

          return;

        case 'showChat':

          s.toggleChatPanel();

          return;

        case 'toggleSidebar':

          s.toggleSidebar();

          return;

        case 'togglePanel':

          s.togglePanel();

          return;

        case 'toggleChat':

          s.toggleChatPanel();

          return;

        case 'toggleMinimap':

          s.updateSetting('minimapEnabled', !s.settings.minimapEnabled);

          return;

        case 'toggleWordWrap':

          s.updateSetting('wordWrap', s.settings.wordWrap === 'on' ? 'off' : 'on');

          return;

        case 'goToFile':

          s.toggleCommandPalette();

          return;

        case 'newTerminal':

          s.setActivePanelTab('terminal');

          if (!s.panelVisible) s.togglePanel();

          return;

        case 'showWelcome':

          s.openFile({ path: 'welcome', name: 'Welcome', extension: 'welcome', content: '' });

          return;

        case 'showShortcuts':

          s.setActiveActivity('settings');

          return;

        case 'about':

          {

            const v = useAppStore.getState().appVersion || '...';

            s.addNotification({ type: 'info', message: `guIDE ${v} — Local-first AI IDE. Built for offline inference.`, duration: 8000 });

          }

          return;

        default:

          return;

      }

    });

  }, []);



  // Keyboard shortcuts

  useEffect(() => {

    const onKeyDown = (e) => {

      const s = useAppStore.getState();

      // Ctrl+Shift+P — Command Palette

      if (e.ctrlKey && e.shiftKey && e.key === 'P') {

        e.preventDefault();

        s.toggleCommandPalette();

      }

      // Ctrl+B — Toggle Sidebar

      if (e.ctrlKey && e.key === 'b') {

        e.preventDefault();

        s.toggleSidebar();

      }

      // Ctrl+J — Toggle Panel

      if (e.ctrlKey && e.key === 'j') {

        e.preventDefault();

        s.togglePanel();

      }

      // Ctrl+S — Save current file

      if (e.ctrlKey && e.key === 's') {

        e.preventDefault();

        const tab = s.openTabs.find(t => t.id === s.activeTabId);

        if (tab && tab.modified) {

          fetch('/api/files/write', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ filePath: tab.path, content: tab.content }),

          }).then(r => r.json()).then(res => {

            if (res.success) s.markTabSaved(tab.id);

          }).catch(() => {});

        }

      }

      // Ctrl+L — Toggle AI Chat

      if (e.ctrlKey && e.key === 'l') {

        e.preventDefault();

        s.toggleChatPanel();

      }

      // Ctrl+N — New Project

      if (e.ctrlKey && e.key === 'n') {

        e.preventDefault();

        s.setShowNewProjectDialog(true);

      }

      // Ctrl+= / Ctrl++ — Zoom In

      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {

        e.preventDefault();

        s.zoomIn();

      }

      // Ctrl+- — Zoom Out

      if (e.ctrlKey && e.key === '-') {

        e.preventDefault();

        s.zoomOut();

      }

      // Ctrl+0 — Reset Zoom

      if (e.ctrlKey && e.key === '0') {

        e.preventDefault();

        s.zoomReset();

      }

      // Shift+Alt+F — Format Document

      if (e.shiftKey && e.altKey && e.key === 'F') {

        e.preventDefault();

        const tab = s.openTabs.find(t => t.id === s.activeTabId);

        if (tab && tab.content) {

          const ext = tab.path.split('.').pop().toLowerCase();

          fetch('/api/format', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ content: tab.content, language: ext, filePath: tab.path })

          }).then(r => r.json()).then(data => {

            if (data.formatted) s.updateTabContent(tab.id, data.formatted);

          }).catch(() => {});

        }

      }

      // Escape — Close command palette

      if (e.key === 'Escape') {

        if (s.commandPaletteOpen) s.closeCommandPalette();

      }

    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);

  }, []);



  return (

    <ErrorBoundary>

      <ThemeProvider>

        <Layout />

        <WelcomeScreen />

        <FirstRunWizard />

        <WelcomeGuide />

        <NewProjectDialog />

      </ThemeProvider>

    </ErrorBoundary>

  );

}

