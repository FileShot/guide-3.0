
'use strict';
module.exports = {
  ipcMain: global.__guideIpcMain,
  app: global.__guideApp,
  BrowserWindow: {
    getAllWindows: () => [global.__guideMainWindow],
    getFocusedWindow: () => global.__guideMainWindow,
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    showMessageBox: async () => ({ response: 0 }),
  },
  shell: {
    openExternal: (url) => { console.log('[Shell] openExternal:', url); },
    openPath: (p) => { console.log('[Shell] openPath:', p); },
  },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  Tray: class { constructor() {} },
  nativeTheme: { shouldUseDarkColors: true, themeSource: 'dark' },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
};
