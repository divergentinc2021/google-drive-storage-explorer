/**
 * Assemble desktop/ui/index.html from the REAL apps-script sources.
 *
 * Same principle as tools/build_preview.mjs: resolve the <?!= include('X') ?>
 * tags exactly the way HtmlService does, so the desktop build ships the same
 * bytes as the web app rather than a fork that drifts. Every treemap fix made
 * for the web app lands here for free on the next build.
 *
 * Usage: node desktop/build-ui.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'apps-script');
const read = (f) => readFileSync(join(SRC, f), 'utf8');

function resolve(html, depth = 0) {
  if (depth > 6) return html;
  return html.replace(/<\?!=\s*include\(['"]([^'"]+)['"]\);?\s*\?>/g,
    (_, name) => resolve(read(`${name}.html`), depth + 1));
}

const body = resolve(read('Index.html'));

/*
  Desktop shim, injected AFTER the app's own scripts so it can override them.

  Three things differ from the web app and all three are UI-level, which is why
  they are patched here rather than forked into Dashboard.html:

    1. There is no Drive to scan until a folder is chosen, so Scan asks first.
    2. "Open in Drive" has no meaning; it becomes "reveal in the file manager".
    3. Shared drives and the NAS config do not exist on a local disk.
*/
const SHIM = `
<script>
/* No IIFE, same house rule as the rest of the project. */
var DESKTOP = !!window.desktop;

if (DESKTOP) {
  document.title = 'Disk Storage Explorer';

  /*
    Rewrite the wordmark. Index.html renders

      <h1>Google Drive <span class="thin">Storage Explorer</span> …</h1>

    so the desktop window would otherwise announce itself as the Google Drive app
    while pointed at an SD card. Only the leading TEXT NODE is replaced — the
    .thin span and the version pill are left alone, so "Disk" + "Storage Explorer"
    falls out of the existing markup rather than needing it rebuilt.
  */
  var pvH1 = document.querySelector('h1');
  if (pvH1 && pvH1.firstChild && pvH1.firstChild.nodeType === 3) {
    pvH1.firstChild.nodeValue = 'Disk ';
  }
  var pvFoot = document.querySelector('.foot');
  if (pvFoot) {
    pvFoot.innerHTML = 'Created by UWC Immersive Zone · sizes come from the ' +
      'filesystem, and activity from each file\\'s last-modified time.';
  }

  /*
    DESKTOP LAYOUT. The web app is centred at max-width 1560 because it is a page
    among other pages; an application window is not, and on a wide monitor that
    left two enormous empty margins around the one element people came to look at.
    The canvas also had a fixed 600px height, so a maximised window just added
    whitespace below it instead of a bigger map.
  */
  var pvLayout = document.createElement('style');
  pvLayout.textContent = [
    /* The window IS the app. Web pages scroll; desktop tools do not. */
    'html, body { height: 100%; overflow: hidden; }',
    '.viz-root { max-width: none !important; height: 100vh; padding: 0 !important;',
    '  display: flex; flex-direction: column; }',
    '.topbar { margin: 0 !important; padding: 10px 16px; border-bottom: 1px solid var(--border); }',

    /* One slim strip replaces the quota panel and the six stat tiles: the same
       numbers in ~40px instead of ~250, which is where the map gets its height. */
    '#deskStrip { padding: 7px 16px; border-bottom: 1px solid var(--border);',
    '  font-size: 12px; color: var(--text-secondary); display: flex; gap: 18px;',
    '  flex-wrap: wrap; align-items: baseline; }',
    '#deskStrip b { color: var(--text-primary); font-variant-numeric: tabular-nums; }',
    '#quotaPanel, #tiles { display: none !important; }',

    /* The shared .workspace grid becomes a full-height split with a drag grip in
       the middle column. min-height/min-width 0 on the grid children is what
       stops a long list from forcing the column taller than the window -- the
       default min-size of a grid item is its content. */
    '#deskSplit { flex: 1; min-height: 0; align-items: stretch !important;',
    '  gap: 0 !important; padding: 12px 16px 10px; }',
    '#deskSplit > .mapwrap { min-width: 0; display: flex; flex-direction: column;',
    '  min-height: 0; }',
    '.canvasbox { height: auto !important; flex: 1; min-height: 0; }',
    '#deskGrip { cursor: col-resize; background: transparent;',
    '  border-left: 1px solid var(--border); margin: 0 0 0 8px; }',
    '#deskGrip:hover { background: var(--grid); }',
    /* The panel supplies its own height for the web page; here the split does. */
    '#deskSplit > .sidepanel { height: auto !important; min-height: 0; margin-left: 9px; }',
    '.tabpane .list { max-height: none !important; }',
    /* No room for a footer in a fixed-height window, and its content is now in
       the strip and the About-style version pill anyway. */
    '.foot { display: none; }',
  ].join('\\n');
  document.head.appendChild(pvLayout);

  /*
    Choosing what to scan. The web app scans "your Drive" — there is no implicit
    subject here, so the app opens on a picker instead of an empty treemap and a
    button whose meaning you have to guess.
  */
  var pvBtn = document.getElementById('btnScan');
  pvBtn.textContent = 'Choose what to scan';

  /* This build asks about disks, so Dashboard.html must not also open its
     Drive-scope picker — two startup dialogs stacked on each other. */
  window.DS_SKIP_PICKER = true;

  var pvDlg = document.createElement('dialog');
  pvDlg.id = 'volDlg';
  pvDlg.innerHTML =
    '<div class="dlgbody" style="margin-bottom:14px">' +
      '<h2>What should I map?</h2>' +
      '<p class="hint">Tick one or more. They are drawn side by side in a single ' +
      'treemap, so you can compare them directly.</p>' +
      '<div id="volList" class="vollist"></div>' +
      '<p class="hint" id="volWarn" style="margin:10px 0 0"></p>' +
    '</div>' +
    '<form method="dialog" class="volfoot">' +
      '<button class="btn ghost" id="volBrowse" value="browse">Choose a folder…</button>' +
      '<span style="flex:1"></span>' +
      '<button class="btn ghost" value="cancel">Cancel</button>' +
      '<button class="btn primary" id="volGo" value="go">Scan</button>' +
    '</form>';

  var pvDlgCss = document.createElement('style');
  pvDlgCss.textContent =
    '#volDlg { width: 560px; max-width: 92vw; }' +
    '#volDlg h2 { font-size: 15px; margin: 0 0 3px; }' +
    '#volDlg .hint { font-size: 12px; color: var(--text-secondary); margin: 0 0 12px; }' +
    '.vollist { max-height: 340px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }' +
    '.volrow { display: flex; align-items: center; gap: 11px; padding: 9px 11px;' +
    '  border: 1px solid var(--border); border-radius: 9px; cursor: pointer; }' +
    '.volrow:hover { background: var(--plane); border-color: var(--baseline); }' +
    '.volrow input { width: 16px; height: 16px; accent-color: var(--brand-strong); flex: none; }' +
    '.volrow .nm { flex: 1; min-width: 0; }' +
    '.volrow .nm b { font-size: 13px; }' +
    '.volrow .nm small { display: block; color: var(--muted); font-size: 11px; margin-top: 1px; }' +
    /* A bar makes six volumes comparable at a glance in a way six percentages do not. */
    '.volrow .gauge { flex: none; width: 92px; height: 6px; border-radius: 99px;' +
    '  background: var(--grid); overflow: hidden; }' +
    '.volrow .gauge i { display: block; height: 100%; background: var(--brand-strong); }' +
    '.volrow .free { flex: none; width: 92px; text-align: right; font-size: 12px;' +
    '  color: var(--text-secondary); font-variant-numeric: tabular-nums; }' +
    '.volfoot { display: flex; gap: 8px; align-items: center; }';
  document.head.appendChild(pvDlgCss);
  /*
    Appended INSIDE #app, not to <body>. Every design token in this project is
    declared on .viz-root rather than on :root, so anything mounted outside it
    resolves every var(--…) to nothing — each declaration using one is dropped and
    the dialog renders as a bare white box with unstyled buttons. showModal() still
    promotes it to the top layer, so it is unaffected by the flex/overflow layout
    around it.
  */
  document.getElementById('app').appendChild(pvDlg);

  var pvExtra = [];   // folders added via the browse button

  var pvFmt = function (b) { return typeof tmFmtBytes === 'function' ? tmFmtBytes(b) : b + ' B'; };

  async function pvFillVolumes() {
    var vols = await window.desktop.listVolumes();
    var chosen = window.desktop.getRoots();
    var rows = vols.map(function (v) {
      var used = v.total - v.free;
      var pct = v.total ? Math.round(100 * used / v.total) : 0;
      return '<label class="volrow">' +
        '<input type="checkbox" value="' + v.path.replace(/"/g, '&quot;') + '"' +
        (chosen.indexOf(v.path) >= 0 ? ' checked' : '') + '>' +
        '<span class="nm"><b>' + v.path + '</b><small>' + pvFmt(used) + ' of ' +
        pvFmt(v.total) + ' used · ' + pct + '%</small></span>' +
        '<span class="gauge"><i style="width:' + pct + '%"></i></span>' +
        '<span class="free">' + pvFmt(v.free) + ' free</span></label>';
    });
    rows = rows.concat(pvExtra.map(function (p) {
      return '<label class="volrow">' +
        '<input type="checkbox" value="' + p.replace(/"/g, '&quot;') + '" checked>' +
        '<span class="nm"><b>' + p + '</b><small>chosen folder</small></span>' +
        '<span class="free">folder</span></label>';
    }));
    document.getElementById('volList').innerHTML = rows.join('') ||
      '<div class="empty-list">No volumes found.</div>';
    pvSyncWarn();
  }

  /* A whole system drive is millions of entries, and the renderer holds one
     object per file. Say so before the scan rather than after it runs out of
     memory. */
  function pvSyncWarn() {
    var boxes = pvDlg.querySelectorAll('input:checked');
    var big = [].some.call(boxes, function (b) { return /^[A-Za-z]:\\\\?$/.test(b.value); });
    document.getElementById('volWarn').innerHTML = big
      ? '<b>Scanning a whole drive can take a while</b> and uses memory in proportion ' +
        'to the number of files. Pick a folder instead if you only care about one project.'
      : '';
    document.getElementById('volGo').disabled = boxes.length === 0;
  }
  pvDlg.addEventListener('change', pvSyncWarn);

  document.getElementById('volBrowse').addEventListener('click', async function (ev) {
    ev.preventDefault();                      // keep the dialog open
    var picked = await window.desktop.browseFolders();
    picked.forEach(function (p) { if (pvExtra.indexOf(p) < 0) pvExtra.push(p); });
    await pvFillVolumes();
  });

  pvDlg.addEventListener('close', function () {
    if (pvDlg.returnValue !== 'go') return;
    var roots = [].map.call(pvDlg.querySelectorAll('input:checked'), function (b) { return b.value; });
    if (!roots.length) return;
    window.desktop.setRoots(roots);
    pvBtn.textContent = roots.length === 1 ? 'Rescan ' + roots[0] : 'Rescan ' + roots.length + ' locations';
    /* Re-boot now that there are roots: getBootstrap reads them with statfs, and
       before anything is chosen it has nothing to measure — which is why Disk
       usage sat at "0 B used" for the whole of the first scan. */
    google.script.run.withSuccessHandler(dsOnBoot).getBootstrap();
    pvBtn.click();
  });

  function pvOpenPicker() { pvFillVolumes().then(function () { pvDlg.showModal(); }); }

  pvBtn.addEventListener('click', function (ev) {
    if (window.desktop.getRoots().length) return;   // chosen already — let the real scan run
    ev.stopImmediatePropagation();
    ev.preventDefault();
    pvOpenPicker();
  }, true);

  /* Open on the picker rather than on an empty treemap. */
  window.addEventListener('load', function () { setTimeout(pvOpenPicker, 250); });

  var pvQuota = document.getElementById('quotaPanel');
  if (pvQuota) pvQuota.querySelector('h2').textContent = 'Disk usage';

  /*
    The quota panel and the stat tiles are Drive-shaped in ways CSS cannot hide —
    trash that is still billed, Gmail and Photos sharing the pool, shared drives on
    another. Both are hidden, and dsRenderQuota / dsRenderTiles are replaced further
    down to write the one-line strip instead. They are globals, and the project's
    rule against IIFEs is what makes replacing them possible.
  */

  /*
    Dashboard.html creates a synthetic '__root__' node named "My Drive" to hold
    whatever the scan produced, so the breadcrumb and the outermost treemap tile
    both said "My Drive" over a scan of D:\. Renaming the node is enough — every
    label reads through it. Wrapping tmSetRoot catches both the initial draw and
    the zoom-out, and the id guard means zooming INTO a folder is untouched.
  */
  /* The legend still offered to "open it in Drive". */
  var pvLegend = window.tmLegendHtml;
  window.tmLegendHtml = function () {
    return pvLegend.apply(this, arguments)
      .replace(/double-click to open it in Drive/g, 'double-click to reveal in File Explorer')
      .replace(/double-click a tile to open it in Drive/g, 'double-click a tile to reveal it');
  };

  var pvSetRoot = window.tmSetRoot;
  window.tmSetRoot = function (node) {
    if (node && node.id === '__root__') {
      var rs = window.desktop.getRoots();
      node.name = rs.length === 1 ? rs[0] : (rs.length ? rs.length + ' locations' : 'Scanned');
    }
    return pvSetRoot.apply(this, arguments);
  };

  /*
    The side tabs now come from apps-script/Index.html — Dead folders, File
    types, Migration classes, Shared drives — so this build no longer constructs
    its own tab bar out of the panels. What is left here is the part that really
    is desktop-only: making the workspace fill the window, and a draggable grip.
  */
  var pvWork = document.querySelector('.workspace');
  var pvSide = document.querySelector('.sidepanel');
  if (pvWork && pvSide) {
    var pvStrip = document.createElement('div');
    pvStrip.id = 'deskStrip';
    document.getElementById('app').insertBefore(pvStrip, pvWork);
    pvWork.id = 'deskSplit';

    var pvGrip = document.createElement('div');
    pvGrip.id = 'deskGrip';
    pvWork.insertBefore(pvGrip, pvSide);

    /* Draggable divider, remembered between sessions. The treemap only redraws on
       a window resize event, and dragging this fires none -- without the explicit
       tmDraw the canvas would keep its old backing size and stretch. */
    var pvW = Number(localStorage.getItem('deskSideW')) || 430;
    var pvSetW = function (w) {
      var max = Math.max(300, window.innerWidth - 420);
      pvW = Math.min(max, Math.max(300, w));
      pvWork.style.gridTemplateColumns = 'minmax(0,1fr) 6px ' + pvW + 'px';
      if (typeof tmDraw === 'function' && typeof TM_ROOT !== 'undefined' && TM_ROOT) tmDraw();
    };
    pvSetW(pvW);
    pvGrip.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      var move = function (e) { pvSetW(window.innerWidth - e.clientX - 8); };
      var up = function () {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        localStorage.setItem('deskSideW', String(pvW));
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    /* The strip carries what the quota panel and the tiles used to say. */
    window.dsRenderTiles = function () {
      if (!DS_BOOT) return;
      var q = DS_BOOT.quota, bits = [];
      var rs = window.desktop.getRoots();
      bits.push('<b>' + dsEsc(rs.length === 1 ? rs[0] : rs.length + ' locations') + '</b>');
      if (q.limit > 0) {
        bits.push(dsEsc(tmFmtBytes(q.usage)) + ' of ' + dsEsc(tmFmtBytes(q.limit)) +
                  ' used <b>(' + (100 * q.usage / q.limit).toFixed(0) + '%)</b>');
      }
      if (DS_TREE) {
        var s = dsSummary();
        bits.push('scanned <b>' + dsEsc(tmFmtBytes(DS_TREE.bytes || 0)) + '</b>');
        bits.push('<b>' + s.fileTotal.toLocaleString() + '</b> files in <b>' +
                  s.folderTotal.toLocaleString() + '</b> folders');
        bits.push('<b>' + dsEsc(tmFmtBytes(s.deadBytes)) + '</b> idle > ' + dsDaysLabel(DS_DEAD_DAYS));
      }
      pvStrip.innerHTML = bits.join('<span style="opacity:.4">·</span>');
    };
    window.dsRenderQuota = function () { window.dsRenderTiles(); };
  }

  /*
    Everything about MOVING files is removed here. This build is for looking at
    your own disk, or helping a colleague look at theirs — a migration plan aimed
    at one specific QNAP is meaningless in that context, and an app that can bin
    files on someone else's machine needs a much better reason than "the web
    version had the button".

    Hidden by CSS rather than removed from the DOM: Dashboard.html binds to these
    nodes at boot and writes into them on every render, so deleting them turns a
    working build into a silent null-reference. :has() is safe — Electron 33 is
    Chromium 130.
  */
  var pvCss = document.createElement('style');
  pvCss.textContent = [
    /* migration classes, shared drives, and the whole reclaim/trash panel */
    '#tabClasses, #tabDrives, .siderail button[data-tab="tabClasses"], .siderail button[data-tab="tabDrives"],' +
    '.panel:has(#bigList) { display: none !important; }',
    /* the Storage Mapper hand-off, and the Drive-scope picker */
    '.note.tool, label.field:has(#scope) { display: none !important; }',
    /* "move" pills on dead folders — this build proposes nothing */
    '#tabDead .pill { display: none !important; }',
    /* one panel per row now that half of them are gone */
    
  ].join('\\n');
  document.head.appendChild(pvCss);

  var pvHint = document.querySelector('#tabDead .hint');
  if (pvHint) {
    pvHint.textContent = 'Folders where nothing has been modified since the threshold. ' +
      'Usually the best place to start clearing space.';
  }

  /*
    dsDriveUrl builds a drive.google.com link for the ↗ on every row, which on a
    local disk points at nothing. Return the path instead and intercept the click:
    capture phase, so it runs before the anchor's default navigation.
  */
  window.dsDriveUrl = function (n) { return n && n.id ? n.id : '#'; };
  window.dsOpenInDrive = function (n) { if (n && n.id) window.desktop.reveal(n.id); };
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a.open') : null;
    if (!a) return;
    ev.preventDefault();
    ev.stopPropagation();                 // the row itself zooms; the arrow reveals
    var p = a.getAttribute('href');
    if (p && p !== '#') window.desktop.reveal(p);
  }, true);

  /**
   * Drop a trashed node and everything under it, then rebuild.
   *
   * Trashing a FOLDER removes its whole contents, so the subtree has to leave the
   * model or the treemap keeps drawing files that no longer exist. ids are paths
   * here, which makes "is a descendant" a prefix test — but it MUST be anchored on
   * a separator, or deleting D:\a would also purge D:\ab.
   *
   * A named global rather than an inline closure so the destructive path can be
   * exercised by a test without going through a native modal nobody can click.
   */
  window.deskPurgeAfterTrash = function (id) {
    var pre = String(id).replace(/[\\\\/]+$/, '').toLowerCase();
    var doomed = DS_ALL.filter(function (x) {
      var s = String(x.id).toLowerCase();
      return s === pre || s.indexOf(pre + '\\\\') === 0 || s.indexOf(pre + '/') === 0;
    });
    doomed.forEach(function (x) {
      var i = DS_ALL.indexOf(x);
      if (i > -1) DS_ALL.splice(i, 1);
      delete DS_BYID[x.id];
    });
    dsBuildTree();
    DS_STACK = [DS_TREE];
    tmSetRoot(DS_TREE);
    dsRenderCrumbs();
    dsRenderLists();
    return doomed.length;
  };

  /*
    File-type and dead-folder selection USED TO LIVE HERE, as a shim override.
    It now lives in apps-script/Dashboard.html + Treemap.html, so the web app and
    this one share one implementation instead of drifting apart. The shim keeps
    only what is genuinely desktop-specific.
  */

  /* ── notice dialog ──────────────────────────────────────────────────────── */
  /*
    Used for "cannot delete this" and "uninstall this instead". Its own dialog
    rather than showMessageBox: these are informational, they need an action
    button that opens Windows Settings, and they close with an X — a native
    message box gives none of that.
  */
  var pvNoticeDlg = document.createElement('dialog');
  pvNoticeDlg.id = 'noticeDlg';
  document.getElementById('app').appendChild(pvNoticeDlg);

  var pvNoticeCss = document.createElement('style');
  pvNoticeCss.textContent =
    '#noticeDlg { width: 460px; max-width: 92vw; }' +
    '#noticeDlg .nhead { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 8px; }' +
    '#noticeDlg h2 { font-size: 15px; margin: 0; flex: 1; }' +
    '#noticeDlg .nx { border: 0; background: none; cursor: pointer; color: var(--muted);' +
    '  font-size: 18px; line-height: 1; padding: 0 2px; }' +
    '#noticeDlg .nx:hover { color: var(--text-primary); }' +
    '#noticeDlg p { font-size: 13px; color: var(--text-secondary); margin: 0 0 14px; line-height: 1.55; }' +
    '#noticeDlg .npath { font-family: ui-monospace, Consolas, monospace; font-size: 11px;' +
    '  color: var(--muted); word-break: break-all; margin: 0 0 12px; }' +
    '#noticeDlg .nfoot { display: flex; gap: 8px; justify-content: flex-end; }';
  document.head.appendChild(pvNoticeCss);

  function pvNotice(title, body, action) {
    pvNoticeDlg.innerHTML =
      '<div class="dlgbody">' +
        '<div class="nhead"><h2>' + dsEsc(title) + '</h2>' +
        '<button class="nx" data-x="1" title="Close" aria-label="Close">✕</button></div>' +
        '<p>' + body + '</p>' +
      '</div>' +
      '<div class="nfoot">' +
        (action ? '<button class="btn primary" data-act="' + action.act + '">' +
          dsEsc(action.label) + '</button>' : '') +
        '<button class="btn ghost" data-x="1">Close</button>' +
      '</div>';
    pvNoticeDlg.showModal();
  }

  pvNoticeDlg.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button') : null;
    if (!b) return;
    if (b.dataset.act === 'apps') window.desktop.openAppsSettings();
    pvNoticeDlg.close();
  });

  /* ── right-click a tile ─────────────────────────────────────────────────── */
  /*
    The menu itself — element, placement, dismissal — is Dashboard.html's now.
    This build only says what the items ARE, because the verbs genuinely differ:
    Recycle Bin and File Explorer here, Drive trash there. Replacing the item
    builder rather than binding a second contextmenu handler is what stops the
    two implementations from both opening a menu on the same right-click.
  */
  window.DS_MENU_BUILD = function (n) {
    if (!n || !n.id || n.synthetic) return [];   // rolled-up "N small files" is not a real path
    var isFolder = n.kind === 0;
    return [
      { label: 'Reveal in File Explorer', run: function () { window.desktop.reveal(n.id); } },
      { label: 'Copy full path', run: function () { window.desktop.writeClipboard(n.id); } },
      { label: 'Move to Recycle Bin' + (isFolder ? ' (whole folder)' : ''),
        danger: true, run: function () { deskTrash(n); } },
    ];
  };

  async function deskTrash(n) {
    /*
      Check before offering the confirm, so a protected path never even reaches a
      "Move to Recycle Bin?" prompt — being asked and then refused is worse than
      not being asked. Main refuses these independently; this is the explanation,
      not the guard.
    */
    var cls = await window.desktop.classifyPath(n.id);
    if (cls.level === 'system') {
      pvNotice('Windows system files cannot be deleted',
        dsEsc(cls.why) + ' Removing it would stop Windows working properly, so ' +
        'this app will not touch it.', null);
      return;
    }
    if (cls.level === 'software') {
      pvNotice('This looks like installed software',
        'Deleting the folder leaves the program half-removed and still registered ' +
        'as installed. Uninstall it properly instead — that clears its files, its ' +
        'registry entries and its entry in the apps list.',
        { label: 'Open Add or remove programs', act: 'apps' });
      return;
    }

    var ok = await window.desktop.confirmDelete({
      name: n.name, bytes: n.bytes, isFolder: n.kind === 0, fileCount: n.fileCount || 0,
    });
    if (!ok) return;

    google.script.run
      .withSuccessHandler(function (r) {
        if (r.failed && r.failed.length) {
          dsDialog('<h3>Could not delete</h3><p>' + dsEsc(r.failed[0].error || 'Unknown error') + '</p>');
          return;
        }
        /*
          Trashing a FOLDER removes everything under it, so the whole subtree has
          to leave the model or the treemap keeps drawing files that no longer
          exist. ids are paths here, which makes "is a descendant" a prefix test —
          anchored on a separator so D:\ab is not treated as a child of D:\a.
          Then reuse Dashboard's own post-trash refresh.
        */
        window.deskPurgeAfterTrash(n.id);
      })
      .withFailureHandler(function (e) { dsFail(e); })
      .trashFiles([n.id]);
  }
}
</script>`;

/*
  Parse the shim before writing it.

  The shim is a template literal, so every backslash in it is one level of
  escaping away from what actually ships — `'\\'` here becomes `'\'` in the
  output, which is an unterminated string that kills the ENTIRE script block, not
  just the line. The symptom is the whole desktop layer silently not existing,
  which looks like a layout bug rather than a syntax error. One parse here turns
  that into a build failure.
*/
const shimJs = SHIM.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>[\s\S]*$/, '');
try {
  // eslint-disable-next-line no-new-func
  new Function(shimJs);
} catch (err) {
  console.error('\nSHIM FAILED TO PARSE — not writing ui/index.html');
  console.error(`  ${err.message}`);
  const m = /line (\d+)/.exec(String(err.stack || ''));
  if (m) console.error(`  near line ${m[1]} of the shim`);
  process.exit(1);
}

mkdirSync(join(HERE, 'ui'), { recursive: true });
writeFileSync(join(HERE, 'ui', 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Disk Storage Explorer</title></head><body>\n${body}\n${SHIM}\n</body></html>`);

console.log('desktop/ui/index.html written');
