/**
 * Google Drive Storage Explorer — Drive storage treemap + NAS migration triage
 * Account: studiouih@uwc.ac.za
 *
 * Backend responsibilities:
 *   - paginated Drive inventory (client-driven, so the 6-min limit never bites)
 *   - storage-quota truth (quotaBytesUsed, not `size` — natives are 0-quota)
 *   - activity classification (dead / stale / cold / warm / hot)
 *   - migration class (NATIVE export vs BINARY move-and-delete)
 *   - config store for the QNAP agent to poll
 *   - gated trash (reversible only; verification-aware)
 *
 * The UI is served entirely from this project (Index/Styles/Treemap/Dashboard
 * .html) — no CDN, no external script.
 */

// ─── release stamp ───────────────────────────────────────────────────────────
/**
 * Shown in the banner so you can tell at a glance which build you are looking at
 * — the /dev URL and the versioned /exec URL routinely differ by a commit or two.
 *
 * BUMP BOTH BEFORE `clasp deploy`. This is the one thing in the project capable
 * of silently lying: `clasp deploy` mints a version number on Google's side and
 * has no way to write it back into the source, so nothing here fails if these go
 * stale. APP_VERSION must match the version clasp reports; APP_UPDATED is that
 * day, ISO so it cannot be misread as month-first.
 */
var APP_VERSION = 'v11';
var APP_UPDATED = '2026-07-31';

// ─── capability flags ────────────────────────────────────────────────────────
// A UI that ships separately from its backend must describe the BACKEND.
// Flip V_NAS_VERIFY only once the QNAP agent is actually reporting manifests.
var V_NAS_VERIFY = false; // agent not deployed yet → trash stays manually gated
var V_SHARED_DRIVES = true;

/**
 * The web app runs `executeAs: USER_ACCESSING`, so the Drive scan and the trash
 * always act on whoever opened it — a user can only ever see and bin their own
 * files. That isolation is free.
 *
 * Script Properties are NOT isolated: one shared store for every user of the
 * script. So the NAS config, which is studiouih's, has to be gated by hand or
 * any UWC user could rewrite the QNAP mappings from their own session.
 */
var OWNERS = ['studiouih@uwc.ac.za'];

function currentUser_() {
  try { return (Session.getActiveUser().getEmail() || '').toLowerCase(); }
  catch (e) { return ''; }
}
function isOwner_() {
  return OWNERS.indexOf(currentUser_()) !== -1;
}

// ─── tunables ────────────────────────────────────────────────────────────────
var SCAN_BUDGET_MS = 240000; // stop a chunk at 4 min, hand a token back to client
var PAGE_SIZE = 1000;
var PROP_CONFIG = 'SS_CONFIG';
var PROP_MANIFEST = 'SS_NAS_MANIFEST_FILE_ID';

var KIND_FOLDER = 0, KIND_BINARY = 1, KIND_NATIVE = 2, KIND_SHORTCUT = 3;

var NATIVE_PREFIX = 'application/vnd.google-apps.';
var MIME_FOLDER = NATIVE_PREFIX + 'folder';
var MIME_SHORTCUT = NATIVE_PREFIX + 'shortcut';

/** Google-native → what rclone will export it as when copying to the NAS. */
var EXPORT_MAP = {
  'document': 'docx',
  'spreadsheet': 'xlsx',
  'presentation': 'pptx',
  'drawing': 'svg',
  'script': 'json',
  'jam': 'pdf',
  'form': null, // not exportable by rclone — must stay in Drive
  'site': null,
  'map': null
};

// ─── web app entry ───────────────────────────────────────────────────────────
/**
 * Tab icon. Apps Script IGNORES a <link rel="icon"> inside the served HTML for
 * web apps — setFaviconUrl() is the only mechanism, and it normally expects an
 * http(s) URL. A data: URI works in current browsers but is not documented as
 * supported, so the call is wrapped: an icon must never be able to take the
 * whole app down. If the tab shows Google's default instead of the red mark,
 * host assets/icon-192.png somewhere public and put that URL here.
 */
