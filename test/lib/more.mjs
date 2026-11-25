// Under Calm (the app's default look) the banner keeps Search, Share and Sign
// in, and puts Export, Theme & layout, Offline, Help, the Guide, What's new and
// Report a Bug behind ⋯ (calm-shell.js, CalmShell.more). A check that wants one
// of them opens ⋯ and picks it, as a person does. `go` is the item's name:
// export, theme, offline, help, guide, news or bug.
export async function viaMore(page, go) {
  await page.click('#btn-more');
  await page.click(`#more-menu .more-item[data-go="${go}"]`);
}
