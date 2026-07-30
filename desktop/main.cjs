/**
 * Electron main process.
 *
 * The renderer is the REAL apps-script UI — Index/Styles/Treemap/Dashboard,
 * assembled unmodified by build-ui.mjs. Dashboard.html talks to its backend
 * through `google.script.run.<method>()`, so the entire port is: implement those
 * five methods against the local filesystem and shim that object in preload.
 *
 * THIS IS NOT A WRAPPER AROUND THE DEPLOYED WEB APP, and that is not a style
 * choice. Google blocks OAuth sign-in inside embedded webviews
 * (`disallowed_useragent`), so pointing a BrowserWindow at the /exec URL fails
 * at the login screen. Shipping the UI and swapping the backend avoids the
 * problem entirely — this build never authenticates with anything.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');

const IS_DEV = !app.isPackaged;
let win = null;

// One scan lives here between scanChunk() calls, because the renderer drives the
// loop and expects to resume with a page token.
let SCAN = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d0d',
    title: 'Disk Storage Explorer',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── the five methods Dashboard.html calls ───────────────────────────────────

ipcMain.handle('pickRoot', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a folder or drive to map',
    properties: ['openDirectory', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

/**
 * Enumerate mounted volumes for the startup picker.
 *
 * Probing drive letters with statfs rather than shelling out: wmic is deprecated
 * and Get-CimInstance costs a PowerShell spawn, while 26 statfs calls are a few
 * milliseconds and cannot fail in a way that takes the app down. The cost is that
 * volume LABELS are unavailable, so the picker shows the letter and the capacity,
 * which is what you actually choose on anyway.
 */
async function listVolumesWin() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(letters.map(async (L) => {
    const root = `${L}:\\`;
    try {
      const st = await fsp.statfs(root);
      const total = st.blocks * st.bsize;
      if (!total) return null;
      return { path: root, total, free: st.bfree * st.bsize };
    } catch { return null; }
  }));
  return found.filter(Boolean);
}

async function listVolumesPosix() {
  const roots = ['/'];
  for (const dir of ['/Volumes', '/media', '/mnt']) {
    try {
      for (const e of await fsp.readdir(dir)) roots.push(path.join(dir, e));
    } catch { /* not present on this platform */ }
  }
  const out = [];
  for (const r of roots) {
    try {
      const st = await fsp.statfs(r);
      const total = st.blocks * st.bsize;
      if (total) out.push({ path: r, total, free: st.bfree * st.bsize });
    } catch { /* skip */ }
  }
  return out;
}

ipcMain.handle('listVolumes', async () =>
  (process.platform === 'win32' ? listVolumesWin() : listVolumesPosix()));

ipcMain.handle('getBootstrap', async (_e, arg) => {
  const roots = Array.isArray(arg) ? arg : (arg ? [arg] : []);
  let total = 0, free = 0;
  /*
    Aggregate by VOLUME, not by chosen root. Two folders picked on the same drive
    share one set of capacity numbers, and counting that drive twice would report
    a machine with double the storage it has. Keyed on the filesystem id where the
    platform gives one, falling back to the Windows drive letter.
  */
  const seen = new Map();
  for (const r of roots) {
    try {
      // statfs is Node 18.15+/20+. Absent on some platforms, and a missing volume
      // figure must not take the whole app down — the treemap is the point.
      const st = await fsp.statfs(r);
      const key = st.fsid !== undefined && st.fsid !== null
        ? String(st.fsid)
        : String(r).slice(0, 3).toUpperCase();
      if (!seen.has(key)) seen.set(key, { total: st.blocks * st.bsize, free: st.bfree * st.bsize });
    } catch { /* leave it out; the UI treats 0 as "no cap published" */ }
  }
  for (const v of seen.values()) { total += v.total; free += v.free; }
  const used = total && free ? total - free : 0;
  return {
    user: !roots.length ? 'Nothing chosen yet'
      : roots.length === 1 ? `${roots[0]} — local volume`
      : `${roots.length} locations`,
    // Same shape as the Drive quota block. There is no trash figure and no
    // Gmail/Photos, so inDrive === usage and inTrash is 0 rather than invented.
    quota: { limit: total, usage: used, inDrive: used, inTrash: 0 },
    drives: [],
    driveCount: 0,
    config: { mappings: [], deadAfterDays: 365, smallFileFloorBytes: 1048576,
              exportFormats: '', agentPollSeconds: 0, updatedAt: null },
    caps: { nasVerify: false, sharedDrives: false },
    isOwner: true,
    rootId: roots[0] || '',
    roots: roots,
    version: require('./package.json').version,
    updated: require('./package.json').buildDate || '',
    now: Date.now(),
    isDesktop: true,
  };
});

