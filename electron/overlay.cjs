'use strict';

// The legacy IPC name is retained for existing clients. This manager only owns
// stop controls; it never creates a window or displays an effect.
function createOverlayManager(getMainWindow, native = require('electron')) {
  const { globalShortcut, screen } = native;
  const sessions = new Set();
  let registered = false;
  let disposed = false;

  function notifyStopped(reason) {
    const main = getMainWindow();
    if (main && !main.isDestroyed() && !main.webContents.isDestroyed()) {
      main.webContents.send('overlay:stopped', { reason });
    }
  }

  function stopAll(reason, notify = true) {
    const wasActive = sessions.size > 0;
    sessions.clear();
    if (registered) globalShortcut.unregister('Escape');
    registered = false;
    if (wasActive && notify) notifyStopped(reason);
  }

  async function begin(sessionId) {
    if (disposed) return { ok: false, error: '앱이 종료 중입니다.' };
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) {
      return { ok: false, error: '올바른 실행 ID가 필요합니다.' };
    }
    try {
      if (!registered) {
        registered = globalShortcut.register('Escape', () => stopAll('escape'));
        if (!registered) throw new Error('Esc 중지 키를 등록할 수 없습니다. 채팅의 응답 중지 버튼을 사용해 주세요.');
      }
      sessions.add(sessionId);
      return { ok: true };
    } catch (error) {
      stopAll('stop-control-error');
      return { ok: false, error: error.message || '작업 중지 기능을 준비할 수 없습니다.' };
    }
  }

  function end(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: '올바른 실행 ID가 필요합니다.' };
    sessions.delete(sessionId);
    if (!sessions.size) stopAll('complete', false);
    return { ok: true };
  }

  function onDisplayChange() {
    if (sessions.size) stopAll('display-changed');
  }
  const displayEvents = ['display-added', 'display-removed', 'display-metrics-changed'];
  for (const event of displayEvents) screen.on(event, onDisplayChange);

  return {
    begin,
    end,
    stopAll,
    updateActivity() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      stopAll('shutdown', false);
      for (const event of displayEvents) screen.removeListener(event, onDisplayChange);
    },
  };
}

module.exports = { createOverlayManager };
