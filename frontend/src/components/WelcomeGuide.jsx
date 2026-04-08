import { useState } from 'react';
import useAppStore from '../stores/appStore';
import {
  X, Rocket, Keyboard, Brain, Code2, Wrench, Lightbulb,
  FolderOpen, MessageSquare, Settings, Download, Cpu,
  Zap, FileCode, GitBranch, Terminal, Search, Command,
  Palette, Eye, Split, Bug, Globe, Mic, Paperclip, Star,
} from 'lucide-react';

const SECTIONS = [
  {
    id: 'getting-started',
    label: 'Getting Started',
    icon: Rocket,
    content: GettingStarted,
  },
  {
    id: 'shortcuts',
    label: 'Keyboard Shortcuts',
    icon: Keyboard,
    content: Shortcuts,
  },
  {
    id: 'ai-chat',
    label: 'AI & Chat',
    icon: Brain,
    content: AiChat,
  },
  {
    id: 'editor',
    label: 'Editor & Code',
    icon: Code2,
    content: EditorCode,
  },
  {
    id: 'tools',
    label: 'Built-in Tools',
    icon: Wrench,
    content: BuiltInTools,
  },
  {
    id: 'tips',
    label: 'Tips & Tricks',
    icon: Lightbulb,
    content: TipsAndTricks,
  },
];

