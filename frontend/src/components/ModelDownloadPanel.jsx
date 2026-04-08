/**
 * ModelDownloadPanel — Search HuggingFace for GGUF models and download them.
 * Shows search results, file picker (quantization variants), and download progress.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import useAppStore from '../stores/appStore';
import {
  Search, Download, X, Loader2, ChevronRight, ChevronDown,
  HardDrive, Users, Heart, ArrowLeft, Package
} from 'lucide-react';

export default function ModelDownloadPanel({ onBack }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [repoFiles, setRepoFiles] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [error, setError] = useState('');
  const searchTimeout = useRef(null);
  const addNotification = useAppStore(s => s.addNotification);
  const downloads = useAppStore(s => s.modelDownloads);

  const doSearch = useCallback(async (q) => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    setError('');
    try {
      const res = await fetch(`/api/models/hf/search?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResults(data.models || []);
    } catch (e) {
      setError(e.message);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleSearchInput = (value) => {
    setQuery(value);
    clearTimeout(searchTimeout.current);
    if (value.trim().length >= 2) {
      searchTimeout.current = setTimeout(() => doSearch(value), 500);
    } else {
      setResults([]);
    }
  };

  const selectRepo = async (model) => {
    setSelectedRepo(model);
    setLoadingFiles(true);
    setRepoFiles([]);
    try {
      const res = await fetch(`/api/models/hf/files/${encodeURIComponent(model.id)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setRepoFiles(data.files || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingFiles(false);
    }
  };

  const startDownload = async (file) => {
    try {
      const res = await fetch('/api/models/hf/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: file.downloadUrl, fileName: file.name }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Download failed');
    } catch (e) {
      addNotification({ type: 'error', message: e.message });
    }
  };

  const cancelDownload = async (id) => {
    try {
      await fetch('/api/models/hf/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch {}
  };

  const activeDownloads = Object.values(downloads).filter(d => d.status === 'downloading');

  // ── Repo file picker view ──
  if (selectedRepo) {
    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center gap-2 p-3 border-b border-vsc-panel-border">
          <button
            onClick={() => { setSelectedRepo(null); setRepoFiles([]); }}
            className="p-1 rounded hover:bg-vsc-sidebar transition-colors text-vsc-foreground/60"
          >
            <ArrowLeft size={14} />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-medium text-vsc-foreground truncate">{selectedRepo.name}</p>
            <p className="text-[10px] text-vsc-foreground/50 truncate">{selectedRepo.author}</p>
          </div>
        </div>

        {/* Files list */}
        <div className="flex-1 overflow-y-auto p-2">
          {loadingFiles ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-vsc-foreground/40" />
            </div>
          ) : repoFiles.length === 0 ? (
            <p className="text-[11px] text-vsc-foreground/50 text-center py-8">No GGUF files found in this repository</p>
          ) : (
            <div className="space-y-1.5">
              {repoFiles.map(file => {
                const isDownloading = Object.values(downloads).some(d => d.fileName === file.name && d.status === 'downloading');
                const isComplete = Object.values(downloads).some(d => d.fileName === file.name && d.status === 'complete');

                return (
                  <div
                    key={file.name}
                    className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-vsc-panel-border bg-vsc-sidebar"
                  >
                    <HardDrive size={13} className="text-vsc-foreground/40 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-vsc-foreground truncate" title={file.name}>{file.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-vsc-accent/20 text-vsc-accent font-mono">
                          {file.quantization}
                        </span>
                        <span className="text-[10px] text-vsc-foreground/40">{file.sizeFormatted}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => startDownload(file)}
                      disabled={isDownloading || isComplete}
                      className={`flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-medium rounded transition-colors ${
                        isComplete
                          ? 'bg-green-600/80 text-white cursor-default'
                          : isDownloading
                          ? 'bg-vsc-accent/50 text-white cursor-wait'
                          : 'bg-vsc-accent text-white hover:bg-vsc-accent-hover'
                      }`}
                    >
                      {isComplete ? 'Done' : isDownloading ? (
                        <><Loader2 size={10} className="animate-spin" /> ...</>
                      ) : (
                        <><Download size={10} /> Get</>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Active downloads */}
        {activeDownloads.length > 0 && (
          <div className="border-t border-vsc-panel-border p-2 space-y-1.5">
            <p className="text-[10px] font-medium text-vsc-foreground/60 uppercase tracking-wider px-1">Downloads</p>
            {activeDownloads.map(dl => (
              <DownloadProgressBar key={dl.id} dl={dl} onCancel={() => cancelDownload(dl.id)} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Main search view ──
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-vsc-panel-border">
        <div className="flex items-center gap-2 mb-2">
          {onBack && (
            <button onClick={onBack} className="p-1 rounded hover:bg-vsc-sidebar transition-colors text-vsc-foreground/60">
              <ArrowLeft size={14} />
            </button>
          )}
          <Package size={16} className="text-vsc-foreground/60" />
          <span className="text-[12px] font-medium text-vsc-foreground">Download Models</span>
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-vsc-foreground/40" />
          <input
            type="text"
            value={query}
            onChange={e => handleSearchInput(e.target.value)}
            placeholder="Search HuggingFace for GGUF models..."
            className="w-full pl-8 pr-3 py-2 rounded text-[11px] bg-vsc-sidebar border border-vsc-panel-border text-vsc-foreground outline-none focus:border-vsc-accent transition-colors"
            spellCheck={false}
            autoFocus
          />
          {searching && <Loader2 size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-vsc-foreground/40" />}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-3 mt-2 px-3 py-2 rounded text-[10px] text-[#f44747] bg-[#f44747]/10">
          {error}
        </div>
      )}

      {/* Results */}
      <div className="flex-1 overflow-y-auto p-2">
        {results.length === 0 && !searching && query.length >= 2 && (
          <p className="text-[11px] text-vsc-foreground/50 text-center py-8">No models found</p>
        )}

        {results.length === 0 && !searching && query.length < 2 && (
          <div className="text-center py-8">
            <Download size={28} className="text-vsc-foreground/20 mx-auto mb-3" />
            <p className="text-[11px] text-vsc-foreground/50">Search for GGUF models to download</p>
            <p className="text-[10px] text-vsc-foreground/30 mt-1">Try: qwen, llama, mistral, phi, gemma, deepseek</p>
          </div>
        )}

        <div className="space-y-1">
          {results.map(model => (
            <button
              key={model.id}
              onClick={() => selectRepo(model)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-vsc-panel-border hover:border-vsc-accent/50 bg-vsc-sidebar transition-colors text-left"
            >
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-vsc-foreground font-medium truncate">{model.name}</p>
                <p className="text-[10px] text-vsc-foreground/40 truncate">{model.author}</p>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0 text-[10px] text-vsc-foreground/40">
                <span className="flex items-center gap-0.5" title="Downloads">
                  <Download size={9} />{_formatCount(model.downloads)}
                </span>
                <span className="flex items-center gap-0.5" title="Likes">
                  <Heart size={9} />{_formatCount(model.likes)}
                </span>
              </div>
              <ChevronRight size={12} className="text-vsc-foreground/30 flex-shrink-0" />
            </button>
          ))}
        </div>
      </div>

      {/* Active downloads bar */}
      {activeDownloads.length > 0 && (
        <div className="border-t border-vsc-panel-border p-2 space-y-1.5">
          <p className="text-[10px] font-medium text-vsc-foreground/60 uppercase tracking-wider px-1">
            Downloading ({activeDownloads.length})
          </p>
          {activeDownloads.map(dl => (
            <DownloadProgressBar key={dl.id} dl={dl} onCancel={() => cancelDownload(dl.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function DownloadProgressBar({ dl, onCancel }) {
  return (
    <div className="px-2 py-1.5 rounded bg-vsc-sidebar border border-vsc-panel-border">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-vsc-foreground truncate flex-1 mr-2">{dl.fileName}</span>
        <button onClick={onCancel} className="text-vsc-foreground/40 hover:text-[#f44747] transition-colors">
          <X size={10} />
        </button>
      </div>
      <div className="w-full h-1.5 rounded-full bg-vsc-panel-border overflow-hidden">
        <div
          className="h-full rounded-full bg-vsc-accent transition-all duration-300"
          style={{ width: `${dl.percent || 0}%` }}
        />
      </div>
      <div className="flex justify-between mt-0.5 text-[9px] text-vsc-foreground/40">
        <span>{dl.percent || 0}%</span>
        <span>{dl.speed || ''} {dl.eta ? `- ${dl.eta}` : ''}</span>
      </div>
    </div>
  );
}

function _formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
