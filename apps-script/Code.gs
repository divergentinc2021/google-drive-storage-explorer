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
var APP_VERSION = 'v28';

/*
 * The two desktop tools that finish the job this dashboard starts.
 *
 * They were mentioned only in a paragraph at the bottom of the Reclaimable
 * panel, which is below the fold on every screen — so the app that actually
 * performs the copy was, in the reporter's words, "practically unnoticeable".
 * They belong in the header beside this app's own version.
 *
 * Versions are constants because both repos are PRIVATE: the GitHub releases
 * API needs a token to read them, and putting one in an Apps Script that the
 * whole domain can open would be worse than a number that occasionally lags.
 * BUMP THESE ON RELEASE. The download links point at /releases/latest, which
 * always resolves, so a stale number here never produces a broken download.
 */
/*
 * ONE version string per app. The tag and the installer filename both carry the
 * version, so a direct download URL names it twice — and a link that repeats a
 * constant three times rots the first time somebody updates two of them.
 * siblingApps_() builds the URLs, so a release is one edit here.
 *
 * The download is the .exe itself rather than /releases/latest, because that
 * lands on the repo page and takes another click. The cost is that a stale
 * VERSION below now 404s instead of merely displaying wrong, so every card also
 * carries an "All releases" link that cannot go stale.
 */
var SIBLING_APPS_RAW = [
  {
    key: 'mapper',
    name: 'Mapper',
    full: 'Storage Mapper',
    version: '0.8.1',
    repo: 'divergentinc2021/storage-mapper',
    tagTpl: 'v{v}',
    assetTpl: 'Storage.Mapper.Setup.{v}.exe',
    readme: 'https://github.com/divergentinc2021/storage-mapper#readme',
    desc: 'Copies what this page identifies onto the NAS. Finds files already there ' +
          'under a different name, proves every file is readable before it starts, ' +
          'and never deletes anything.'
  },
  {
    key: 'desktop',
    name: 'Disk Explorer',
    full: 'Disk Storage Explorer',
    version: '0.6.0',
    repo: 'divergentinc2021/google-drive-storage-explorer',
    tagTpl: 'desktop-v{v}',
    assetTpl: 'DiskStorageExplorer-Setup-{v}.exe',
    readme: 'https://github.com/divergentinc2021/google-drive-storage-explorer/tree/DesktopVersion#readme',
    desc: 'This same treemap for local disks instead of Drive — your own machine, ' +
          'an external drive, or a colleague\'s. Right-click to bin, with Windows ' +
          'system and installed-program folders refused.'
  }
];

/*
 * GITHUB CANNOT BE THE DOWNLOAD CHANNEL, and the 404 proved it.
 *
 * Both repos are private, and GitHub answers a private release asset with 404
 * rather than 403 — it will not even admit the file exists. The URL was right;
 * it matched GitHub's own browser_download_url exactly. The audience is wrong:
 * the people clicking these chips are uwc.ac.za Google users, most of whom have
 * no GitHub account on this org at all. No amount of link-building fixes that.
 *
 * So the installer is served from Drive, which every one of them already has
 * and which this app already talks to. GitHub stays as a secondary link for
 * whoever does have repo access.
 *
 * publishInstaller() is owner-only and deliberate, exactly like publishFavicon:
 * it shares a file with the domain, and nothing here does that on its own.
 */
var PROP_INSTALLERS = 'SS_INSTALLERS';

function installers_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(PROP_INSTALLERS) || '{}'); }
  catch (e) { return {}; }
}

/**
 * Point a chip at an installer you have uploaded to Drive.
 *
 * Upload the .exe anywhere in your Drive, then run publishInstaller('mapper')
 * — it finds the file by the exact name the version implies, shares it with the
 * domain, and records it. Pass a file id as the second argument to skip the
 * search.
 *
 * Run again after every release: the filename carries the version, so a new
 * release needs the new .exe uploaded and this re-run.
 */
