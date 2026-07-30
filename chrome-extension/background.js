/*
  Toolbar button -> open the Storage Explorer. That is the whole extension.

  NOTE THE MANIFEST DECLARES NO PERMISSIONS AT ALL, and that is deliberate rather
  than minimal-by-accident. `chrome.tabs.create()` does not require the "tabs"
  permission — "tabs" gates READING sensitive tab properties (url, title,
  favIconUrl), not opening one. So this extension asks for nothing, installs with
  no scary consent screen, and gives a Workspace admin nothing to weigh up.

  The obvious nicety — focus an already-open tab instead of stacking duplicates —
  is deliberately NOT here. `chrome.tabs.query({url})` needs either the "tabs"
  permission or host permissions for script.google.com, and neither is worth
  trading a zero-permission install for.
*/

/*
  The PINNED /exec deployment, not /dev.

  /dev serves whatever was last `clasp push`ed and is only reachable by the
  script's editors, so it would 404 for everyone else in the domain. /exec is the
  versioned deployment every uwc.ac.za user can open.

  This URL is stable ONLY because the project redeploys onto the existing
  deployment id (`clasp deploy -i <id>`). If someone ever deploys without `-i`,
  Google mints a NEW url, the old one silently keeps serving the old version, and
  this button quietly points at a stale build. Same discipline as APP_VERSION.
*/
const APP_URL =
  'https://script.google.com/macros/s/AKfycbylQVtG6GnMNVvBB50j_HLyVDManm3qE0czIY6zh5-bYizESaBGXoKCLMscDjMEt_a7xw/exec';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: APP_URL });
});
