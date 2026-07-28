/**
 * Assemble a browser-runnable preview from the REAL Apps Script sources.
 *
 * It reads apps-script/*.html verbatim and resolves the <?!= include('X') ?>
 * tags exactly the way HtmlService does, then swaps in a mock google.script.run
 * backed by synthetic Drive data. The UI code under test is therefore the same
 * bytes that get deployed -- no second copy to drift out of sync.
 *
 * Usage: node tools/build_preview.mjs && open preview/index.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps-script');
const read = (f) => readFileSync(join(SRC, f), 'utf8');

// Resolve HtmlService includes the same way Code.gs's include() does.
function resolve(html, depth = 0) {
  if (depth > 6) return html;
  return html.replace(/<\?!=\s*include\(['"]([^'"]+)['"]\);?\s*\?>/g,
    (_, name) => resolve(read(`${name}.html`), depth + 1));
}

const body = resolve(read('Index.html'));

// ── synthetic Drive ─────────────────────────────────────────────────────────
const MOCK = `
<script>
/* Mock backend. Shapes match Code.gs exactly. */
var MK_MIMES = [
  'application/vnd.google-apps.folder',
  'video/mp4', 'image/vnd.adobe.photoshop', 'application/zip',
  'image/jpeg', 'application/pdf', 'model/gltf-binary',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.shortcut'
];
var MK_ITEMS = [];
var mkSeed = 20260728;
function mkRnd() { mkSeed = (mkSeed * 1103515245 + 12345) % 2147483648; return mkSeed / 2147483648; }
function mkPick(a) { return a[Math.floor(mkRnd() * a.length)]; }

function mkBuild() {
  var top = ['Video Projects','Photogrammetry','Archive 2019','Archive 2021','Unity Builds',
             'Marketing','Admin','Student Work','Raw Footage','Renders'];
  var sub = ['Iziko','Constantia','Amanzi','RIM','Dental VR','Open Day','Exports','Proxies',
             'Source','Deliverables','Old','Scratch'];
  var idn = 0;
  function id() { return 'id' + (++idn) + 'xxxxxxxxxxxxxxxxxxxxxxxxx'; }

  top.forEach(function (t, ti) {
    var tid = id();
    MK_ITEMS.push([tid, '', t, 0, 0, -1, 0]);
    var nsub = 2 + Math.floor(mkRnd() * 4);
    for (var s = 0; s < nsub; s++) {
      var sid = id();
      MK_ITEMS.push([sid, tid, mkPick(sub) + ' ' + (2018 + Math.floor(mkRnd() * 8)), 0, 0, -1, 0]);
      // ageing: the "Archive" trees skew very old
      var oldish = t.indexOf('Archive') === 0 || t === 'Raw Footage';
      var nf = 3 + Math.floor(mkRnd() * 14);
      for (var f = 0; f < nf; f++) {
        var r = mkRnd();
        var mimeIdx, bytes;
        if (r < .22)      { mimeIdx = 1; bytes = (200 + mkRnd() * 5200) * 1048576; }  // mp4
        else if (r < .34) { mimeIdx = 2; bytes = (80 + mkRnd() * 900) * 1048576; }    // psd
        else if (r < .44) { mimeIdx = 3; bytes = (40 + mkRnd() * 1800) * 1048576; }   // zip
        else if (r < .54) { mimeIdx = 6; bytes = (30 + mkRnd() * 400) * 1048576; }    // glb
        else if (r < .70) { mimeIdx = 4; bytes = (1 + mkRnd() * 14) * 1048576; }      // jpg
        else if (r < .78) { mimeIdx = 5; bytes = (.2 + mkRnd() * 9) * 1048576; }      // pdf
        else if (r < .88) { mimeIdx = 7; bytes = 0; }                                  // Doc
        else if (r < .93) { mimeIdx = 8; bytes = 0; }                                  // Sheet
        else if (r < .97) { mimeIdx = 9; bytes = 0; }                                  // Slides
        else if (r < .99) { mimeIdx = 10; bytes = 0; }                                 // Form
        else              { mimeIdx = 11; bytes = 0; }                                 // shortcut
        var kind = mimeIdx === 11 ? 3 : mimeIdx >= 7 ? 2 : 1;
        var days = oldish ? 400 + Math.floor(mkRnd() * 2200)
                          : Math.floor(mkRnd() * mkRnd() * 900);
        var ext = ['.mp4','.psd','.zip','.jpg','.pdf','.glb'][Math.max(0, mimeIdx - 1)] || '';
        var nm = (mimeIdx >= 7 ? mkPick(['Budget','Notes','Plan','Report','Deck','Sign-up'])
                               : mkPick(['take','shot','scan','render','master','proxy','cam_a','drone']))
                 + '_' + (1000 + Math.floor(mkRnd() * 8999)) + (mimeIdx < 7 ? ext : '');
        MK_ITEMS.push([id(), sid, nm, kind, Math.round(bytes), days, mimeIdx]);
      }
    }
  });
}
mkBuild();