function publishInstaller(key, fileId) {
  if (!isOwner_()) throw new Error('Only ' + OWNERS.join(', ') + ' may publish installers.');
  var spec = null;
  SIBLING_APPS_RAW.forEach(function (a) { if (a.key === key) spec = a; });
  if (!spec) throw new Error('Unknown app: ' + key + '. Try ' +
    SIBLING_APPS_RAW.map(function (a) { return a.key; }).join(' or ') + '.');

  var wanted = spec.assetTpl.replace('{v}', spec.version);
  var file = null;
  if (fileId) {
    file = DriveApp.getFileById(fileId);
  } else {
    var it = DriveApp.getFilesByName(wanted);
    if (!it.hasNext()) {
      throw new Error('No file named "' + wanted + '" in your Drive. Upload the installer ' +
        'first, or pass its file id as the second argument.');
    }
    file = it.next();
    if (it.hasNext()) {
      throw new Error('More than one file named "' + wanted + '" — pass the file id you mean.');
    }
  }

  file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  var all = installers_();
  all[key] = { id: file.getId(), version: spec.version, name: file.getName() };
  PropertiesService.getScriptProperties().setProperty(PROP_INSTALLERS, JSON.stringify(all));
  return { ok: true, key: key, file: file.getName(), id: file.getId(),
           url: 'https://drive.google.com/file/d/' + file.getId() + '/view' };
}

/*
 * The newest release, straight from GitHub.
 *
 * Both repos are public now, so this needs no token — which is what makes it
 * possible at all. The version, the tag and the installer filename all come
 * from the release itself, so a new release needs no edit here: the constants
 * below are only the fallback for when GitHub cannot be reached.
 *
 * Cached for six hours because unauthenticated GitHub allows 60 requests an
 * hour PER IP, and Apps Script egresses through addresses shared with every
 * other script Google runs. Without the cache a busy hour would start failing
 * for reasons nothing here controls.
 */
function latestRelease_(repo) {
  var cache = CacheService.getScriptCache();
  var key = 'gh:' + repo;
  var hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* refetch */ } }

  try {
    var resp = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/releases/latest', {
      muteHttpExceptions: true,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'storage-explorer' }
    });
    if (resp.getResponseCode() !== 200) return null;
    var rel = JSON.parse(resp.getContentText());
    var exe = (rel.assets || []).filter(function (x) { return /\.exe$/i.test(x.name); })[0];
    if (!exe) return null;
    var out = {
      version: String(rel.tag_name || '').replace(/^.*?v/, ''),
      tag: rel.tag_name,
      asset: exe.name,
      url: exe.browser_download_url
    };
    cache.put(key, JSON.stringify(out), 21600);   // 6 hours
    return out;
  } catch (e) {
    return null;   // offline, rate-limited, or renamed — fall back to the constants
  }
}

function siblingApps_() {
  var pub = installers_();
  return SIBLING_APPS_RAW.map(function (a) {
    var live = latestRelease_(a.repo);
    if (live && live.version) a = {
      key: a.key, name: a.name, full: a.full, desc: a.desc, repo: a.repo,
      readme: a.readme, tagTpl: a.tagTpl, assetTpl: a.assetTpl,
      version: live.version
    };
    var tag = live ? live.tag : a.tagTpl.replace('{v}', a.version);
    var asset = live ? live.asset : a.assetTpl.replace('{v}', a.version);
    var mine = pub[a.key];
    /*
     * Only trust a published installer that matches the version being
     * advertised. After a release the constant moves first and the upload
     * follows, and serving last release's .exe under this release's number
     * would be worse than sending someone to GitHub.
     */
    var fresh = mine && mine.version === a.version ? mine : null;
    return {
      key: a.key, name: a.name, full: a.full, desc: a.desc,
      version: 'v' + a.version,
      asset: asset,
      live: !!live,
      // GitHub first: the repos are public, so this works for everyone with no
      // account and nothing to maintain. The Drive copy stays as an override
      // for a network that cannot reach github.com.
      download: live ? live.url
        : 'https://github.com/' + a.repo + '/releases/download/' + tag + '/' + asset,
      drive: fresh ? 'https://drive.google.com/file/d/' + fresh.id + '/view' : '',
      releases: 'https://github.com/' + a.repo + '/releases',
      readme: a.readme
    };
  });
}
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
/*
 * The tab icon, and why this is not simply a <link rel="icon">.
 *
 * An Apps Script web app is served inside a sandboxed iframe, so the tab icon
 * comes from the OUTER script.google.com page, not from Index.html. A link tag
 * in the served markup is ignored, and setFaviconUrl() is the only lever.
 *
 * setFaviconUrl wants an http(s) URL. The previous version passed a data: URI,
 * which is undocumented and, in practice, ignored — the tab kept Google's
 * generic Apps Script icon, which is what was reported. The repo is private, so
 * a raw.githubusercontent URL would 404 for the browser fetching the icon.
 *
 * So the script publishes the icon into Drive and serves it from Google's own
 * image CDN. publishFavicon() is a deliberate, owner-only action because it
 * makes one file link-readable. Nothing here shares anything on its own, and
 * the app works without it — the tab simply keeps Google's icon.
 */
