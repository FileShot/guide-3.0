/**
 * guIDE 2.0 — Application Menu (Electron native menu)
 *
 * Mirrors the custom TitleBar.jsx menus. Shows on Alt key press
 * (autoHideMenuBar = true). Sends 'menu-action' IPC to renderer
 * which dispatches to the same executeMenuAction handler.
 */
'use strict';

const { Menu, shell } = require('electron');

/**
 * Build and set the application menu.
 * @param {BrowserWindow} mainWindow
 */
function buildAppMenu(mainWindow) {
  const send = (action) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('menu-action', action);
    }
  };

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New File', accelerator: 'CmdOrCtrl+N', click: () => send('newFile') },
        { label: 'Open Folder...', accelerator: 'CmdOrCtrl+K CmdOrCtrl+O', click: () => send('openFolder') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save All', accelerator: 'CmdOrCtrl+K S', click: () => send('saveAll') },
        { type: 'separator' },
        { label: 'Close Editor', accelerator: 'CmdOrCtrl+W', click: () => send('closeTab') },
        { label: 'Close All Editors', click: () => send('closeAllTabs') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        { label: 'Replace', accelerator: 'CmdOrCtrl+H', click: () => send('replace') },
        { label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('findInFiles') },
      ],
    },
    {
      label: 'Selection',
      submenu: [
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette...', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('commandPalette') },
        { type: 'separator' },
        { label: 'Explorer', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('showExplorer') },
        { label: 'Search', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('findInFiles') },
        { label: 'Source Control', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('showGit') },
        { label: 'AI Chat', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('showChat') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('toggleSidebar') },
        { label: 'Toggle Panel', accelerator: 'CmdOrCtrl+J', click: () => send('togglePanel') },
        { label: 'Toggle Chat Panel', click: () => send('toggleChat') },
        { type: 'separator' },
        { label: 'Toggle Minimap', click: () => send('toggleMinimap') },
        { label: 'Toggle Word Wrap', click: () => send('toggleWordWrap') },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Go to File...', accelerator: 'CmdOrCtrl+P', click: () => send('goToFile') },
        { label: 'Go to Line...', accelerator: 'CmdOrCtrl+G', click: () => send('goToLine') },
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        { label: 'New Terminal', accelerator: 'Ctrl+`', click: () => send('newTerminal') },
        { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+J', click: () => send('togglePanel') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Welcome', click: () => send('showWelcome') },
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+K CmdOrCtrl+S', click: () => send('showShortcuts') },
        { type: 'separator' },
        {
          label: 'guIDE on GitHub',
          click: () => shell.openExternal('https://github.com/graysoft-dev/guide-ide'),
        },
        { type: 'separator' },
        { label: 'About guIDE', click: () => send('about') },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

module.exports = { buildAppMenu };