var MK_CHUNK = 900, MK_CFG = {
  mappings: [{ driveFolderId: '', driveFolderPath: '', nasPath: '/share/GDriveBackup/studiouih' }],
  deadAfterDays: 365, smallFileFloorBytes: 1048576,
  exportFormats: 'docx,xlsx,pptx,svg', agentPollSeconds: 900, updatedAt: null
};

var MOCK_API = {
  getBootstrap: function () {
    var used = MK_ITEMS.reduce(function (a, t) { return a + t[4]; }, 0);
    return {
      user: 'studiouih@uwc.ac.za (PREVIEW — synthetic data)',
      // inTrash is a SUBSET of inDrive; usage also carries Gmail + Photos.
      quota: { limit: 2199023255552, usage: used * 1.18,
               inDrive: used, inTrash: used * 0.07 },
      drives: [{ id: 'd1', name: 'UIZ Shared' }, { id: 'd2', name: 'Iziko Project' },
               { id: 'd3', name: 'Faculty Media' }],
      driveCount: 3,
      config: MK_CFG,
      caps: { nasVerify: false, sharedDrives: true },
      isOwner: true,
      rootId: 'root', now: Date.now()
    };
  },
  measureDriveChunk: function (opts) {
    var seedByDrive = { d1: 3, d2: 11, d3: 7 };
    var k = seedByDrive[opts.driveId] || 5;
    var from = opts.pageToken ? Number(opts.pageToken) : 0;
    var pages = k % 3 + 1; // 1-3 pages, so the paginated loop is exercised
    return { driveId: opts.driveId,
             bytes: Math.round(k * 7.3e9), files: k * 137, folders: k * 12,
             oldestDays: 400 + k * 30,
             nextPageToken: from + 1 < pages ? String(from + 1) : null,
             done: from + 1 >= pages };
  },
  scanChunk: function (opts) {
    var from = opts && opts.pageToken ? Number(opts.pageToken) : 0;
    var slice = MK_ITEMS.slice(from, from + MK_CHUNK);
    var used = {}, mimes = [], remap = {};
    slice.forEach(function (t) {
      if (used[t[6]] === undefined) { used[t[6]] = mimes.length; mimes.push(MK_MIMES[t[6]]); }
    });
    var items = slice.map(function (t) {
      return [t[0], t[1], t[2], t[3], t[4], t[5], used[t[6]]];
    });
    var next = from + MK_CHUNK;
    return { items: items, mimes: mimes,
             nextPageToken: next < MK_ITEMS.length ? String(next) : null,
             done: next >= MK_ITEMS.length, pages: 1, elapsedMs: 40,
             trashedBytes: 0, trashedCount: 0 };
  },
  buildManifestCsv: function (rows) {
    var head = ['drive_id','name','path','class','mime','bytes','days_inactive','action','export_as'];
    var esc = function (v) { v = v == null ? '' : String(v);
      return /[",\\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return [head.join(',')].concat(rows.map(function (r) {
      return [r.id,r.name,r.path,r.cls,r.mime,r.bytes,r.days,r.action,r.exportAs||''].map(esc).join(',');
    })).join('\\n');
  },
  trashFiles: function (ids) { return { trashed: ids, failed: [], skipped: [], gated: false }; }
};

var google = { script: { run: (function () {
  function Runner(ok, bad) { this._ok = ok; this._bad = bad; }
  Runner.prototype.withSuccessHandler = function (f) { return new Runner(f, this._bad); };
  Runner.prototype.withFailureHandler = function (f) { return new Runner(this._ok, f); };
  Object.keys(MOCK_API).forEach(function (name) {
    Runner.prototype[name] = function () {
      var args = arguments, self = this;
      setTimeout(function () {
        try { var r = MOCK_API[name].apply(null, args); if (self._ok) self._ok(r); }
        catch (e) { if (self._bad) self._bad(e); else throw e; }
      }, 30);
    };
  });
  return new Runner(null, null);
})() } };
</script>`;

// The mock must be defined BEFORE Dashboard.html runs.
const out = body.replace(/(<script>\s*\/\*\s*\n\s*Dashboard logic\.)/, MOCK + '\n$1');
if (out === body) {
  console.error('WARN: mock not injected — Dashboard banner not matched');
  process.exit(1);
}

mkdirSync(join(ROOT, 'preview'), { recursive: true });
writeFileSync(join(ROOT, 'preview', 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Google Drive Storage Explorer — preview</title></head><body>\n${out}\n</body></html>`);
console.log('preview/index.html written');