var FAVICON_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJHb29nbGUgRHJpdmUgU3RvcmFnZSBFeHBsb3JlciI+CiAgPCEtLQogICAgQXBwIGljb24uIFRoZSByb3VuZGVkIHJlZCBzcXVhcmUgaXMgdGhlIGRhc2hib2FyZCdzIG93biAubG9nbyBtYXJrOyB0aGUgZm91cgogICAgYmxvY2tzIGluc2lkZSBhcmUgYSB0cmVlbWFwIHBhcnRpdGlvbiwgYW5kIHRoZWlyIG9wYWNpdHkgZm9sbG93cyB0aGUgc2l6ZQogICAgcmFtcCAobGFyZ2VzdCA9IG1vc3Qgb3BhcXVlKSBzbyB0aGUgaWNvbiBzYXlzIHdoYXQgdGhlIGFwcCBkb2VzLgogICAgRGVsaWJlcmF0ZWx5IG9ubHkgZm91ciBibG9ja3Mg4oCUIGFueXRoaW5nIGZpbmVyIHR1cm5zIHRvIG11c2ggYXQgMTZweC4KICAgIEdyYWRpZW50IHN0b3BzIGFyZSB0aGUgdmFsaWRhdGVkIHJhbXA6IHNpemUtNyAtPiBzaXplLTUgLT4gc2l6ZS0xLgogIC0tPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2E0MGExYiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjAuNTUiIHN0b3AtY29sb3I9IiNkMzRiNDkiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjZWVkNGQxIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogIDwvZGVmcz4KCiAgPHJlY3Qgd2lkdGg9IjUxMiIgaGVpZ2h0PSI1MTIiIHJ4PSIxMTQiIHJ5PSIxMTQiIGZpbGw9InVybCgjZykiLz4KCiAgPCEtLQogICAgT3BhY2l0eSBmbG9vciBpcyAwLjUyLCBub3QgdGhlIHJhbXAncyB0cnVlIGJvdHRvbTogYXQgMTZweCBhbnl0aGluZyBmYWludGVyCiAgICBkaXNhcHBlYXJzIGludG8gdGhlIGxpZ2h0IGVuZCBvZiB0aGUgZ3JhZGllbnQgYW5kIHRoZSBpY29uIHJlYWRzIGFzIGEgcGxhaW4KICAgIHJlZCBzcXVhcmUuIFRoZSBmb3VyIHN0ZXBzIHN0aWxsIGRlc2NlbmQsIHNvIHRoZSBvcmRlcmluZyBzdXJ2aXZlcy4KICAgIEdhcHMgYXJlIDE4cHggKDMuNSUpIGZvciB0aGUgc2FtZSByZWFzb24g4oCUIDhweCB2YW5pc2hlZCB3aGVuIHNjYWxlZCBkb3duLgogIC0tPgogIDxnIGZpbGw9IiNmZmZmZmYiPgogICAgPHJlY3QgeD0iOTYiICB5PSI5NiIgIHdpZHRoPSIxOTAiIGhlaWdodD0iMTgwIiByeD0iMTAiIG9wYWNpdHk9IjEiLz4KICAgIDxyZWN0IHg9IjMwNCIgeT0iOTYiICB3aWR0aD0iMTEyIiBoZWlnaHQ9IjE4MCIgcng9IjEwIiBvcGFjaXR5PSIwLjg0Ii8+CiAgICA8cmVjdCB4PSI5NiIgIHk9IjI5NCIgd2lkdGg9IjE5MCIgaGVpZ2h0PSIxMjIiIHJ4PSIxMCIgb3BhY2l0eT0iMC42OCIvPgogICAgPHJlY3QgeD0iMzA0IiB5PSIyOTQiIHdpZHRoPSIxMTIiIGhlaWdodD0iMTIyIiByeD0iMTAiIG9wYWNpdHk9IjAuNTIiLz4KICA8L2c+Cjwvc3ZnPgo=';

function doGet() {
  var out = HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Google Drive Storage Explorer')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  try {
    if (FAVICON_URL) out.setFaviconUrl(FAVICON_URL);
  } catch (e) {
    // rejected URL — serve the app without a custom icon rather than failing
  }
  return out;
}

