/**
 * FirstRunWizard — GPU/RAM detection and recommended settings on first launch.
 * Wired to /api/setup/status and /api/setup/complete (firstRunSetup.js).
 */
import { useState, useEffect } from 'react';
import useAppStore from '../stores/appStore';
import { Cpu, Monitor, HardDrive, Check, Sparkles } from 'lucide-react';

export default function FirstRunWizard() {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [systemInfo, setSystemInfo] = useState(null);
  const [recommended, setRecommended] = useState(null);
  const [completing, setCompleting] = useState(false);
  const addNotification = useAppStore(s => s.addNotification);
  const updateSetting = useAppStore(s => s.updateSetting);

  useEffect(() => {
    fetch('/api/setup/status')
      .then(r => r.json())
      .then(d => {
        if (d.isFirstRun) {
          setSystemInfo(d.systemInfo);
          setRecommended(d.recommended);
          setVisible(true);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading || !visible) return null;

  const complete = async (applyRecommended) => {
    setCompleting(true);
    try {
      const r = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applyRecommended: !!applyRecommended }),
      });
      const d = await r.json();
      if (d.success) {
        if (applyRecommended && recommended) {
          if (recommended.gpuLayers != null) updateSetting('gpuLayers', recommended.gpuLayers);
          if (recommended.contextSize != null) updateSetting('contextSize', recommended.contextSize);
        }
        setVisible(false);
        addNotification({ type: 'info', message: 'Setup complete — welcome to guIDE!' });
      }
    } catch (e) {
      addNotification({ type: 'error', message: e.message });
    } finally {
      setCompleting(false);
    }
  };

  const vramGB = systemInfo?.vramMB ? (systemInfo.vramMB / 1024).toFixed(1) : '0';

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 bg-vsc-sidebar rounded-2xl border border-vsc-panel-border/30 shadow-2xl overflow-hidden">
        <div className="px-6 py-5 border-b border-vsc-panel-border/20">
          <div className="flex items-center gap-2 text-vsc-accent mb-1">
            <Sparkles size={18} />
            <span className="text-[11px] font-semibold tracking-wider uppercase">First-time setup</span>
          </div>
          <h2 className="text-lg font-semibold text-vsc-text">Configure guIDE for your machine</h2>
          <p className="text-vsc-sm text-vsc-text-dim mt-1">Local AI runs on your hardware — we detected your system below.</p>
        </div>

        <div className="px-6 py-4 space-y-3 text-vsc-sm">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-vsc-bg/50 border border-vsc-panel-border/15">
            <Monitor size={16} className="text-vsc-accent mt-0.5 shrink-0" />
            <div>
              <div className="font-medium text-vsc-text">GPU</div>
              <div className="text-vsc-text-dim">{systemInfo?.gpu || 'Unknown'} {systemInfo?.vramMB > 0 && `(${vramGB} GB VRAM)`}</div>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-vsc-bg/50 border border-vsc-panel-border/15">
            <HardDrive size={16} className="text-vsc-accent mt-0.5 shrink-0" />
            <div>
              <div className="font-medium text-vsc-text">Memory</div>
              <div className="text-vsc-text-dim">{systemInfo?.ramGB || '?'} GB RAM · {systemInfo?.os || ''}</div>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-vsc-bg/50 border border-vsc-panel-border/15">
            <Cpu size={16} className="text-vsc-accent mt-0.5 shrink-0" />
            <div>
              <div className="font-medium text-vsc-text">CPU</div>
              <div className="text-vsc-text-dim text-[12px]">{systemInfo?.cpuCores || '?'} cores · {systemInfo?.cpuModel || ''}</div>
            </div>
          </div>
          {recommended?.recommendation && (
            <p className="text-[12px] text-vsc-text-dim leading-relaxed px-1">{recommended.recommendation}</p>
          )}
        </div>

        <div className="px-6 py-4 flex flex-col sm:flex-row gap-2 border-t border-vsc-panel-border/20">
          <button
            className="btn btn-primary flex-1 flex items-center justify-center gap-2"
            disabled={completing}
            onClick={() => complete(true)}
          >
            <Check size={14} />
            Use recommended settings
          </button>
          <button
            className="btn flex-1"
            disabled={completing}
            onClick={() => complete(false)}
          >
            Skip — I'll configure manually
          </button>
        </div>
      </div>
    </div>
  );
}
