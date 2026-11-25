const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const { openInEdge } = require('./edge.cjs');
const { createOverlayManager } = require('./overlay.cjs');
const { createAiSettings } = require('./ai-settings.cjs');
const { createOpenAiService } = require('./openai.cjs');
const { readCapture } = require('./captures.cjs');
const { installRendererLifecycle } = require('./renderer-lifecycle.cjs');
const { attachReport, openReport, readReport } = require('./reports.cjs');

const isDevelopment = process.env.ELECTRON_DEV === '1' && !app.isPackaged;
const developmentUrl = 'http://127.0.0.1:5173';
let mainWindow;
let overlayManager;
let aiSettings;
let aiService;
let aiStartupError;
let quittingAfterCancellation = false;

app.setName('WebPilot');

function openExternalHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      void shell.openExternal(url.href).catch(() => {});
    }
  } catch {
    // Ignore malformed URLs and never hand other protocols to the OS.
  }
}

function trustedSender(event) {
  return mainWindow && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame;
}

ipcMain.on('window:minimize', (event) => {
  if (trustedSender(event)) mainWindow.minimize();
});

ipcMain.handle('window:toggle-maximize', (event) => {
  if (!trustedSender(event)) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});

ipcMain.handle('window:is-maximized', (event) => {
  return trustedSender(event) ? mainWindow.isMaximized() : false;
});

ipcMain.on('window:close', (event) => {
  if (trustedSender(event)) mainWindow.close();
});

ipcMain.handle('browser:open-edge', (event, url) => {
  if (!trustedSender(event)) return { ok: false, error: '허용되지 않은 창의 요청입니다.' };
  return openInEdge(url);
});

ipcMain.handle('overlay:begin', (event, sessionId) => {
  if (!trustedSender(event) || !overlayManager) return { ok: false, error: '허용되지 않은 창의 요청입니다.' };
  return overlayManager.begin(sessionId);
});

ipcMain.handle('overlay:end', (event, sessionId) => {
  if (!trustedSender(event) || !overlayManager) return { ok: false, error: '허용되지 않은 창의 요청입니다.' };
  return overlayManager.end(sessionId);
});

function requireAi(event) {
  if (!trustedSender(event)) throw new Error('허용되지 않은 창의 요청입니다.');
  if (!aiSettings || !aiService) throw new Error(aiStartupError || 'AI 설정을 초기화하지 못했습니다.');
}

ipcMain.handle('ai:get-settings', (event) => {
  requireAi(event);
  return aiSettings.get();
});

ipcMain.handle('ai:save-settings', (event, input) => {
  requireAi(event);
  return aiSettings.save(input);
});

ipcMain.handle('ai:test-connection', (event, input) => {
  requireAi(event);
  return aiService.testConnection(input);
});

ipcMain.handle('ai:start-chat', async (event, input) => {
  try { requireAi(event); } catch (error) { return { ok: false, error: error.message }; }
  return aiService.start(input, (agentEvent) => {
    if (agentEvent.type === 'activity') overlayManager?.updateActivity(agentEvent);
    if (!event.sender.isDestroyed()) event.sender.send('ai:event', { requestId: input.requestId, event: agentEvent });
  });
});

ipcMain.handle('capture:get', (event, id) => {
  if (!trustedSender(event)) return { ok: false, error: '허용되지 않은 창의 요청입니다.' };
  try { return { ok: true, imageUrl: readCapture(id) }; }
  catch { return { ok: false, error: '저장된 화면 캡처를 불러올 수 없습니다.' }; }
});

ipcMain.handle('report:refresh', (event) => {
  if (!trustedSender(event)) return { status: 'error', message: '허용되지 않은 창의 요청입니다.' };
  return attachReport();
});

ipcMain.handle('report:open', (event, id) => {
  if (!trustedSender(event)) return { ok: false, error: '허용되지 않은 창의 요청입니다.' };
  return openReport(id);
});

ipcMain.handle('report:read', (event, id) => {
  if (!trustedSender(event)) return { ok: false, error: '허용되지 않은 창의 요청입니다.' };
  return readReport(id);
});

ipcMain.on('ai:cancel-chat', (event, requestId) => {
  if (trustedSender(event) && typeof requestId === 'string') aiService?.cancel(requestId);
});

function createWindow() {
  if (!aiSettings) {
    try {
      aiSettings = createAiSettings({ directory: app.getPath('userData'), safeStorage });
      aiService = createOpenAiService({ settings: aiSettings, reportProvider: ({ signal } = {}) => attachReport({ signal }) });
      aiStartupError = undefined;
    } catch (error) { aiStartupError = error.message; }
  }
  overlayManager = createOverlayManager(() => mainWindow);
  mainWindow = new BrowserWindow({
    title: 'WebPilot',
    icon: path.join(__dirname, '..', 'public', 'app.ico'),
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternalHttpUrl(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttpUrl(url);
    return { action: 'deny' };
  });

  const publishMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', publishMaximized);
  mainWindow.on('unmaximize', publishMaximized);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  installRendererLifecycle(mainWindow.webContents, {
    cancelAll: () => aiService?.cancelAll(),
    stopEffects: (reason, notify) => overlayManager?.stopAll(reason, notify),
  });
  mainWindow.webContents.on('render-process-gone', () => {
    aiService?.cancelAll();
    overlayManager?.stopAll('renderer-gone');
  });
  mainWindow.webContents.on('destroyed', () => {
    aiService?.cancelAll();
    overlayManager?.stopAll('renderer-destroyed', false);
  });
  let closePending = false;
  mainWindow.on('close', (event) => {
    if (aiService?.hasActive()) {
      event.preventDefault();
      if (closePending) return;
      closePending = true;
      overlayManager?.stopAll('shutdown', false);
      void aiService.cancelAll().finally(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      });
    }
  });
  mainWindow.on('closed', () => {
    overlayManager?.dispose();
    overlayManager = undefined;
    mainWindow = undefined;
  });

  const loading = isDevelopment
    ? mainWindow.loadURL(developmentUrl)
    : mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  void loading.catch((error) => {
    dialog.showErrorBox('WebPilot을 실행할 수 없습니다',
      `화면을 불러오지 못했습니다. ${isDevelopment ? '개발 서버를 확인해 주세요.' : 'npm run build 실행 후 다시 시작해 주세요.'}\n\n${error.message}`);
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('studio.webpilot.desktop');
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(createWindow);
  app.on('before-quit', (event) => {
    if (aiService?.hasActive()) {
      event.preventDefault();
      if (!quittingAfterCancellation) {
        quittingAfterCancellation = true;
        void aiService.cancelAll().finally(() => app.quit());
      }
    }
    overlayManager?.dispose();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