var PROP_FAVICON = 'SS_FAVICON_FILE_ID';
var FAVICON_NAME = 'storage-explorer-favicon.png';
var FAVICON_B64 = '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';

/**
 * Publish (or re-publish) the tab icon. Run once from the Apps Script editor,
 * signed in as an owner. Returns the URL it will be served from.
 *
 * Defaults to DOMAIN sharing: everyone who can open this app is already a
 * uwc.ac.za user, so the icon need not be readable by the whole internet. Pass
 * 'anyone' only if the tab still shows Google's icon afterwards, which would
 * mean the CDN is not serving a domain-restricted image to an unauthenticated
 * favicon request.
 */
function publishFavicon(access) {
  if (!isOwner_()) throw new Error('Only ' + OWNERS.join(', ') + ' may publish the icon.');
  var props = PropertiesService.getScriptProperties();
  var blob = Utilities.newBlob(Utilities.base64Decode(FAVICON_B64), 'image/png', FAVICON_NAME);

  var id = props.getProperty(PROP_FAVICON), file = null;
  if (id) { try { file = DriveApp.getFileById(id); } catch (e) { file = null; id = null; } }

  if (file) {
    // Replacing the BYTES needs the advanced service; DriveApp.setContent is
    // text-only and would write the base64 as a string into a .png.
    Drive.Files.update({}, file.getId(), blob);
  } else {
    file = DriveApp.createFile(blob);
    props.setProperty(PROP_FAVICON, file.getId());
  }

  var who = (access === 'anyone')
    ? DriveApp.Access.ANYONE_WITH_LINK
    : DriveApp.Access.DOMAIN_WITH_LINK;
  file.setSharing(who, DriveApp.Permission.VIEW);
  return { ok: true, fileId: file.getId(), access: String(who), url: faviconUrl_() };
}

/** Google's image CDN for that Drive file. Empty until publishFavicon has run. */
function faviconUrl_() {
  var id = PropertiesService.getScriptProperties().getProperty(PROP_FAVICON);
  return id ? 'https://lh3.googleusercontent.com/d/' + id + '=w64-h64' : '';
}

function doGet() {
  var out = HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Google Drive Storage Explorer')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  try {
    var ico = faviconUrl_();
    if (ico) out.setFaviconUrl(ico);
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
    siblingApps: siblingApps_(),
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
/*
 * Apps Script kills a call at 6 minutes, so a batch has to return before then.
 * 90 seconds rather than 4.5 minutes: a single call cannot report progress
 * while it runs, so the batch length IS the update interval, and the first
 * screen sat on "0 of 161 done" long enough to look hung. Shorter batches cost
 * a few more round trips and buy visible movement.
 */
var CONVERT_BUDGET_MS = 90 * 1000;

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
    'application/zip': 'zip', 'video/mp4': 'mp4', 'text/html': 'html',
    // Rungs on the size-fallback ladder. Missing entries are not cosmetic:
    // an unmapped format is dropped from the candidate list, so a Doc too big
    // as .docx skipped straight past .rtf. Found by the ladder test.
    'application/rtf': 'rtf', 'text/rtf': 'rtf',
    'text/tab-separated-values': 'tsv', 'application/epub+zip': 'epub',
    'application/x-vnd.oasis.opendocument.spreadsheet': 'ods'
  };
  return MAP[mime] || null;
}

/**
 * Which export Google offers for this native type, preferring the format worth
 * keeping. Returns null when Google offers none — in which case the file simply
 * cannot be converted and saying so is the only honest answer.
 */