/** Inline an HTML partial into Index. Keeps the UI single-origin. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ─── bootstrap ───────────────────────────────────────────────────────────────
/** Quota + config + capability flags, so the UI knows what the server can do. */
/*
 * Which Google types can actually be exported, ACCORDING TO GOOGLE.
 *
 * This used to be a hand-written table in Dashboard.html, and a hand-written
 * table of Google's capabilities is wrong the day Google ships a new type. It
 * already was: Google Vids was missing, and the sibling desktop app hit the same
 * gap from the other side — it offered six .gvid stubs for copying, robocopy
 * failed every one with "Incorrect function", and the files could never transfer
 * because a native has no bytes behind it.
 *
 * about.exportFormats is the authoritative map and it costs one field on a call
 * the bootstrap already makes. Nothing here decides what is exportable any more;
 * it reports what Google says.
 *
 * Returned as mime -> [formats] so the UI can name the target extension, and
 * so "no export path" means Google offered none rather than nobody added it.
 */
function exportFormatMap_(about) {
  var raw = about.exportFormats || {};
  var out = {};
  Object.keys(raw).forEach(function (mime) {
    if (mime.indexOf('application/vnd.google-apps.') !== 0) return;
    out[mime.slice(28)] = raw[mime] || [];
  });
  return out;
}

function getBootstrap() {
  var about = Drive.About.get({
    fields: 'storageQuota,user(emailAddress,displayName),exportFormats'
  });
  var q = about.storageQuota || {};
  var drives = [];
  if (V_SHARED_DRIVES) {
    try {
      var tok = null;
      do { // paginate — an account on more than 100 shared drives is plausible
        var dl = Drive.Drives.list({
          pageSize: 100, fields: 'nextPageToken,drives(id,name)', pageToken: tok || undefined
        });
        (dl.drives || []).forEach(function (d) { drives.push({ id: d.id, name: d.name }); });
        tok = dl.nextPageToken || null;
      } while (tok && drives.length < 500);
    } catch (e) {
      drives = []; // no shared-drive access on this account — not fatal
    }
  }
  return {
    user: (about.user || {}).emailAddress || '',
    quota: {
      // `limit` is absent on pooled/unlimited Workspace storage — 0 means "no cap
      // published", not "no space". usageInDriveTrash is a SUBSET of usageInDrive,
      // and `usage` also carries Gmail + Photos, which is why they never match.
      limit: Number(q.limit || 0),
      usage: Number(q.usage || 0),
      inDrive: Number(q.usageInDrive || 0),
      inTrash: Number(q.usageInDriveTrash || 0)
    },
    drives: drives,
    driveCount: drives.length,
    config: getConfig(),
    caps: { nasVerify: V_NAS_VERIFY, sharedDrives: V_SHARED_DRIVES },
    exportFormats: exportFormatMap_(about),
    isOwner: isOwner_(),
    rootId: Drive.Files.get('root', { fields: 'id' }).id,
    version: APP_VERSION,
    updated: APP_UPDATED,
    now: Date.now()
  };
}

// ─── the scan ────────────────────────────────────────────────────────────────
/**
 * One chunk of the inventory. Client calls repeatedly until done=true.
 *
 * Returns compact tuples to keep the google.script.run payload small:
 *   [ id, parentId, name, kind, bytes, actDays, mimeIdx, md5 ]
 * `mimes` is a per-chunk dictionary the client remaps into its own table.
 *
 * @param {Object} opts {pageToken, scope:'owned'|'all', driveId, includeTrashed}
 */
