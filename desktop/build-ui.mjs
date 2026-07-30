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
  document.title = 'Drive & Disk Storage Explorer';

  /* Scan has to choose a root first. The web app scans "your Drive"; here there
     is no implicit subject until the user names one. */
  var pvBtn = document.getElementById('btnScan');
  var pvOrig = pvBtn.onclick;
  pvBtn.textContent = 'Choose folder & scan';
  pvBtn.addEventListener('click', async function (ev) {
    if (window.desktop.getRoot()) return;          // already chosen — let the real handler run
    ev.stopImmediatePropagation();
    ev.preventDefault();
    var picked = await window.desktop.pickRoot();
    if (picked) { pvBtn.textContent = 'Scan ' + picked; pvBtn.click(); }
  }, true);

  /* Drive-only chrome. Hidden rather than deleted so Dashboard.html can still
     find the nodes it binds to — removing them turns a working build into a
     silent null-reference at boot. */
  ['quotaPanel'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.querySelector('h2').textContent = 'Disk usage';
  });
  var pvHideAfter = function () {
    var drives = document.getElementById('driveList');
    if (drives) {
      var panel = drives.closest('.panel');
      if (panel) panel.hidden = true;
    }
  };
  setTimeout(pvHideAfter, 300);

  /* Double-click opens the containing folder instead of Drive. */
  if (typeof tmSetRoot === 'function') {
    window.dsOpenInDrive = function (n) {
      if (n && n.id) window.desktop.reveal(n.id);
    };
  }
}
</script>`;

mkdirSync(join(HERE, 'ui'), { recursive: true });
writeFileSync(join(HERE, 'ui', 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drive &amp; Disk Storage Explorer</title></head><body>\n${body}\n${SHIM}\n</body></html>`);

console.log('desktop/ui/index.html written');
