# Storage Explorer — Chrome toolbar button

A toolbar button that opens the Storage Explorer. That is all it does, and that
is the point.

**It declares no permissions at all.** `chrome.tabs.create()` does not need the
`tabs` permission — `tabs` gates *reading* sensitive tab properties, not opening
one. So it installs with no consent prompt and gives a Workspace admin nothing to
weigh up.

## Try it in 30 seconds

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → pick this folder
3. Pin it from the puzzle-piece menu

## Rolling it out to everyone

Three routes, cheapest first.

| Route | Admin needed | Notes |
|---|---|---|
| **Managed bookmark** | Chrome admin | No extension at all. Pushes a bookmark domain-wide via `ManagedBookmarks`. Gets most of the value in minutes. |
| **Unlisted Chrome Web Store item** | Publisher account ($5 one-off) | Upload this folder zipped. Set visibility **Unlisted**, then force-install by ID with `ExtensionInstallForcelist`. |
| **Self-hosted CRX** | Chrome admin | Needs `ExtensionInstallForcelist` + an update manifest you host. Chrome blocks off-store installs on Windows without policy, so this only works on managed devices. |

## Things that will actually bite you

- **Load-unpacked IDs are not stable.** Chrome derives the ID from the folder
  path, so it differs per machine and changes if the folder moves. Any policy
  keyed to the ID breaks. Fix: add a `"key"` to `manifest.json` to pin the ID —
  generate one with
  `node -e "const c=require('crypto');const{publicKey}=c.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'der'}});console.log(publicKey.toString('base64'))"`.
  **Leave `key` out when uploading to the Web Store** — the store assigns the ID
  and a manifest key fights with it.
- **Multiple Google accounts.** `/exec` opens under whichever account the profile
  treats as default, so a user signed into a personal account first can land on a
  "you need permission" page. Switching account there re-opens under `/u/1/…`.
  This is a Google multi-login quirk, not something the extension can fix — the
  reliable answer is a dedicated Chrome profile for the uwc.ac.za account.
- **The URL is only stable because deploys reuse the deployment id.** Deploy
  without `-i` and Google mints a *new* URL while the old one keeps serving the
  old version — the button then silently opens a stale build. Same discipline as
  `APP_VERSION` in `Code.gs`. If you ever do mint a new deployment, update
  `APP_URL` in `background.js` and bump `version` here.
- **Developer mode may be disabled by policy** on managed devices, which kills
  the load-unpacked route for exactly the people you want to reach.
- **Incognito and guest profiles** are not signed in, so the button opens a login
  page. Expected, not a bug.

## What it deliberately does not do

Focus an existing tab rather than opening a duplicate. That needs
`chrome.tabs.query({url})`, which requires the `tabs` permission or host
permissions for `script.google.com` — not worth trading a zero-permission install
for. Every click opens a fresh tab.

## Marketplace instead?

An internal **Google Workspace Marketplace** listing puts the app in the Google
apps launcher for the whole domain, which is arguably the more correct home for
it. It needs no code change, but it does need the script attached to a standard
GCP project inside the UWC org, an Internal OAuth consent screen, the Marketplace
SDK, a store listing, and a super admin to install it. Internal publishing also
sidesteps OAuth verification — which matters, because this app requests the full
`https://www.googleapis.com/auth/drive` scope and an *external* listing of that
would require Google's restricted-scope security assessment.
