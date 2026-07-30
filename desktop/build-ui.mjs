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
    '.viz-root { max-width: none !important; padding: 14px 18px 18px !important; }',
    '.canvasbox { height: clamp(360px, calc(100vh - 430px), 1100px) !important; }',
    '.list { max-height: clamp(220px, calc(100vh - 620px), 900px) !important; }',
  ].join('\\n');
  document.head.appendChild(pvLayout);

  /*
    Choosing what to scan. The web app scans "your Drive" — there is no implicit
    subject here, so the app opens on a picker instead of an empty treemap and a
    button whose meaning you have to guess.
  */
  var pvBtn = document.getElementById('btnScan');
  pvBtn.textContent = 'Choose what to scan';

  var pvDlg = document.createElement('dialog');
  pvDlg.id = 'volDlg';
  pvDlg.innerHTML =
    '<div class="dlgbody">' +
      '<h2 style="font-size:15px;margin:0 0 4px">What should I map?</h2>' +
      '<p class="hint" style="margin:0 0 10px">Tick one or more. They are drawn side by ' +
      'side in a single treemap, so you can compare them directly.</p>' +
      '<div id="volList" class="list" style="max-height:320px"></div>' +
      '<p class="hint" id="volWarn" style="margin:10px 0 0"></p>' +
    '</div>' +
    '<form method="dialog" style="display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="btn ghost" id="volBrowse" value="browse">Choose a folder…</button>' +
      '<button class="btn ghost" value="cancel">Cancel</button>' +
      '<button class="btn primary" id="volGo" value="go">Scan</button>' +
    '</form>';
  document.body.appendChild(pvDlg);

  var pvExtra = [];   // folders added via the browse button

  var pvFmt = function (b) { return typeof tmFmtBytes === 'function' ? tmFmtBytes(b) : b + ' B'; };

  async function pvFillVolumes() {
    var vols = await window.desktop.listVolumes();
    var chosen = window.desktop.getRoots();
    var rows = vols.map(function (v) {
      var used = v.total - v.free;
      var pct = v.total ? Math.round(100 * used / v.total) : 0;
      return '<label class="row pick" style="cursor:pointer">' +
        '<input type="checkbox" value="' + v.path.replace(/"/g, '&quot;') + '"' +
        (chosen.indexOf(v.path) >= 0 ? ' checked' : '') + '>' +
        '<span class="nm"><b>' + v.path + '</b><small>' + pvFmt(used) + ' of ' +
        pvFmt(v.total) + ' used · ' + pct + '%</small></span>' +
        '<span class="sz">' + pvFmt(v.free) + ' free</span></label>';
    });
    rows = rows.concat(pvExtra.map(function (p) {
      return '<label class="row pick" style="cursor:pointer">' +
        '<input type="checkbox" value="' + p.replace(/"/g, '&quot;') + '" checked>' +
        '<span class="nm"><b>' + p + '</b><small>folder</small></span></label>';
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
    The quota meter and the stat tiles are written for Drive: trash that is still
    billed, Gmail and Photos sharing the pool, shared drives on a separate one.
    None of that exists on a volume, so both renderers are replaced rather than
    patched — they are globals, and the house rule against IIFEs is what makes
    that possible.
  */
  window.dsRenderQuota = function () {
    if (!DS_BOOT) return;
    var q = DS_BOOT.quota, capped = q.limit > 0;
    var used = q.usage || 0, free = capped ? Math.max(0, q.limit - used) : 0;
    var denom = capped ? q.limit : (used || 1);

    document.getElementById('quotaHero').innerHTML = capped
      ? dsEsc(tmFmtBytes(free)) + ' free <small>of ' + dsEsc(tmFmtBytes(q.limit)) +
        ' · ' + (100 * used / q.limit).toFixed(1) + '% used</small>'
      : '<small>Choose a folder to read the volume it sits on</small>';

    var segs = [{ label: 'Used', v: used, c: 'var(--brand-strong)' }];
    if (capped) segs.push({ label: 'Free', v: free, c: 'var(--grid)' });

    document.getElementById('quotaMeter').innerHTML = segs
      .filter(function (s) { return s.v > 0; })
      .map(function (s) {
        return '<i style="width:' + (100 * s.v / denom).toFixed(3) + '%;background:' + s.c +
               '" title="' + dsEsc(s.label + ' — ' + tmFmtBytes(s.v)) + '"></i>';
      }).join('');

    document.getElementById('quotaLegend').innerHTML = '<div class="keys">' + segs.map(function (s) {
      return '<span class="key"><i style="background:' + s.c + '"></i>' +
             dsEsc(s.label) + ' · ' + dsEsc(tmFmtBytes(s.v)) + '</span>';
    }).join('') + '</div>';

    document.getElementById('quotaNote').innerHTML = capped
      ? 'Whole-volume figures for the drive the scanned folder sits on, reported by ' +
        'the filesystem. The scan below covers only the folder you chose, so its ' +
        'total will usually be smaller than the used figure here.'
      : '';
  };

  window.dsRenderTiles = function () {
    if (!DS_BOOT) return;
    var tiles = [];
    if (DS_TREE) {
      var s = dsSummary();
      tiles.push(
        { k: 'Scanned', v: tmFmtBytes(DS_TREE.bytes || 0),
          n: 'total size of the chosen folder' },
        { k: 'Idle > ' + dsDaysLabel(DS_DEAD_DAYS), v: tmFmtBytes(s.deadBytes),
          n: s.deadFiles.toLocaleString() + ' files not modified since' },
        { k: 'Indexed', v: s.fileTotal.toLocaleString() + ' files',
          n: 'in ' + s.folderTotal.toLocaleString() + ' folders' });
    } else {
      tiles.push({ k: 'Nothing scanned yet', v: '—', n: 'choose a folder to begin' });
    }
    document.getElementById('tiles').innerHTML = tiles.map(function (t) {
      return '<div class="tile"><div class="k">' + dsEsc(t.k) + '</div><div class="v">' +
             dsEsc(t.v) + '</div><div class="n">' + dsEsc(t.n) + '</div></div>';
    }).join('');
  };

  /*
    Dashboard.html creates a synthetic '__root__' node named "My Drive" to hold
    whatever the scan produced, so the breadcrumb and the outermost treemap tile
    both said "My Drive" over a scan of D:\. Renaming the node is enough — every
    label reads through it. Wrapping tmSetRoot catches both the initial draw and
    the zoom-out, and the id guard means zooming INTO a folder is untouched.
  */
  var pvSetRoot = window.tmSetRoot;
  window.tmSetRoot = function (node) {
    if (node && node.id === '__root__') {
      var rs = window.desktop.getRoots();
      node.name = rs.length === 1 ? rs[0] : (rs.length ? rs.length + ' locations' : 'Scanned');
    }
    return pvSetRoot.apply(this, arguments);
  };

  /*
    Dead folders and Storage by file type become tabs. Both are long scrolling
    lists that answer different questions, and stacked they pushed the treemap —
    the thing you actually came for — off the top of the window.
  */
  var pvDead = document.querySelector('.panel:has(#deadList)');
  var pvType = document.querySelector('.panel:has(#typeList)');
  if (pvDead && pvType) {
    pvDead.parentNode.appendChild(pvType);          // same container, so tabs can swap them
    var pvBar = document.createElement('div');
    pvBar.className = 'seg dtabs';
    pvBar.style.margin = '0 0 12px';
    pvBar.innerHTML =
      '<button class="on" data-panel="dead">Dead folders</button>' +
      '<button data-panel="type">Storage by file type</button>';
    pvDead.parentNode.insertBefore(pvBar, pvDead);
    pvType.hidden = true;
    pvBar.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button[data-panel]') : null;
      if (!b) return;
      pvBar.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      var dead = b.dataset.panel === 'dead';
      pvDead.hidden = !dead;
      pvType.hidden = dead;
    });
    /* The tab label already names each panel; its own h2 would just repeat it. */
    var pvHide = document.createElement('style');
    pvHide.textContent =
      '.panel:has(#deadList) > .panelhead > h2, .panel:has(#typeList) > .panelhead > h2 { display: none; }' +
      '.panel:has(#typeList) > .panelhead { min-height: 0; }';
    document.head.appendChild(pvHide);
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
    '.panel:has(#classList), .panel:has(#driveList), .panel:has(#bigList) { display: none !important; }',
    /* the Storage Mapper hand-off, and the Drive-scope picker */
    '.note.tool, label.field:has(#scope) { display: none !important; }',
    /* "move" pills on dead folders — this build proposes nothing */
    '.panel:has(#deadList) .pill { display: none !important; }',
    /* one panel per row now that half of them are gone */
    '.cols { grid-template-columns: 1fr !important; }',
  ].join('\\n');
  document.head.appendChild(pvCss);

  var pvHint = document.querySelector('.panel:has(#deadList) .hint');
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
    var p = a.getAttribute('href');
    if (p && p !== '#') window.desktop.reveal(p);
  }, true);
}
</script>`;

mkdirSync(join(HERE, 'ui'), { recursive: true });
writeFileSync(join(HERE, 'ui', 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Disk Storage Explorer</title></head><body>\n${body}\n${SHIM}\n</body></html>`);

console.log('desktop/ui/index.html written');
