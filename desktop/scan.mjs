/**
 * Local filesystem scanner, emitting EXACTLY the tuples Code.gs's scanChunk()
 * emits, so Dashboard.html and Treemap.html run unmodified.
 *
 *   [ id, parentId, name, kind, bytes, daysInactive, mimeIndex, md5 ]
 *
 * id/parentId are absolute paths rather than Drive file ids. They only have to
 * be unique and stable within one scan, which a path is.
 *
 * WHY A GENERATOR, NOT A RECURSIVE WALK THAT RETURNS AN ARRAY.
 * A volume can hold millions of entries. The Apps Script version is chunked
 * because of the 6-minute execution limit; here the limit is memory and the
 * renderer's willingness to hold one object per file. Yielding lets the caller
 * page results to the UI, keep the progress bar alive, and stop early.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const KIND_FOLDER = 0, KIND_BINARY = 1, KIND_NATIVE = 2, KIND_SHORTCUT = 3;

/*
  Google Drive for Desktop writes these as small JSON stubs holding a URL, not as
  documents. The Apps Script build classifies them from the MIME type; on disk the
  only signal is the extension. They matter for the same reason they do in the web
  app: copying one archives a dead link, and deleting one frees nothing real.
*/
const NATIVE_EXT = new Set([
  '.gdoc', '.gsheet', '.gslides', '.gform', '.gdraw', '.gmap', '.gsite', '.gjam', '.gscript',
]);
const SHORTCUT_EXT = new Set(['.lnk', '.url', '.desktop']);

const MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.mxf': 'application/mxf', '.r3d': 'video/x-red-r3d',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.psd': 'image/vnd.adobe.photoshop', '.exr': 'image/x-exr',
  '.raw': 'image/x-raw', '.cr2': 'image/x-canon-cr2', '.dng': 'image/x-adobe-dng',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.fbx': 'model/fbx',
  '.obj': 'model/obj', '.blend': 'application/x-blender', '.max': 'application/x-3dsmax',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.aiff': 'audio/aiff',
  '.unity': 'application/x-unity', '.apk': 'application/vnd.android.package-archive',
};

const DAY = 86400000;

export function classify(name, isDir) {
  if (isDir) return { kind: KIND_FOLDER, mime: 'application/vnd.google-apps.folder' };
  const ext = path.extname(name).toLowerCase();
  if (NATIVE_EXT.has(ext)) {
    return { kind: KIND_NATIVE, mime: 'application/vnd.google-apps' + ext.slice(1) };
  }
  if (SHORTCUT_EXT.has(ext)) {
    return { kind: KIND_SHORTCUT, mime: 'application/vnd.google-apps.shortcut' };
  }
  return { kind: KIND_BINARY, mime: MIME_BY_EXT[ext] || 'application/octet-stream' };
}

/**
 * Days since the file was last written. The web app uses viewedByMeTime and falls
 * back to modifiedTime; a local filesystem has no "last viewed by me", so mtime is
 * the only honest signal — and atime is unusable, because Windows and most Linux
 * mounts disable or coarsen it (relatime) and reading a file would poison it.
 */
export function daysSince(mtimeMs, now) {
  if (!mtimeMs) return -1;
  return Math.max(0, Math.floor((now - mtimeMs) / DAY));
}

/**
 * Walk `root`, yielding batches of tuples.
 *
 * Symlinks and junctions are NOT followed: on Windows especially they create
 * cycles and double-count, and the whole point of the map is that each byte is
 * counted once. They are reported as their own entry instead.
 */
export async function* walk(root, { batchSize = 2000, now = Date.now(), mimeIndex } = {}) {
  /*
    Normalise the root before anything else. ids and parent ids are paths, so the
    tree is built by string equality — and path.join() emits backslashes on
    Windows while a caller may well hand in "D:/foo". The two forms then name the
    same directory but never compare equal, and every top-level child becomes an
    orphan with no parent to attach to, which shows up as an empty treemap rather
    than as an error.
  */
  root = path.resolve(root);
  const mimes = mimeIndex || { list: [], ix: Object.create(null) };
  const mimeIdx = (m) => {
    if (mimes.ix[m] === undefined) { mimes.ix[m] = mimes.list.length; mimes.list.push(m); }
    return mimes.ix[m];
  };

  let batch = [];
  const stack = [{ dir: root, parent: '' }];

  // The root itself, so the tree has something to hang off.
  batch.push([root, '', path.basename(root) || root, KIND_FOLDER, 0, -1, mimeIdx('application/vnd.google-apps.folder'), '']);

  while (stack.length) {
    const { dir } = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // permission denied, vanished mid-walk, offline share — skip, do not abort
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        batch.push([full, dir, ent.name, KIND_SHORTCUT, 0, -1, mimeIdx('application/vnd.google-apps.shortcut'), '']);
        continue;
      }
      if (ent.isDirectory()) {
        batch.push([full, dir, ent.name, KIND_FOLDER, 0, -1, mimeIdx('application/vnd.google-apps.folder'), '']);
        stack.push({ dir: full, parent: dir });
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try { st = await fs.stat(full); } catch { continue; }
      const { kind, mime } = classify(ent.name, false);
      // A native stub occupies real bytes on disk but represents no real content,
      // so it is reported at 0 to match how the web app treats Drive quota.
      const bytes = kind === KIND_NATIVE ? 0 : st.size;
      batch.push([full, dir, ent.name, kind, bytes, daysSince(st.mtimeMs, now), mimeIdx(mime), '']);
      if (batch.length >= batchSize) { yield { items: batch, mimes: mimes.list.slice() }; batch = []; }
    }
  }
  if (batch.length) yield { items: batch, mimes: mimes.list.slice() };
}