export default function WelcomeGuide() {
  const showWelcomeGuide = useAppStore(s => s.showWelcomeGuide);
  const setShowWelcomeGuide = useAppStore(s => s.setShowWelcomeGuide);
  const dismissWelcomeGuideForever = useAppStore(s => s.dismissWelcomeGuideForever);

  const [activeSection, setActiveSection] = useState('getting-started');
  const [dontShowAgain, setDontShowAgain] = useState(false);

  if (!showWelcomeGuide) return null;

  const handleClose = () => {
    if (dontShowAgain) {
      dismissWelcomeGuideForever();
    } else {
      setShowWelcomeGuide(false);
    }
  };

  const ActiveContent = SECTIONS.find(s => s.id === activeSection)?.content || GettingStarted;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[720px] max-w-[90vw] h-[520px] max-h-[80vh] bg-vsc-sidebar rounded-xl border border-vsc-panel-border shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-vsc-panel-border/50">
          <h2 className="text-[15px] font-semibold text-vsc-text">Welcome to guIDE</h2>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-vsc-list-hover rounded-md transition-colors text-vsc-text-dim hover:text-vsc-text"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <div className="w-[200px] flex-shrink-0 border-r border-vsc-panel-border/50 py-2">
            {SECTIONS.map(section => {
              const Icon = section.icon;
              const isActive = section.id === activeSection;
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2 text-[13px] text-left transition-colors ${
                    isActive
                      ? 'bg-vsc-list-active text-vsc-text font-medium'
                      : 'text-vsc-text-dim hover:bg-vsc-list-hover hover:text-vsc-text'
                  }`}
                >
                  <Icon size={15} className={isActive ? 'text-vsc-accent' : ''} />
                  {section.label}
                </button>
              );
            })}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-5 scrollbar-thin">
            <ActiveContent />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-vsc-panel-border/50">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-vsc-panel-border accent-vsc-accent"
            />
            <span className="text-vsc-xs text-vsc-text-dim">Don't show this on startup</span>
          </label>
          <button
            onClick={handleClose}
            className="px-4 py-1.5 text-vsc-xs font-medium rounded-md bg-vsc-accent text-vsc-bg hover:bg-vsc-accent-hover transition-colors"
          >
            Get Started
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Section content components ─────────────────────────────────────────────── */

function SectionTitle({ children }) {
  return <h3 className="text-[14px] font-semibold text-vsc-text mb-3">{children}</h3>;
}

function Paragraph({ children }) {
  return <p className="text-vsc-sm text-vsc-text-dim leading-relaxed mb-3">{children}</p>;
}

function ShortcutTable({ shortcuts }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-vsc-xs">
      {shortcuts.map(([key, desc]) => (
        <div key={key} className="contents">
          <kbd className="bg-vsc-badge px-2 py-0.5 rounded text-[11px] font-mono text-vsc-text-bright text-center whitespace-nowrap">
            {key}
          </kbd>
          <span className="text-vsc-text self-center">{desc}</span>
        </div>
      ))}
    </div>
  );
}

function FeatureItem({ icon: Icon, title, children }) {
  return (
    <div className="flex gap-3 mb-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-md bg-vsc-accent/10 flex items-center justify-center mt-0.5">
        <Icon size={14} className="text-vsc-accent" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-vsc-text mb-0.5">{title}</div>
        <div className="text-vsc-xs text-vsc-text-dim leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

function GettingStarted() {
  return (
    <>
      <SectionTitle>Getting Started</SectionTitle>
      <Paragraph>
        guIDE is a local-first AI IDE. All AI inference runs on your machine — no cloud
        required, no data leaves your computer.
      </Paragraph>

      <FeatureItem icon={FolderOpen} title="Open a Project">
        Click "Open Folder" on the welcome screen or use <strong>Ctrl+O</strong> to open an existing project folder.
      </FeatureItem>

      <FeatureItem icon={Download} title="Set Up a Model">
        Go to Settings (gear icon in the activity bar) to download or select a local AI model.
        Models are .gguf files that run via llama.cpp on your GPU.
      </FeatureItem>

      <FeatureItem icon={MessageSquare} title="Start Chatting">
        Open the AI Chat panel with <strong>Ctrl+L</strong> and ask guIDE to help you code.
        It can read your files, write code, run terminal commands, and more.
      </FeatureItem>

      <FeatureItem icon={Cpu} title="Cloud or Local">
        Use local models for privacy, or connect a cloud API key for larger models.
        Switch between them anytime in the model picker at the bottom of the chat.
      </FeatureItem>
    </>
  );
}

function Shortcuts() {
  return (
    <>
      <SectionTitle>Keyboard Shortcuts</SectionTitle>
      <Paragraph>Essential shortcuts to navigate guIDE efficiently.</Paragraph>

      <div className="mb-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-vsc-text-dim mb-2">General</div>
        <ShortcutTable shortcuts={[
          ['Ctrl+Shift+P', 'Command Palette'],
          ['Ctrl+P', 'Quick Open File'],
          ['Ctrl+B', 'Toggle Sidebar'],
          ['Ctrl+J', 'Toggle Bottom Panel'],
          ['Ctrl+S', 'Save File'],
          ['Ctrl+Z', 'Undo'],
          ['Ctrl+Shift+Z', 'Redo'],
        ]} />
      </div>

      <div className="mb-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-vsc-text-dim mb-2">AI & Chat</div>
        <ShortcutTable shortcuts={[
          ['Ctrl+L', 'Toggle AI Chat Panel'],
          ['Ctrl+I', 'Inline Chat (in editor)'],
          ['Enter', 'Send message'],
          ['Shift+Enter', 'New line in chat input'],
        ]} />
      </div>

      <div>
        <div className="text-[11px] font-medium uppercase tracking-wider text-vsc-text-dim mb-2">Editor</div>
        <ShortcutTable shortcuts={[
          ['Ctrl+/', 'Toggle Line Comment'],
          ['Ctrl+D', 'Select Next Occurrence'],
          ['Ctrl+F', 'Find in File'],
          ['Ctrl+H', 'Find and Replace'],
          ['Ctrl+G', 'Go to Line'],
          ['Alt+Up/Down', 'Move Line Up/Down'],
          ['Ctrl+Shift+K', 'Delete Line'],
        ]} />
      </div>
    </>
  );
}

function AiChat() {
  return (
    <>
      <SectionTitle>AI & Chat</SectionTitle>
      <Paragraph>
        guIDE's AI assistant can read your code, write files, search your project,
        run terminal commands, and manage git — all from the chat panel.
      </Paragraph>

      <FeatureItem icon={Zap} title="Auto Mode">
        When enabled, guIDE automatically executes tool calls (file writes, terminal commands)
        without asking for confirmation. Toggle it in the chat toolbar.
      </FeatureItem>

      <FeatureItem icon={FileCode} title="Context Awareness">
        The active file and any selected code are automatically included as context.
        You can also attach files and images with the paperclip button.
      </FeatureItem>

      <FeatureItem icon={Paperclip} title="Attachments">
        Drag and drop files or images onto the chat input, or click the paperclip icon.
        Images are sent as vision input when using a vision-capable model.
      </FeatureItem>

      <FeatureItem icon={Mic} title="Voice Input">
        Click the microphone button to dictate your message using speech-to-text.
      </FeatureItem>

      <FeatureItem icon={Star} title="Model Picker">
        Click the model name in the chat toolbar to switch between local models
        and cloud providers. Star your favorites for quick access.
      </FeatureItem>
    </>
  );
}

function EditorCode() {
  return (
    <>
      <SectionTitle>Editor & Code</SectionTitle>
      <Paragraph>
        guIDE includes a full code editor with syntax highlighting, multiple tabs,
        and preview support for HTML, Markdown, JSON, CSV, SVG, and images.
      </Paragraph>

      <FeatureItem icon={Eye} title="Live Previews">
        HTML files get a live preview with auto-refresh. Markdown renders in real time.
        JSON gets a collapsible tree view. CSV becomes a sortable table.
      </FeatureItem>

      <FeatureItem icon={Split} title="Multi-tab Editing">
        Open multiple files side by side. Tabs show file icons, unsaved indicators,
        and can be closed individually or all at once.
      </FeatureItem>

      <FeatureItem icon={Palette} title="Syntax Highlighting">
        Powered by CodeMirror, supporting 20+ languages out of the box with bracket matching,
        auto-indent, and configurable tab size.
      </FeatureItem>

      <FeatureItem icon={Settings} title="Editor Settings">
        Customize font size, font family, tab size, word wrap, line numbers, bracket pair colorization,
        and more in the Settings panel.
      </FeatureItem>
    </>
  );
}

function BuiltInTools() {
  return (
    <>
      <SectionTitle>Built-in Tools</SectionTitle>
      <Paragraph>
        guIDE's AI has access to powerful tools that let it work autonomously on your codebase.
      </Paragraph>

      <FeatureItem icon={FileCode} title="File Operations">
        read_file, write_file, list_directory, search_files — the AI can navigate and modify
        your entire project structure.
      </FeatureItem>

      <FeatureItem icon={Terminal} title="Terminal Commands">
        execute_command runs shell commands with real-time output streaming. The AI can install
        packages, run builds, start servers, and debug errors.
      </FeatureItem>

      <FeatureItem icon={Search} title="Code Search">
        search_files with regex patterns finds code across your entire project.
        The AI uses this to understand your codebase before making changes.
      </FeatureItem>

      <FeatureItem icon={GitBranch} title="Git Operations">
        Stage, commit, diff, branch, and checkout — all available as tools.
        The AI can manage your version control workflow.
      </FeatureItem>

      <FeatureItem icon={Globe} title="Web Browsing">
        fetch_url retrieves web content for documentation lookups, API references,
        and researching solutions to coding problems.
      </FeatureItem>

      <FeatureItem icon={Bug} title="Diagnostics">
        The AI reads compiler errors, linter warnings, and test output to diagnose
        and fix issues in your code.
      </FeatureItem>
    </>
  );
}

function TipsAndTricks() {
  return (
    <>
      <SectionTitle>Tips & Tricks</SectionTitle>

      <FeatureItem icon={Command} title="Command Palette">
        Press <strong>Ctrl+Shift+P</strong> to access every command in guIDE.
        Start typing to filter — it's the fastest way to do anything.
      </FeatureItem>

      <FeatureItem icon={Cpu} title="GPU Memory">
        The status bar shows GPU VRAM usage. Choose a model size that fits your GPU —
        quantized models (Q4_K_M, Q8_0) use less memory with minimal quality loss.
      </FeatureItem>

      <FeatureItem icon={Zap} title="Speed vs Quality">
        Smaller models (2B-4B) respond faster. Larger models (9B+) are more capable.
        Use small models for quick edits and large models for complex reasoning.
      </FeatureItem>

      <FeatureItem icon={Star} title="Default Model">
        Star a model on the welcome screen to auto-load it on startup.
        This saves time when you always use the same model.
      </FeatureItem>

      <FeatureItem icon={Brain} title="Thinking Budget">
        In Settings, adjust the thinking budget to control how long the model reasons
        before responding. Higher budgets improve quality for complex tasks.
      </FeatureItem>

      <FeatureItem icon={Search} title="Project-wide Search">
        Use <strong>Ctrl+Shift+F</strong> to search across all files in your project.
        Supports plain text and regular expressions.
      </FeatureItem>
    </>
  );
}
