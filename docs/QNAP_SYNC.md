# Syncing Google Drive (studiouih@uwc.ac.za) to the QNAP

## The constraint that shapes everything

Apps Script runs on Google's servers, on the public internet. The QNAP sits
behind the UWC firewall on a private address (here `172.19.44.33`).
**Google's servers can never open a connection to it.** `UrlFetchApp` reaches
public URLs only — there is no SMB, no NFS, no filesystem.

So the sync engine cannot live in Apps Script. It has to run *on the NAS*, and
the NAS is always the side that reaches out. Apps Script is the dashboard, the
inventory and the config store; the QNAP does the copying.

```
Apps Script (dashboard)          QNAP (agent + rclone)              Google Drive
──────────────────────           ─────────────────────              ────────────
config ──── GET  ?action=config ──►  {mappings, retention}
                                     rclone sync ──────────────────► pulls down
inventory + treemap ◄── POST action=report ── walks NAS, hashes
gated trash
```

---

## The actual hardware (surveyed 2026-07-28)

`UIZ-NAS` at `172.19.44.33:8080` — **QNAP TS-431K**, Annapurna Alpine AL214
(**ARM Cortex-A15, 32-bit ARMv7**), **1 GB RAM**, QTS 5.2.3.3006. Volume
`Database` 9.56 TB, 0.57 TB used → **~9 TB free**. 3 of 4 bays populated.
Shares: `AdminResources`, `Projects`, `Public`, `Resources`, `Staff back-up`.
SSH (port 22) is **closed**.

Two constraints follow, and they overturn the original plan:

- **Container Station is NOT available on this model.** Verified in App Center →
  Developer Tools, which offers only JRE, PHP Extensions, phpMyAdmin and Python3.
  Any "run rclone in Docker" plan is dead on this hardware.
- **1 GB RAM.** `--fast-list` buffers the *entire* remote listing in memory before
  transferring; on a large Drive that is an OOM on this box. Do not use it here,
  and keep `--transfers`/`--checkers` low.

## Option A — HBS 3 Hybrid Backup Sync (recommended for this NAS)

Native QNAP app, available in App Center → Backup/Sync for the TS-431K, with a
Google Drive connector. No Docker, no shell, survives firmware updates.

App Center → Backup/Sync → **HBS 3 Hybrid Backup Sync** → Install → Sync →
one-way → Google Drive → sign in as studiouih.

