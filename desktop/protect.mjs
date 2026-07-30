/**
 * Classify a path as protected, so the app cannot bin something the machine needs.
 *
 *   'system'   never deletable — Windows itself, boot/recovery, a volume root,
 *              a user-profile root. Refused outright.
 *   'software' installed programs. Deleting these leaves an application half
 *              present and still registered as installed; the uninstaller is the
 *              correct tool, so the app points at it instead.
 *   'ok'       ordinary content.
 *
 * PURE AND ELECTRON-FREE ON PURPOSE. This is the one guard standing between a
 * mis-click and an unbootable machine, so it has to be unit-testable without
 * spawning a window. It is enforced in the MAIN process, not only in the UI —
 * a renderer-side check is a courtesy, not a guarantee.
 *
 * Matching is prefix-on-a-separator, never bare startsWith: "C:\\Windows" must
 * protect "C:\\Windows\\System32" without also protecting "C:\\WindowsApps-old".
 */

const WIN_SYSTEM = [
  'windows',                       // the OS itself
  'boot', 'efi', 'recovery',
  '$recycle.bin', 'system volume information',
  '$windows.~bt', '$windows.~ws',  // in-place upgrade staging
  'perflogs',
];

/* Files that only ever live at the root of a volume and are the OS's. */
const WIN_SYSTEM_FILES = [
  'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log', 'dumpstack.log.tmp',
  'bootmgr', 'bootnxt', 'ntldr', 'boot.ini', 'io.sys', 'msdos.sys',
];

const WIN_SOFTWARE = [
  'program files', 'program files (x86)', 'programdata',
];

const POSIX_SYSTEM = [
  '/system', '/library', '/usr', '/bin', '/sbin', '/etc', '/var', '/private',
  '/boot', '/dev', '/proc', '/sys', '/cores', '/volumes', '/users', '/home',
];
const POSIX_SOFTWARE = ['/applications', '/opt'];

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const lower = (p) => norm(p).toLowerCase();

/** True when `child` is `parent` or sits beneath it, on a separator boundary. */
export function isUnder(child, parent) {
  const c = lower(child), p = lower(parent);
  return c === p || c.startsWith(p + '/');
}

/** "C:" for a Windows path, '' otherwise. */
function driveOf(p) {
  const m = /^([a-z]):/i.exec(norm(p));
  return m ? m[1].toUpperCase() + ':' : '';
}

/**
 * @param {string} p absolute path
 * @param {{platform?: string, home?: string}} [opts]
 * @returns {{level: 'system'|'software'|'ok', why: string}}
 */
export function classifyPath(p, opts = {}) {
  const platform = opts.platform || process.platform;
  const raw = norm(p);
  if (!raw) return { level: 'system', why: 'Empty path.' };
  const low = raw.toLowerCase();

  if (platform === 'win32') {
    const drive = driveOf(raw);
    // A volume root. Trashing one is never what anybody meant.
    if (drive && (low === drive.toLowerCase() || low === drive.toLowerCase() + '/')) {
      return { level: 'system', why: 'That is a whole drive.' };
    }
    const rest = drive ? low.slice(drive.length + 1) : low;   // after "c:/"
    const first = rest.split('/')[0];
    const depth = rest ? rest.split('/').filter(Boolean).length : 0;

    if (depth === 1 && WIN_SYSTEM_FILES.indexOf(first) >= 0) {
      return { level: 'system', why: 'That is a Windows system file.' };
    }
    if (WIN_SYSTEM.indexOf(first) >= 0) {
      return { level: 'system', why: 'That is inside the Windows system folder.' };
    }
    // "C:\Users" and "C:\Users\someone" are roots; content below them is fair game.
    if (first === 'users' && depth <= 2) {
      return { level: 'system', why: 'That is a user profile root.' };
    }
    if (WIN_SOFTWARE.indexOf(first) >= 0) {
      return { level: 'software', why: 'That is an installed program.' };
    }
    // Per-user installs: ...\AppData\Local\Programs\<app>
    if (/\/appdata\/local\/programs(\/|$)/.test(low)) {
      return { level: 'software', why: 'That is an installed program.' };
    }
    // AppData itself is a profile root, not ordinary content.
    if (/\/appdata$/.test(low) || /\/appdata\/(local|roaming|locallow)$/.test(low)) {
      return { level: 'system', why: 'That is an application-data root.' };
    }
    return { level: 'ok', why: '' };
  }

  // POSIX
  if (low === '/' ) return { level: 'system', why: 'That is the root of the filesystem.' };
  for (const s of POSIX_SYSTEM) {
    if (isUnder(low, s)) {
      // /Volumes/<disk> and /Users/<name> are roots; deeper is ordinary.
      if ((s === '/volumes' || s === '/users' || s === '/home')) {
        const depth = low.split('/').filter(Boolean).length;
        if (depth > 2) continue;
      }
      return { level: 'system', why: 'That is a system location.' };
    }
  }
  for (const s of POSIX_SOFTWARE) {
    if (isUnder(low, s)) return { level: 'software', why: 'That is an installed application.' };
  }
  if (opts.home && (lower(opts.home) === low)) {
    return { level: 'system', why: 'That is your home folder.' };
  }
  return { level: 'ok', why: '' };
}
