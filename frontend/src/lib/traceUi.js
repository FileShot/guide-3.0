/**
 * Renderer-side diagnostic trace — routed to ui-trace.log via electron-main ui-log handler.
 */
export function traceUi(evt, fields = {}) {
  try {
    const payload = { evt, ts: new Date().toISOString(), ...fields };
    window.electronAPI?.uiLog?.(`[TraceUI] ${JSON.stringify(payload)}`);
  } catch (_) {}
}