function scanChunk(opts) {
  opts = opts || {};
  var started = Date.now();
  var items = [];
  var mimes = [], mimeIx = {};
  var token = opts.pageToken || null;
  var pages = 0;
  var trashedBytes = 0, trashedCount = 0;

  var q = [];
  q.push(opts.includeTrashed ? 'trashed = true' : 'trashed = false');
  if (opts.scope === 'owned') q.push("'me' in owners");

  var params = {
    q: q.join(' and '),
    pageSize: PAGE_SIZE,
    // md5Checksum is returned by the API at no cost and without downloading the
// file. It is the only way to prove two files are byte-identical without
// reading their contents, which is what the NAS de-duplication needs.
    fields: 'nextPageToken,files(id,name,mimeType,size,quotaBytesUsed,parents,' +
            'modifiedTime,viewedByMeTime,createdTime,md5Checksum,shortcutDetails(targetId))',
    orderBy: 'folder,quotaBytesUsed desc'
  };
  if (opts.driveId) {
    params.corpora = 'drive';
    params.driveId = opts.driveId;
    params.includeItemsFromAllDrives = true;
    params.supportsAllDrives = true;
  } else {
    params.corpora = 'user';
  }

  do {
    if (token) params.pageToken = token; else delete params.pageToken;
    var res = Drive.Files.list(params);
    var files = res.files || [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var mime = f.mimeType || '';
      var kind = mime === MIME_FOLDER ? KIND_FOLDER
               : mime === MIME_SHORTCUT ? KIND_SHORTCUT
               : mime.indexOf(NATIVE_PREFIX) === 0 ? KIND_NATIVE
               : KIND_BINARY;

      // quotaBytesUsed is the ONLY honest storage number. `size` is absent on
      // natives, and natives consume ~0 quota — deleting them frees nothing.
      var bytes = Number(f.quotaBytesUsed || 0);
      if (!bytes && f.size) bytes = Number(f.size);

      if (opts.includeTrashed) { trashedBytes += bytes; trashedCount++; continue; }

      if (mimeIx[mime] === undefined) { mimeIx[mime] = mimes.length; mimes.push(mime); }

      items.push([
        f.id,
        (f.parents && f.parents[0]) || '',
        f.name || '(untitled)',
        kind,
        bytes,
        activityDays_(f, started),
        mimeIx[mime],
        f.md5Checksum || ''
      ]);
    }
    token = res.nextPageToken || null;
    pages++;
  } while (token && (Date.now() - started) < SCAN_BUDGET_MS);

  return {
    items: items,
    mimes: mimes,
    nextPageToken: token,
    done: !token,
    pages: pages,
    elapsedMs: Date.now() - started,
    trashedBytes: trashedBytes,
    trashedCount: trashedCount
  };
}

/**
 * Totals for one shared drive. Deliberately separate from scanChunk: measuring
 * a drive only needs the running sums, so shipping every filename back would be
 * wasted payload. Client-paginated for the same 6-minute reason.
 *
 * Note shared-drive content does NOT count against a user's personal quota — it
 * bills to the shared drive's own pool — so these numbers must never be added
 * to the My Drive figures.
 */
function measureDriveChunk(opts) {
  opts = opts || {};
  var started = Date.now();
  var bytes = 0, files = 0, folders = 0, oldest = -1;
  var token = opts.pageToken || null;

  do {
    var res = Drive.Files.list({
      q: 'trashed = false',
      corpora: 'drive',
      driveId: opts.driveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: PAGE_SIZE,
      pageToken: token || undefined,
      fields: 'nextPageToken,files(mimeType,size,quotaBytesUsed,modifiedTime,viewedByMeTime)'
    });
    var list = res.files || [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (f.mimeType === MIME_FOLDER) { folders++; continue; }
      files++;
      var b = Number(f.quotaBytesUsed || 0);
      if (!b && f.size) b = Number(f.size);
      bytes += b;
      var d = activityDays_(f, started);
      if (d > oldest) oldest = d;
    }
    token = res.nextPageToken || null;
  } while (token && (Date.now() - started) < SCAN_BUDGET_MS);

  return {
    driveId: opts.driveId, bytes: bytes, files: files, folders: folders,
    oldestDays: oldest, nextPageToken: token, done: !token
  };
}

/** Days since the file was last modified OR opened by this user. -1 = unknown. */
function activityDays_(f, nowMs) {
  var best = 0;
  ['modifiedTime', 'viewedByMeTime'].forEach(function (k) {
    if (f[k]) { var t = new Date(f[k]).getTime(); if (t > best) best = t; }
  });
  if (!best) return -1;
  return Math.floor((nowMs - best) / 86400000);
}

// ─── config store (the QNAP agent polls this) ────────────────────────────────
function getConfig() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_CONFIG);
  var cfg = raw ? JSON.parse(raw) : {};
  return {
    mappings: cfg.mappings || [],           // [{driveFolderId, driveFolderPath, nasPath}]
    deadAfterDays: cfg.deadAfterDays || 365,
    smallFileFloorBytes: cfg.smallFileFloorBytes || 1048576,
    exportFormats: cfg.exportFormats || 'docx,xlsx,pptx,svg',
    agentPollSeconds: cfg.agentPollSeconds || 900,
    updatedAt: cfg.updatedAt || null
  };
}