**Verify at job-creation time:** that the job converts Google-native files to
Office formats (the equivalent of rclone's `--drive-export-formats`). Without it,
Docs/Sheets/Slides land as useless link stubs. This is the one functional
requirement that decides whether HBS 3 is sufficient.

**Trade-off:** the folder mapping lives inside HBS 3's own GUI, so the
"set the NAS destination from the dashboard" goal is *not* met by this option.
Expect it to be slow on 1 GB of ARM — fine for an overnight job.

## Option B — rclone via Entware (only if dashboard-driven mapping is required)

Needs SSH, which is currently off (Control Panel → Telnet/SSH → Allow SSH
connection). rclone ships an `linux/arm` build that runs on ARMv7.

```bash
opkg install rclone     # Entware; there is no Container Station on this model
```

### Authorise as studiouih

```bash
rclone config
# n) new remote → name: gdrive → storage: drive
# scope: 1 (full) or 2 (drive.readonly — safer for a backup-only job)
# leave client_id blank, then use the "headless / remote" flow:
#   it prints a URL — open it on your Mac, sign in as studiouih@uwc.ac.za,
#   paste the token back
```

`drive.readonly` is the better default: the sync can never write to or delete
from Drive, so a misconfigured job cannot destroy the source. Deletion stays a
deliberate act in the dashboard.

### The sync command

Tuned for 1 GB of RAM: **no `--fast-list`** (it buffers the whole listing), and
low concurrency.

```bash
rclone sync gdrive: /share/GDriveBackup/studiouih \
  --drive-export-formats docx,xlsx,pptx,svg \
  --drive-acknowledge-abuse \
  --checksum \
  --transfers 2 --checkers 4 \
  --track-renames \
  --log-file /share/logs/rclone-gdrive.log --log-level INFO
```

`--drive-export-formats` is the flag that answers the Google-native problem:
Docs/Sheets/Slides land on the NAS as real `.docx` / `.xlsx` / `.pptx` instead
of zero-byte link stubs.

**`sync` mirrors deletions.** If a file disappears from Drive it disappears from
the NAS on the next run. For an archive you almost certainly want `copy`
instead, or `sync --backup-dir`:

```bash
rclone sync gdrive: /share/GDriveBackup/studiouih \
  --backup-dir /share/GDriveBackup/_deleted/$(date +%F) ...
```

### Schedule it — the QNAP crontab trap

QNAP regenerates `crontab` from `/etc/config/crontab` on boot, so a plain
`crontab -e` is silently lost on the next restart. Write the config file:

```bash
echo "30 2 * * * /opt/bin/rclone sync gdrive: /share/GDriveBackup/studiouih --drive-export-formats docx,xlsx,pptx,svg --log-file /share/logs/rclone-gdrive.log" >> /etc/config/crontab
crontab /etc/config/crontab
/etc/init.d/crond.sh restart
```

---

## (superseded) HBS 3 as a fallback

QNAP's native GUI tool. Has a Google Drive connector, handles scheduling and
retention, no shell needed.

**Trade-off:** the folder mapping lives inside HBS 3's own interface, so the
dashboard cannot drive it. Pick this if you would rather click than script and
you don't need "map the NAS destination from the dashboard".

Control Panel → HBS 3 → Sync → One-way → Google Drive → sign in as studiouih.

---

## Option C — dashboard-driven agent (the full brief)

This is the piece that makes the NAS path settable from the dashboard.
**There is no Container Station on this NAS**, so the agent has to run as a
plain process — Python3 is installable from App Center, or a shell script under
Entware. Either way it polls the web app outbound and applies whatever mapping
the dashboard has stored:

```
every N minutes:
  GET  <webapp>/exec?action=config
       → {mappings:[{driveFolderId, nasPath}], deadAfterDays, exportFormats}
  for each mapping: rclone copy gdrive:<id> <nasPath> --drive-export-formats …
  walk nasPath, md5 each file
  POST <webapp>/exec {action:'report', host, files:[{id, md5, bytes, path}]}
```

`Code.gs` already implements both endpoints (`doPost` → `config` / `report`),
and `getVerifiedIds()` reads the report back.

### Turning the delete-gate on

`Code.gs` ships with:

```js
var V_NAS_VERIFY = false;
```

While it is `false` the dashboard says so in plain language and does not pretend
files are backed up. Once the agent is genuinely reporting, flip it to `true` —
`trashFiles()` will then refuse any id the NAS has not confirmed.

### Before you open the web app to the agent

The deployment now uses `access: DOMAIN` + `executeAs: USER_ACCESSING` so every
UWC user sees their own Drive. **That means the QNAP can no longer POST to
`/exec` anonymously** — a domain-restricted web app rejects unauthenticated
callers. Two ways out, and neither is "just widen the access":

1. **A second deployment** of the same script set to `ANYONE_ANONYMOUS`, used
   only by the agent. The dashboard keeps its domain-restricted URL.
2. **A service account** with domain-wide delegation, so the agent presents a
   real OAuth token.

Option 1 is simpler, but it makes that URL publicly reachable, so
**add a shared bearer at the same time**, not afterwards:

- agent attaches `body._secret = <token>`
- `doPost` rejects any POST whose `_secret` doesn't match a Script Property
- make it **fail-open until the property is set**, so arming and rolling back are
  free property writes with no lockout window
- gate the POST dispatch only; leave `doGet` (the dashboard) alone

---

## Deletion safety

The dashboard never permanently deletes. `trashFiles()` calls
`Drive.Files.update({trashed:true})` — reversible, and Drive holds trashed items
for 30 days.

**Trashing does not free quota.** Trash is still billed until emptied, which
this tool deliberately never does. The order is:

1. rclone the files to the NAS
2. verify a real restore — open a file, don't just trust the byte count
3. trash from the dashboard
4. empty the Drive trash by hand

Google-native files are the exception to the whole exercise: they consume ~0
quota, so deleting them frees nothing. Export them for safekeeping and leave
them where they are. Forms, Sites and My Maps have no export path at all — they
must stay in Drive.