/*
 * Every format Google offers for this type, best first.
 *
 * A LIST rather than one choice, because Drive refuses to export anything over
 * roughly 10 MB and the limit applies to the produced file — so a Doc too big
 * as .docx often fits as .pdf, and nearly always as .txt. Giving up at the
 * first refusal threw away files that were perfectly exportable in a lighter
 * format. The order is "most faithful first", so a fallback is only ever
 * reached after the better one has actually been refused.
 */
function exportCandidates_(mime, exportFormats) {
  var offered = exportFormats[mime] || [];
  var PREF = {
    'application/vnd.google-apps.document': ['docx', 'odt', 'rtf', 'pdf', 'txt'],
    'application/vnd.google-apps.spreadsheet': ['xlsx', 'ods', 'csv', 'tsv'],
    'application/vnd.google-apps.presentation': ['pptx', 'odp', 'pdf', 'txt'],
    'application/vnd.google-apps.drawing': ['svg', 'png', 'pdf', 'jpg'],
    'application/vnd.google-apps.script': ['json'],
    'application/vnd.google-apps.jam': ['pdf'],
    'application/vnd.google-apps.site': ['txt', 'html'],
    'application/vnd.google-apps.form': ['zip'],
    'application/vnd.google-apps.vid': ['mp4']
  };
  var byExt = {};
  offered.forEach(function (m) {
    var e = extForMime_(m);
    if (e && !byExt[e]) byExt[e] = m;
  });
  var out = [], seen = {};
  (PREF[mime] || []).forEach(function (e) {
    if (byExt[e]) { out.push({ mime: byExt[e], ext: e }); seen[e] = 1; }
  });
  Object.keys(byExt).forEach(function (e) {
    if (!seen[e]) out.push({ mime: byExt[e], ext: e });
  });
  return out;
}

function chooseExport_(mime, exportFormats) {
  var c = exportCandidates_(mime, exportFormats);
  return c.length ? c[0] : null;
}

/*
 * The type to UPLOAD the result as, which is not always the type it was
 * exported as. Apps Script exports with mime application/vnd.google-apps.script
 * +json, and Drive refuses to create a file from uploaded content carrying any
 * google-apps type — "Invalid MIME type provided for the uploaded content".
 * Eight Sites and Apps Script projects failed exactly there. Deriving the
 * upload type from the EXTENSION keeps it to types Drive will accept.
 */
/*
 * Take ownership by copying, export the copy, then bin the copy.
 *
 * The temporary copy is ALWAYS trashed, including when the export of it fails,
 * because a half-finished workaround that litters someone's Drive with
 * "(temporary export copy)" files is worse than the failure it was working
 * around. Trashed rather than permanently deleted — this tool never destroys.
 */
function exportViaCopy_(f, cand, token, parent, candName) {
  var copyId = null;
  try {
    var copy = Drive.Files.copy(
      { name: f.name + ' (temporary export copy)', parents: [parent] },
      f.id, { supportsAllDrives: true }
    );
    copyId = copy.id;

    var resp = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(copyId) +
      '/export?mimeType=' + encodeURIComponent(cand.mime),
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
    );
    if (resp.getResponseCode() !== 200) {
      var b = '';
      try { b = resp.getContentText().slice(0, 300); } catch (e2) { b = ''; }
      return { id: null, why: 'copied it to get ownership, but Drive still refused the export — ' +
                             explainDriveError_(resp.getResponseCode(), b) };
    }
    var blob = resp.getBlob().setName(candName).setContentType(uploadMimeFor_(cand.ext));
    var made = Drive.Files.create({ name: candName, parents: [parent] }, blob,
                                  { supportsAllDrives: true });
    return { id: made.id, why: '' };
  } catch (e) {
    return { id: null, why: 'could not copy it to take ownership: ' + e.message };
  } finally {
    if (copyId) {
      try { Drive.Files.update({ trashed: true }, copyId, null, { supportsAllDrives: true }); }
      catch (e3) { /* the export already succeeded or failed; a stray copy is not fatal */ }
    }
  }
}

/**
 * Who to go and ask. A refusal on a file you do not own has a person attached
 * to it, and naming them turns a dead end into a next step.
 */
function whoOwns_(f) {
  if (!f || f.ownedByMe) return '';
  var who = (f.owners && f.owners[0] && f.owners[0].emailAddress) || '';
  var extra = who ? ' It belongs to ' + who + '.' : ' You do not own it.';
  if (f.capabilities && f.capabilities.canDownload === false) {
    extra += ' The owner has turned off downloading, which blocks export too.';
  }
  return extra;
}