function saveConfig(cfg) {
  // Script Properties are shared across every user of this web app — without
  // this gate any UWC account could rewrite the QNAP mappings.
  if (!isOwner_()) {
    return { ok: false, error: 'Only ' + OWNERS.join(', ') + ' can change the NAS configuration.' };
  }
  var clean = {
    mappings: (cfg.mappings || []).map(function (m) {
      return {
        driveFolderId: String(m.driveFolderId || ''),
        driveFolderPath: String(m.driveFolderPath || ''),
        nasPath: String(m.nasPath || '')
      };
    }).filter(function (m) { return m.driveFolderId && m.nasPath; }),
    deadAfterDays: Number(cfg.deadAfterDays) || 365,
    smallFileFloorBytes: Number(cfg.smallFileFloorBytes) || 1048576,
    exportFormats: String(cfg.exportFormats || 'docx,xlsx,pptx,svg'),
    agentPollSeconds: Number(cfg.agentPollSeconds) || 900,
    updatedAt: new Date().toISOString()
  };
  PropertiesService.getScriptProperties().setProperty(PROP_CONFIG, JSON.stringify(clean));
  return getConfig(); // echo back what was actually stored
}

/**
 * Agent endpoint. The QNAP box polls this outbound — Apps Script can never
 * reach a LAN address, so the NAS must always be the one reaching out.
 */
function doPost(e) {
  var out = function (o) {
    return ContentService.createTextOutput(JSON.stringify(o))
      .setMimeType(ContentService.MimeType.JSON);
  };
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return out({ ok: false, error: 'bad JSON' }); }

  switch (body.action) {
    case 'config':
      return out({ ok: true, config: getConfig() });
    case 'report':
      return out(receiveNasReport_(body));
    default:
      return out({ ok: false, error: 'unknown action: ' + body.action });
  }
}

/** Agent posts what it actually holds on the NAS: [{id, md5, bytes, path}]. */
function receiveNasReport_(body) {
  if (!isOwner_()) return { ok: false, error: 'not authorised' };
  var files = body.files || [];
  var blob = Utilities.newBlob(JSON.stringify({
    receivedAt: new Date().toISOString(),
    host: body.host || 'unknown',
    files: files
  }), 'application/json', 'nas-manifest.json');

  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_MANIFEST);
  var file;
  if (id) {
    try { file = DriveApp.getFileById(id); file.setContent(blob.getDataAsString()); }
    catch (err) { id = null; }
  }
  if (!id) {
    file = DriveApp.createFile(blob);
    props.setProperty(PROP_MANIFEST, file.getId());
  }
  return { ok: true, received: files.length, manifestFileId: file.getId() };
}

/** Ids the NAS has confirmed it holds — the only files trash may touch. */
function getVerifiedIds() {
  if (!V_NAS_VERIFY) return { enabled: false, ids: [], receivedAt: null };
  var id = PropertiesService.getScriptProperties().getProperty(PROP_MANIFEST);
  if (!id) return { enabled: true, ids: [], receivedAt: null };
  try {
    var data = JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString());
    return {
      enabled: true,
      receivedAt: data.receivedAt,
      ids: (data.files || []).map(function (f) { return f.id; })
    };
  } catch (e) {
    return { enabled: true, ids: [], receivedAt: null, error: String(e) };
  }
}

// ─── converting natives into real files ──────────────────────────────────────
/*
 * A Google-native file has no bytes. Drive for Desktop shows a .gdoc/.gvid stub
 * of a few hundred bytes that cannot even be read — the sibling desktop app hit
 * exactly this, offered six .gvid stubs for copying, and robocopy failed every
 * one with "Incorrect function". No amount of work on the desktop side fixes it:
 * the content only exists inside Google.
 *
 * This is the half that can only happen here. Export through Drive, write the
 * result back into Drive BESIDE the original, and Drive for Desktop syncs it
 * down as a real file — at which point the desktop app copies it to the NAS like
 * anything else, with no new credential anywhere and no second sign-in.
 *
 * Beside the original, not into a staging tree, because the folder structure is
 * then already correct: the converted file lands at the same relative path the
 * NAS mirror expects, so nothing has to be remapped afterwards.
 *
 * ADDITIVE ONLY. It creates files; it never modifies, moves or trashes one, and
 * it skips anything already converted, so running it twice is safe.
 */
var CONVERT_BUDGET_MS = 4.5 * 60 * 1000;  // Apps Script kills at 6; leave room to return

