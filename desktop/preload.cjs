/**
 * The whole port lives here.
 *
 * Dashboard.html calls its backend as:
 *
 *   google.script.run.withSuccessHandler(fn).withFailureHandler(fn).method(args)
 *
 * so exposing an object of that exact shape, backed by IPC instead of by Apps
 * Script, lets the real UI run untouched. This is the same trick
 * tools/build_preview.mjs already uses to drive the UI from synthetic data —
 * that mock proved the contract was small enough to reimplement long before
 * anyone tried it against a filesystem.
 *
 * Chained builders are IMMUTABLE. Apps Script's are, Dashboard.html reuses a
 * partially-built runner in more than one place, and a mutable version would
 * leak the previous call's success handler into the next one.
 */
const { contextBridge, ipcRenderer } = require('electron');

const METHODS = ['getBootstrap', 'scanChunk', 'measureDriveChunk', 'buildManifestCsv', 'trashFiles'];

// The renderer picks a folder before scanning; remembered here so scanChunk does
// not need Dashboard.html to learn a new argument.
let ROOT = null;

function makeRunner(onOk, onErr) {
  const runner = {
    withSuccessHandler: (fn) => makeRunner(fn, onErr),
    withFailureHandler: (fn) => makeRunner(onOk, fn),
  };
  for (const name of METHODS) {
    runner[name] = (...args) => {
      const payload = name === 'scanChunk'
        ? Object.assign({ root: ROOT }, args[0] || {})
        : (name === 'getBootstrap' ? ROOT : args[0]);
      ipcRenderer.invoke(name, payload)
        .then((res) => { if (onOk) onOk(res); })
        .catch((err) => {
          if (onErr) onErr(err instanceof Error ? err : new Error(String(err)));
          else throw err;
        });
    };
  }
  return runner;
}

contextBridge.exposeInMainWorld('google', { script: { run: makeRunner(null, null) } });

/* Desktop-only extras. Kept off the `google` object on purpose: anything under
   that name is pretending to be the Apps Script API, and these are not part of
   it. Dashboard.html feature-detects `window.desktop` so one codebase serves
   both targets. */
contextBridge.exposeInMainWorld('desktop', {
  pickRoot: async () => { ROOT = await ipcRenderer.invoke('pickRoot'); return ROOT; },
  getRoot: () => ROOT,
  reveal: (p) => ipcRenderer.invoke('revealItem', p),
});