/** Turn Drive's JSON error body into something a person can act on. */
function explainDriveError_(code, body) {
  var reason = '', message = '';
  try {
    var j = JSON.parse(body);
    var err = j.error || {};
    message = err.message || '';
    if (err.errors && err.errors.length) reason = err.errors[0].reason || '';
  } catch (e) { /* not JSON; fall back to the raw status below */ }

  var SAY = {
    cannotExportFile: 'Google will not export this particular file, even though it exports ' +
                      'others of its type. Open it and use File → Download instead.',
    fileNotExportable: 'this file cannot be exported at all — open it and use File → Download.',
    insufficientFilePermissions: 'you have read access but not enough to export it. Ask the ' +
                                 'owner, or open it and use File → Download.',
    forbidden: 'access was refused. If it belongs to someone else, ask them to export it.',
    rateLimitExceeded: 'too many requests too quickly. Run Convert again in a few minutes — ' +
                       'everything already done will be skipped.',
    userRateLimitExceeded: 'this account hit a Drive rate limit. Run Convert again shortly; ' +
                           'completed files are skipped.',
    notFound: 'Drive can no longer find it — it may have been moved or trashed mid-run.'
  };
  if (SAY[reason]) return SAY[reason];
  if (message) return message + ' (HTTP ' + code + (reason ? ', ' + reason : '') + ')';
  /*
   * No reason and no message means the body was not the JSON shape expected —
   * an HTML error page, or empty. Carry a slice of it rather than flattening to
   * a bare status: "HTTP 403" told us nothing about the one file that survived
   * a whole-drive run, and there was no way to find out more from the screen.
   */
  var raw = String(body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (raw) return 'HTTP ' + code + ' — Google said: ' + raw.slice(0, 140);
  return 'HTTP ' + code + ' with no explanation from Google';
}

function uploadMimeFor_(ext) {
  var M = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    pdf: 'application/pdf', csv: 'text/csv', tsv: 'text/tab-separated-values',
    txt: 'text/plain', rtf: 'application/rtf', html: 'text/html',
    tsv: 'text/tab-separated-values', epub: 'application/epub+zip',
    json: 'application/json', zip: 'application/zip',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', mp4: 'video/mp4'
  };
  return M[ext] || 'application/octet-stream';
}

/**
 * What WOULD be converted, without converting anything.
 *
 * Separate from the run on purpose: this writes files into someone's Drive, and
 * the first thing anyone should be able to do is see the list.
 */
/*
 * How many are ALREADY converted.
 *
 * Without this the banner counts Google-native files in the scan, which never
 * goes down: converting produces a new file beside the original and leaves the
 * original exactly where it was. So after converting 160 of 161 the dashboard
 * still announced 161 to convert, and the button still offered to do all of
 * them — the work was invisible, and the only way to discover it had happened
 * was to start another run and read "already done".
 *
 * The destination tree is walked once and reduced to a set of names, rather
 * than asking Drive about each file in turn: one query per folder beats one per
 * file, and the tree is shallow because it mirrors folders that hold natives.
 */
/*
 * Every file name already sitting in the conversion tree.
 *
 * Shared by conversionStatus and previewConversion so the two cannot disagree.
 * They did: the tile said "Convert 1" from conversionStatus while the dialog
 * said "161 will be converted", because the preview had no idea what was
 * already done and queued everything. The run then re-walked 161 files to skip
 * 160 of them, and reported progress against the wrong denominator.
 *
 * Returns null when the conversion folder does not exist yet — meaning nothing
 * has ever been converted, which is different from "checked and found nothing".
 */