/** Extension for an export mime, or null if we would not know what to call it. */
function extForMime_(mime) {
  var MAP = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.oasis.opendocument.text': 'odt',
    'application/vnd.oasis.opendocument.spreadsheet': 'ods',
    'application/vnd.oasis.opendocument.presentation': 'odp',
    'application/pdf': 'pdf', 'text/csv': 'csv', 'image/svg+xml': 'svg',
    'image/png': 'png', 'image/jpeg': 'jpg', 'text/plain': 'txt',
    'application/vnd.google-apps.script+json': 'json',
    'application/zip': 'zip', 'video/mp4': 'mp4', 'text/html': 'html'
  };
  return MAP[mime] || null;
}

/**
 * Which export Google offers for this native type, preferring the format worth
 * keeping. Returns null when Google offers none — in which case the file simply
 * cannot be converted and saying so is the only honest answer.
 */
function chooseExport_(mime, exportFormats) {
  var offered = exportFormats[mime] || [];
  var PREF = {
    'application/vnd.google-apps.document': ['docx', 'odt', 'pdf'],
    'application/vnd.google-apps.spreadsheet': ['xlsx', 'ods', 'csv'],
    'application/vnd.google-apps.presentation': ['pptx', 'odp', 'pdf'],
    'application/vnd.google-apps.drawing': ['svg', 'png', 'pdf'],
    'application/vnd.google-apps.script': ['json'],
    'application/vnd.google-apps.jam': ['pdf'],
    'application/vnd.google-apps.vid': ['mp4']
  };
  var byExt = {};
  offered.forEach(function (m) {
    var e = extForMime_(m);
    if (e && !byExt[e]) byExt[e] = m;
  });
  var want = PREF[mime] || [];
  for (var i = 0; i < want.length; i++) {
    if (byExt[want[i]]) return { mime: byExt[want[i]], ext: want[i] };
  }
  var keys = Object.keys(byExt);
  return keys.length ? { mime: byExt[keys[0]], ext: keys[0] } : null;
}

/**
 * What WOULD be converted, without converting anything.
 *
 * Separate from the run on purpose: this writes files into someone's Drive, and
 * the first thing anyone should be able to do is see the list.
 */
function previewConversion(ids) {
  var about = Drive.About.get({ fields: 'exportFormats' });
  var fmts = about.exportFormats || {};
  var out = { convertible: [], impossible: [], missing: 0 };

  (ids || []).slice(0, 2000).forEach(function (id) {
    var f;
    try {
      f = Drive.Files.get(id, { fields: 'id,name,mimeType,parents', supportsAllDrives: true });
    } catch (e) { out.missing++; return; }
    if (String(f.mimeType).indexOf('application/vnd.google-apps.') !== 0) return;
    var pick = chooseExport_(f.mimeType, fmts);
    if (pick) out.convertible.push({ id: f.id, name: f.name, as: pick.ext });
    else out.impossible.push({ id: f.id, name: f.name, kind: f.mimeType.slice(28) });
  });
  return out;
}

/**
 * Convert a batch. Returns `remaining` so the caller can drive it in chunks —
 * the same continuation pattern the scan uses, because one Apps Script call
 * cannot outlive six minutes and a Drive with hundreds of Docs will not fit.
 */
