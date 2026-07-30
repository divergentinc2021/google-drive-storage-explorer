# Disk Storage Explorer — desktop build

The same treemap, pointed at a mounted volume — internal disk, external drive,
SD card, network share, or a Google Drive mount — instead of the Drive API.

## Why this is not a wrapper around the web app

The obvious build � an Electron window loading the deployed `/exec` URL � does
not work. **Google blocks OAuth sign-in inside embedded webviews**
(`disallowed_useragent`), so the window reaches the Google login screen and stops
there. Workarounds exist (spoof the user agent, or bounce auth through the system
browser) but they are against policy and break without warning.

Swapping the backend avoids the problem completely: **this build never
authenticates with anything.** It reads a filesystem.

## How little code that took

`Dashboard.html` reaches its backend through exactly five calls:

```
getBootstrap · scanChunk · measureDriveChunk · buildManifestCsv · trashFiles
```

`preload.cjs` exposes a `google.script.run` object of the same shape backed by
IPC, so `Index/Styles/Treemap/Dashboard.html` run **unmodified** � the same bytes
the web app deploys. `tools/build_preview.mjs` had already proved the contract was
small enough to reimplement; it has been driving the UI from synthetic data all
along. This is that mock with a filesystem behind it.

`build-ui.mjs` assembles `ui/index.html` from `../apps-script` at build time, so
every treemap fix made for the web app lands here on the next build. There is no
forked copy of the renderer.

## What maps, and what does not

| Web app | Desktop |
|---|---|
| Drive quota | volume total / free via `statfs` |
| `quotaBytesUsed` | `stat().size` |
| last viewed by me | `mtime` � see below |
| Google-native stubs | `.gdoc` / `.gsheet` / ⬦ on a Drive mount, still detected |
| shared drives | hidden � no equivalent |
| trash (`trashed: true`) | `shell.trashItem` �  OS Recycle Bin |
| open in Drive | reveal in File Explorer |
| `md5Checksum` from the API | **empty** � see below |

**Activity uses `mtime`, not access time.** Windows and most Linux mounts disable
or coarsen `atime` (`relatime`), and reading a file to scan it would poison the
very signal being measured. `mtime` is the only honest answer available locally.

**No checksums.** The Drive API hands out `md5Checksum` for free; locally it would
mean reading every byte of every file. On a Drive mount in Stream mode that would
also *download the entire Drive*. Left empty deliberately.

## Run it

```bash
cd desktop
npm install
node node_modules/electron/install.js   # npm 11 gates this postinstall
npm start
```

## Build an installer

```bash
npm run dist
```

## Release

Tagging `desktop-v<version>` runs `.github/workflows/desktop-release.yml`, which
checks the tag against `package.json`, rebuilds the UI from `apps-script/`, builds
the NSIS installer and publishes it.

The tag namespace is deliberately **not** plain `v*`: that namespace belongs to
the Apps Script web app and its 200 lifetime deployment versions. Two products in
one repo, two namespaces, no collisions. The prune step only ever touches
`desktop-v*` releases for the same reason.

## Known limits

- **Memory on very large volumes.** The renderer holds one object per file, which
  is fine for a project share and not fine for a whole system drive with millions
  of entries. The 1 MB fold (`dsFoldSmall`) collapses small files, but only after
  the array exists. Aggregating during the walk is the fix if this bites.
- **Symlinks and junctions are not followed.** They create cycles and double
  counting, and the map's whole premise is that each byte is counted once. They
  appear as their own entry instead.
- **Permission-denied directories are skipped silently.** A scan of `C:\` will
  quietly omit parts of `Windows` and other users' profiles.