function convertedNameSet_() {
  var myRoot;
  try { myRoot = Drive.Files.get('root', { fields: 'id' }).id; }
  catch (e) { return null; }

  var q = "name = '" + CONVERT_ROOT_NAME + "' and '" + myRoot + "' in parents and " +
          "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  var root;
  try {
    var hit = Drive.Files.list({ q: q, fields: 'files(id)', pageSize: 1, supportsAllDrives: true });
    root = hit.files && hit.files.length ? hit.files[0].id : null;
  } catch (e) { return null; }
  if (!root) return {};

  var have = {}, queue = [root], guard = 0;
  while (queue.length && guard++ < 400) {
    var folder = queue.shift(), tok = null;
    do {
      var page;
      try {
        page = Drive.Files.list({
          q: "'" + folder + "' in parents and trashed = false",
          fields: 'nextPageToken,files(id,name,mimeType)', pageSize: 1000,
          pageToken: tok || undefined, supportsAllDrives: true
        });
      } catch (e) { break; }
      (page.files || []).forEach(function (x) {
        if (x.mimeType === MIME_FOLDER) queue.push(x.id);
        else have[x.name] = 1;
      });
      tok = page.nextPageToken || null;
    } while (tok);
  }
  return have;
}

/**
 * Just the names already in the conversion tree.
 *
 * The client can do the comparison itself: the scan already carries every
 * native's name and mimeType, so asking Drive for them again — 161 round trips
 * in conversionStatus — was work that had already been done. Returning the name
 * list instead means the check needs nothing from the scan, so it can be fired
 * at the same moment the scan starts and be waiting by the time it ends.
 */
function convertedNames() {
  var have = convertedNameSet_();
  if (have === null) return { checked: false, names: [] };
  return { checked: true, names: Object.keys(have) };
}

function conversionStatus(ids) {
  var out = { converted: 0, pending: 0, checked: false, names: 0 };
  var have = convertedNameSet_();
  if (have === null) return out;
  out.names = Object.keys(have).length;
  out.checked = true;

  var about = Drive.About.get({ fields: 'exportFormats' });
  var fmts = about.exportFormats || {};
  (ids || []).forEach(function (id) {
    var n = null;
    try { n = Drive.Files.get(id, { fields: 'name,mimeType', supportsAllDrives: true }); }
    catch (e) { return; }
    var cands = exportCandidates_(n.mimeType, fmts);
    if (!cands.length) return;                       // not convertible; not pending either
    var done = cands.some(function (c) { return have[n.name + '.' + c.ext]; });
    if (done) out.converted++; else out.pending++;
  });
  return out;
}

/**
 * What a run would actually do. `convertible` is the QUEUE — only what is left
 * — so the dialog, the progress denominator and the work all agree.
 */
function previewConversion(ids) {
  var about = Drive.About.get({ fields: 'exportFormats' });
  var fmts = about.exportFormats || {};
  var have = convertedNameSet_() || {};
  var out = { convertible: [], impossible: [], alreadyDone: 0, missing: 0 };

  (ids || []).slice(0, 2000).forEach(function (id) {
    var f;
    try {
      f = Drive.Files.get(id, { fields: 'id,name,mimeType,parents', supportsAllDrives: true });
    } catch (e) { out.missing++; return; }
    if (String(f.mimeType).indexOf('application/vnd.google-apps.') !== 0) return;
    var cands = exportCandidates_(f.mimeType, fmts);
    if (!cands.length) {
      out.impossible.push({ id: f.id, name: f.name, kind: f.mimeType.slice(28) });
      return;
    }
    if (cands.some(function (c) { return have[f.name + '.' + c.ext]; })) { out.alreadyDone++; return; }
    out.convertible.push({ id: f.id, name: f.name, as: cands[0].ext });
  });
  return out;
}

/**
 * Convert a batch. Returns `remaining` so the caller can drive it in chunks —
 * the same continuation pattern the scan uses, because one Apps Script call
 * cannot outlive six minutes and a Drive with hundreds of Docs will not fit.
 */
/*
 * WHERE THE CONVERTED FILE GOES — and this was wrong in v11/v13.
 *
 * It used to be written beside the original, argued for because the NAS mirror
 * path would then already be correct. That only holds for files you OWN. Run
 * against "Everything I can see" and most originals live in other people's
 * Drives, which produced exactly three failures and no successes:
 *
 *   "the file has no parent folder to write beside"   — shared with you, no
 *                                                       visible parent
 *   "Insufficient permissions for the specified parent" — readable, not writable
 *   and even where it would have worked, Drive for Desktop does not sync other
 *   people's folders, so the output could never have reached the NAS anyway.
 *
 * Everything now goes into one folder in YOUR My Drive, mirroring the original's
 * path underneath it. You always have write permission there, it always syncs
 * down, and no one else's Drive is touched. The mirrored path keeps the NAS
 * layout meaningful, which was the only real argument for writing in place.
 */