function convertNatives(ids) {
  var started = Date.now();
  var about = Drive.About.get({ fields: 'exportFormats' });
  var fmts = about.exportFormats || {};
  var token = ScriptApp.getOAuthToken();
  var done = [], skipped = [], failed = [], remaining = [];

  ids = ids || [];
  for (var i = 0; i < ids.length; i++) {
    if (Date.now() - started > CONVERT_BUDGET_MS) {
      remaining = ids.slice(i);
      break;
    }
    var id = ids[i];
    var f;
    try {
      f = Drive.Files.get(id, { fields: 'id,name,mimeType,parents', supportsAllDrives: true });
    } catch (e) {
      failed.push({ id: id, name: id, why: 'could not read the file: ' + e.message });
      continue;
    }

    var pick = chooseExport_(f.mimeType, fmts);
    if (!pick) {
      failed.push({ id: id, name: f.name, why: 'Google offers no export format for this type' });
      continue;
    }
    var newName = f.name + '.' + pick.ext;
    var parent = (f.parents && f.parents[0]) || null;
    if (!parent) {
      failed.push({ id: id, name: f.name, why: 'the file has no parent folder to write beside' });
      continue;
    }

    // Already converted on an earlier run — additive means never doing it twice.
    try {
      var q = "name = '" + String(newName).replace(/'/g, "\\'") + "' and '" +
              parent + "' in parents and trashed = false";
      var hit = Drive.Files.list({
        q: q, fields: 'files(id)', pageSize: 1,
        supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives'
      });
      if (hit.files && hit.files.length) {
        skipped.push({ id: id, name: newName, why: 'already converted' });
        continue;
      }
    } catch (e) { /* the check is an optimisation; a failure here is not fatal */ }

    /*
     * UrlFetchApp rather than DriveApp.getBlob(): getBlob() on a native returns
     * a PDF whatever the file is, so a Sheet would silently arrive as a PDF
     * instead of the .xlsx that was asked for. The export endpoint is the only
     * way to name the format.
     */
    var resp;
    try {
      resp = UrlFetchApp.fetch(
        'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) +
        '/export?mimeType=' + encodeURIComponent(pick.mime),
        { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
      );
    } catch (e) {
      failed.push({ id: id, name: f.name, why: 'export request failed: ' + e.message });
      continue;
    }

    var code = resp.getResponseCode();
    if (code !== 200) {
      var body = '';
      try { body = resp.getContentText().slice(0, 300); } catch (e2) { body = ''; }
      // 403 exportSizeLimitExceeded is the one everyone meets: Drive refuses to
      // export anything over roughly 10 MB, and no transport change avoids it.
      var why = /exportSizeLimitExceeded/.test(body)
        ? 'too large for Drive to export (Google caps native export at about 10 MB) — ' +
          'download it by hand from Google instead'
        : 'Drive refused the export (HTTP ' + code + ')';
      failed.push({ id: id, name: f.name, why: why });
      continue;
    }

    try {
      var blob = resp.getBlob().setName(newName);
      var created = Drive.Files.create(
        { name: newName, parents: [parent] }, blob, { supportsAllDrives: true }
      );
      done.push({ id: id, name: newName, newId: created.id, as: pick.ext });
    } catch (e) {
      failed.push({ id: id, name: f.name, why: 'could not save the converted file: ' + e.message });
    }
  }

  return { done: done, skipped: skipped, failed: failed, remaining: remaining };
}

// ─── trash (reversible only) ─────────────────────────────────────────────────
/**
 * Move files to Drive trash. Never a permanent delete — emptying the trash
 * stays a deliberate human action in the Drive UI.
 * Returns exactly what it did, per file, so the UI never has to assume.
 */
function trashFiles(ids) {
  ids = ids || [];
  if (!ids.length) return { trashed: [], failed: [], skipped: [] };

  var verified = getVerifiedIds();
  var gate = null;
  if (V_NAS_VERIFY) {
    gate = {};
    verified.ids.forEach(function (i) { gate[i] = true; });
  }

  var trashed = [], failed = [], skipped = [];
  ids.forEach(function (id) {
    if (gate && !gate[id]) { skipped.push({ id: id, reason: 'not confirmed on NAS' }); return; }
    try {
      Drive.Files.update({ trashed: true }, id, null, { supportsAllDrives: true });
      trashed.push(id);
    } catch (err) {
      failed.push({ id: id, reason: String(err && err.message || err) });
    }
  });
  return { trashed: trashed, failed: failed, skipped: skipped, gated: !!gate };
}

// ─── manifest export ─────────────────────────────────────────────────────────
/** Rows the QNAP agent (or a human running rclone) can act on directly. */
function buildManifestCsv(rows) {
  var head = ['drive_id', 'name', 'path', 'class', 'mime', 'bytes',
              'days_inactive', 'action', 'export_as', 'md5'];
  var esc = function (v) {
    v = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  var out = [head.join(',')];
  (rows || []).forEach(function (r) {
    out.push([r.id, r.name, r.path, r.cls, r.mime, r.bytes,
              r.days, r.action, r.exportAs || '', r.md5 || ''].map(esc).join(','));
  });
  return out.join('\n');
}

/** Native-file export target for the migration panel + rclone flags. */
function nativeExportTarget(mime) {
  if (mime.indexOf(NATIVE_PREFIX) !== 0) return null;
  var key = mime.slice(NATIVE_PREFIX.length);
  return EXPORT_MAP.hasOwnProperty(key) ? EXPORT_MAP[key] : null;
}
