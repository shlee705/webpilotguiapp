'use strict';

/** Stop work owned by the outgoing renderer even when a reload keeps WebContents alive. */
function installRendererLifecycle(webContents, { cancelAll, stopEffects }) {
  const safely = callback => {
    try { void Promise.resolve(callback()).catch(() => {}); }
    catch { /* A closing renderer must not prevent the remaining cleanup. */ }
  };
  const onNavigation = (event, detailsOrUrl, legacySameDocument, legacyMainFrame) => {
    const details = event && typeof event.isMainFrame === 'boolean'
      ? event
      : detailsOrUrl && typeof detailsOrUrl === 'object'
        ? detailsOrUrl
        : { isMainFrame: legacyMainFrame, isSameDocument: legacySameDocument };
    const sameDocument = details.isSameDocument ?? details.isInPlace ?? false;
    if (details.isMainFrame !== true || sameDocument) return;
    safely(cancelAll);
    safely(() => stopEffects('renderer-navigation', false));
  };
  webContents.on('did-start-navigation', onNavigation);
  return () => webContents.removeListener('did-start-navigation', onNavigation);
}

module.exports = { installRendererLifecycle };