var CONVERT_ROOT_NAME = '_Converted for NAS';

function findOrCreateFolder_(name, parentId, cache) {
  var key = parentId + '/' + name;
  if (cache[key]) return cache[key];
  var q = "name = '" + String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'") +
          "' and '" + parentId + "' in parents and " +
          "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  try {
    var hit = Drive.Files.list({ q: q, fields: 'files(id)', pageSize: 1, supportsAllDrives: true });
    if (hit.files && hit.files.length) { cache[key] = hit.files[0].id; return cache[key]; }
  } catch (e) { /* fall through and create */ }
  var made = Drive.Files.create({
    name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId]
  }, null, { supportsAllDrives: true });
  cache[key] = made.id;
  return made.id;
}

/**
 * The original's folder names, outermost first. Best effort: a file shared from
 * elsewhere may expose no readable parent, in which case it lands directly in
 * the conversion root rather than failing — the point is to produce the file.
 */
function pathSegmentsFor_(file, nameCache) {
  var segs = [], cur = file, guard = 0;
  while (guard++ < 20) {
    var pid = cur.parents && cur.parents[0];
    if (!pid) break;
    if (nameCache[pid] === null) break;                  // known unreadable
    if (nameCache[pid] === undefined) {
      try {
        nameCache[pid] = Drive.Files.get(pid, {
          fields: 'id,name,parents,driveId', supportsAllDrives: true
        });
      } catch (e) { nameCache[pid] = null; break; }
    }
    var p = nameCache[pid];
    if (!p || !p.name) break;
    segs.unshift(p.name);
    cur = p;
  }
  return segs;
}