ipcMain.handle('scanChunk', async (_e, opts) => {
  // dedupeRoots lives in scan.mjs so it can be unit-tested without Electron.
  const { walk, dedupeRoots } = await import('./scan.mjs');
  const asked = (opts && opts.roots) || (SCAN && SCAN.roots) || [];
  const roots = dedupeRoots(asked);
  if (!roots.length) {
    return { items: [], mimes: [], nextPageToken: null, done: true, pages: 0, elapsedMs: 0, trashedBytes: 0, trashedCount: 0 };
  }

  const sameSet = SCAN && SCAN.roots.length === roots.length && SCAN.roots.every((r, i) => r === roots[i]);
  if (!SCAN || !sameSet || !opts.pageToken) {
    // One shared mime index across every root, so the indices in the tuples stay
    // valid no matter which root a batch came from.
    SCAN = { roots, idx: 0, mimeIndex: { list: [], ix: Object.create(null) }, iter: null };
    SCAN.iter = walk(roots[0], { batchSize: 4000, mimeIndex: SCAN.mimeIndex });
  }

  const started = Date.now();
  let next = await SCAN.iter.next();
  // Roll on to the next root when this one is exhausted. Each root emits its own
  // top-level node with an empty parent, so Dashboard hangs them all off the one
  // synthetic '__root__' and the treemap compares them side by side.
  while (next.done && SCAN.idx + 1 < SCAN.roots.length) {
    SCAN.idx++;
    SCAN.iter = walk(SCAN.roots[SCAN.idx], { batchSize: 4000, mimeIndex: SCAN.mimeIndex });
    next = await SCAN.iter.next();
  }
  if (next.done) {
    return { items: [], mimes: SCAN.mimeIndex.list.slice(), nextPageToken: null, done: true,
             pages: 1, elapsedMs: Date.now() - started, trashedBytes: 0, trashedCount: 0 };
  }
  return {
    items: next.value.items,
    mimes: next.value.mimes,
    // Any truthy token keeps the renderer's loop going; it resumes the generator.
    nextPageToken: 'more',
    done: false,
    pages: 1,
    elapsedMs: Date.now() - started,
    trashedBytes: 0,
    trashedCount: 0,
  };
});

ipcMain.handle('measureDriveChunk', async () => ({
  driveId: '', bytes: 0, files: 0, folders: 0, oldestDays: 0, nextPageToken: null, done: true,
}));

ipcMain.handle('buildManifestCsv', async (_e, rows) => {
  const head = ['path', 'name', 'class', 'mime', 'bytes', 'days_inactive', 'action'];
  const esc = (v) => {
    v = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const out = [head.join(',')];
  for (const r of rows || []) {
    out.push([r.id, r.name, r.cls, r.mime, r.bytes, r.days, r.action].map(esc).join(','));
  }
  return out.join('\n');
});

/**
 * The desktop analogue of Drive's reversible `trashed: true`.
 *
 * shell.trashItem sends to the OS Recycle Bin / Trash, which is recoverable by
 * the user without us. The web app refuses to hard-delete on principle; there is
 * no reason to be less careful on a local disk, so there is deliberately no
 * fs.unlink path anywhere in this app.
 */
ipcMain.handle('trashFiles', async (_e, ids) => {
  const trashed = [], failed = [];
  for (const p of ids || []) {
    try { await shell.trashItem(p); trashed.push(p); }
    catch (err) { failed.push({ id: p, error: err.message }); }
  }
  return { trashed, failed, skipped: [], gated: false };
});

ipcMain.handle('revealItem', async (_e, p) => {
  try { shell.showItemInFolder(p); return true; } catch { return false; }
});
