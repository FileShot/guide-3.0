import useAppStore from '../stores/appStore';
import { isPreviewable } from '../components/EditorPreviews';

/** Open a file from GET /api/files/read JSON (text or binary image). */
export function openFileFromReadResponse(f) {
  if (!f || f.missing) return;
  const { openFile, setPreviewMode } = useAppStore.getState();
  if (f.binary && f.dataUrl) {
    openFile({
      path: f.path,
      name: f.name,
      extension: f.extension,
      content: '',
      dataUrl: f.dataUrl,
      isBinary: true,
    });
  } else if (f.content !== undefined) {
    openFile({
      path: f.path,
      name: f.name,
      extension: f.extension,
      content: f.content,
    });
  } else {
    return;
  }
  const tab = useAppStore.getState().openTabs.find((t) => t.path === f.path);
  if (tab && isPreviewable(f.path)) {
    setPreviewMode(tab.id, true);
  }
}