function convertNatives(ids) {
  var started = Date.now();
  var about = Drive.About.get({ fields: 'exportFormats' });
  var fmts = about.exportFormats || {};
  var token = ScriptApp.getOAuthToken();
  var done = [], skipped = [], failed = [], remaining = [];

  var myRoot = Drive.Files.get('root', { fields: 'id' }).id;
  var folderCache = {}, parentCache = {};
  var convRoot = findOrCreateFolder_(CONVERT_ROOT_NAME, myRoot, folderCache);

  ids = ids || [];
  for (var i = 0; i < ids.length; i++) {
    if (Date.now() - started > CONVERT_BUDGET_MS) {
      remaining = ids.slice(i);
      break;
    }
    var id = ids[i];
    var f;
    try {
      /*
       * ownedByMe and capabilities come along because "Drive refused" is not an
       * answer anyone can act on. A refusal on someone else's file means ask
       * them; on your own it means something else entirely, and the difference
       * is only visible here.
       */
      f = Drive.Files.get(id, {
        fields: 'id,name,mimeType,parents,ownedByMe,owners(emailAddress),capabilities(canDownload,canCopy)',
        supportsAllDrives: true
      });
    } catch (e) {
      failed.push({ id: id, name: id, why: 'could not read the file: ' + e.message });
      continue;
    }

    var candidates = exportCandidates_(f.mimeType, fmts);
    if (!candidates.length) {
      failed.push({ id: id, name: f.name, why: 'Google offers no export format for this type' });
      continue;
    }
    var newName = f.name + '.' + candidates[0].ext;

    // Mirror the original's folders under the conversion root, in My Drive.
    var parent;
    try {
      var segs = pathSegmentsFor_(f, parentCache);
      parent = convRoot;
      for (var s = 0; s < segs.length; s++) parent = findOrCreateFolder_(segs[s], parent, folderCache);
    } catch (e) {
      failed.push({ id: id, name: f.name, why: 'could not prepare a destination folder: ' + e.message });
      continue;
    }

    /*
     * Already converted on an earlier run — additive means never doing it twice.
     * Scoped to the destination folder. The previous version searched with
     * corpora:'allDrives', which reported 110 files as "already done" while not
     * one converted copy existed; a check that can produce a false positive is
     * worse than no check, because it silently skips real work.
     */
    try {
      // Every candidate name, not just the preferred one: an earlier run may
      // have fallen back to a lighter format, and looking only for the best one
      // would convert it a second time.
      var esc = function (v) { return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); };
      var names = candidates.map(function (cc) { return "name = '" + esc(f.name + '.' + cc.ext) + "'"; });
      var q = '(' + names.join(' or ') + ") and '" + parent + "' in parents and trashed = false";
      var hit = Drive.Files.list({ q: q, fields: 'files(id,name)', pageSize: 1, supportsAllDrives: true });
      if (hit.files && hit.files.length) {
        skipped.push({ id: id, name: hit.files[0].name, why: 'already converted' });
        continue;
      }
    } catch (e) { /* the check is an optimisation; a failure here is not fatal */ }

    /*
     * UrlFetchApp rather than DriveApp.getBlob(): getBlob() on a native returns
     * a PDF whatever the file is, so a Sheet would silently arrive as a PDF
     * instead of the .xlsx that was asked for. The export endpoint is the only
     * way to name the format.
     */
    /*
     * Try each format Google offers, best first, and step down on a size
     * refusal. A Doc too large as .docx frequently fits as .pdf and nearly
     * always as .txt — stopping at the first refusal discarded files that were
     * exportable, just not in the nicest format.
     */
    var lastWhy = 'Drive refused the export';
    var savedName = null, savedExt = null, savedId = null, tooBig = false;

    for (var c = 0; c < candidates.length && !savedId; c++) {
      var cand = candidates[c];
      var candName = f.name + '.' + cand.ext;
      var resp;
      try {
        resp = UrlFetchApp.fetch(
          'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) +
          '/export?mimeType=' + encodeURIComponent(cand.mime),
          { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
        );
      } catch (e) { lastWhy = 'export request failed: ' + e.message; continue; }

      var code = resp.getResponseCode();
      if (code !== 200) {
        var body = '';
        try { body = resp.getContentText().slice(0, 300); } catch (e2) { body = ''; }
        if (/exportSizeLimitExceeded/.test(body)) {
          tooBig = true;
          lastWhy = 'too large for Drive to export in any offered format ' +
                    '(Google caps native export at about 10 MB) — download it by hand from Google';
          continue;   // a lighter format may still fit
        }
        /*
         * Say what Google objected to, not just the status. "HTTP 403" covers
         * "you may only read this file", "this type cannot be exported at all"
         * and "you are going too fast" — three different problems with three
         * different answers, and the reason code distinguishes them.
         */
        /*
         * A PERMISSION refusal is not the end of it.
         *
         * "The user does not have sufficient permissions for this file" means
         * you may read someone else's file but not export it. Copying it makes
         * YOU the owner of the copy, and you can always export your own file —
         * so copy, export the copy, then bin the copy.
         *
         * Note this is the opposite conclusion to the stub question, and both
         * are right: copying does not help when the problem is that a native
         * has no bytes, because the copy is another native. It helps here
         * because the problem is ownership, and a copy changes exactly that.
         *
         * Only when Drive says copying is allowed. An owner who disabled
         * copy/download has made a decision this tool should not route around.
         */
        var permissionProblem = /insufficientFilePermissions|does not have sufficient permissions/i.test(body);
        if (permissionProblem && f.capabilities && f.capabilities.canCopy !== false) {
          var viaCopy = exportViaCopy_(f, cand, token, parent, candName);
          if (viaCopy.id) {
            savedId = viaCopy.id; savedName = candName; savedExt = cand.ext;
            viaCopy.copied = true;
            break;
          }
          lastWhy = viaCopy.why + whoOwns_(f);
          continue;
        }
        lastWhy = 'Drive refused the export — ' + explainDriveError_(code, body) + whoOwns_(f);
        continue;
      }

      try {
        // setContentType, not the response's own type — see uploadMimeFor_.
        var blob = resp.getBlob().setName(candName).setContentType(uploadMimeFor_(cand.ext));
        var created = Drive.Files.create(
          { name: candName, parents: [parent] }, blob, { supportsAllDrives: true }
        );
        savedId = created.id; savedName = candName; savedExt = cand.ext;
      } catch (e) {
        lastWhy = 'could not save the converted file: ' + e.message;
      }
    }

    if (savedId) {
      done.push({ id: id, name: savedName, newId: savedId, as: savedExt,
                  fellBack: savedExt !== candidates[0].ext ? candidates[0].ext : null });
    } else {
      failed.push({ id: id, name: f.name, why: lastWhy, tooBig: tooBig });
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
