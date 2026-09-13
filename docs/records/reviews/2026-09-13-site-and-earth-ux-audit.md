# Site + Earth UX audit — 2026-09-13

Scope: `mailwoman.ai` (Docusaurus docs site) and `earth.mailwoman.ai` (geocoder demo), walked live in
Chrome plus a source sweep of `docs/` and `packages/earth` + `packages/react`. Ordered by severity.
Every claim carries the file:line or the live observation it came from.

---

## Verification, 2026-09-13

Everything below was checked against the Docusaurus build output and a `docusaurus serve` of it. The
docs build is the check that matters, because `onBrokenLinks` and `onBrokenAnchors` are both `"throw"`
— it passing means every link added here resolves.

| Check                                          | Result                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `/pricing`, `/licensing`, `/licenses`          | 200, each a redirect page to its target                                        |
| `/nope-not-a-page`                             | 404, carrying the new body; upstream's "contact the owner of the site" is gone |
| `/docs/reviews/2026-08-02-mailfail-robustness` | 404 — the orphan is off the published site                                     |
| Font preloads in `index.html`                  | 4, all `rel=preload as=font type=font/woff2 crossorigin=anonymous`             |
| Buy cards                                      | `$250`, `$2,400`, "Works out to $200 a month", both billing-basis lines        |
| `/docs/pricing`                                | "Buying one" + "Buy a commercial license" CTA                                  |
| Footer                                         | `href=/license>License`                                                        |
| `rebeccapurple`                                | absent from the built CSS                                                      |
| Card example lines                             | `white-space:normal; overflow-wrap:anywhere` shipped                           |
| Long `alt` strings                             | gone; replaced by the short forms                                              |

NOT verified, and why: `packages/earth` cannot be built or run from a Linux workspace — `rolldown`,
`rspack`, `oxlint` and `vale` all ship darwin-only native bindings here. The Earth changes have a clean
`tsc --noEmit`, and the browser specs were read rather than run (below), but nobody has watched them
work in a browser.

### How the permalink change lands in the existing browser specs

`initialQuery` makes a `?q=` run on arrival, and `GeocoderFixture.goto(query)` navigates to exactly
that URL — so eleven specs now exercise the permalink path for free (`200-demo-resolve` ×6,
`000-demo-production-smoke` ×3, `270-demo-debug-drawer`, `300-demo-theme`, plus `shell.spec.ts`).

All of them stay green. Each one submits the SAME query it navigated with, so whether the fixture's
Enter is swallowed by the `busy` guard mid-auto-run or re-runs after it, `readResult()` reads a result
for the query the spec asked about. Specs that call `demo.goto()` with no query are untouched — no
auto-run fires.

One new flake vector worth knowing about if one ever appears: when the auto-run finishes BEFORE the
fixture presses Enter, `submit()`'s wait for "Parsed components" is satisfied by the first run's panel
while the second is still in flight. Both runs carry the same query and render the same DOM, so there
is nothing observable to differ — but that is why a re-run is happening at all.

---

## P0 — broken in front of a visitor

### 1. A `?q=` permalink never runs

`packages/earth/lib/App.tsx:78` passed the URL's query as `defaultAddress`, which only pre-fills the
field. Nothing submitted it. A shared link therefore landed on the world view with the address sitting
in the search box, unrun, and the visitor had to press Enter themselves — so "Copy link" produced a
link that did not reproduce the result it was copied from. Reproduced on
`?q=350+5th+Ave+New+York+NY+10118`: field populated, no result sheet, no marker, 48 s after load.

FIXED — `Geocoder` takes an `initialQuery` prop, distinct from `defaultAddress`, and runs it once as
soon as `runtime.ready` flips. Only the URL's query goes through it, so a cold visit still pre-fills
the demo address without spending the visitor's first seconds on a parse they did not ask for.

### 1b. The map is black for ~20 s after a result lands — NOT a camera bug

An earlier draft of this record called this a fly-to that overshot the basemap's maxzoom. That was
wrong, and it is recorded here because it is the kind of wrong that gets a camera "fixed" into a
second bug.

What happens instead: the camera is correct. `computeMapPlaceRenderSpec`
(`packages/react/lib/map/place-render.ts:126`) flies an interpolated hit to z15, well inside the
Protomaps source's `maxzoom: 15`, and the marker lands on the right building. The viewport is
nevertheless black for tens of seconds, and then fills in on its own with no interaction — the tiles
for the landed view are queued behind the model and gazetteer work saturating the main thread and the
connection (the resolve alone measured 2,535 ms). Scrolling appeared to "fix" it only because any
interaction forces a repaint of tiles that had by then arrived.

NOT FIXED, deliberately — the real fix is retaining the parent tiles across the flight, or holding
the camera until the target tiles are ready, and neither can be verified from a session that cannot
run the Earth dev server. Left as the top open item.

### 2. Nine silent failure paths in Earth

`packages/react/lib/map/GeocoderControls.tsx:329` is the only user-visible error sink in the app, and it
prints a raw `Error.message` in monospace with no `role="alert"` / `aria-live`. Everything below fails
with nothing on screen:

| Failure                           | Where                                                                                   | What the user sees                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geolocation permission denied     | `packages/earth/lib/runtime/use/geo-bias.ts:46` — `() => setActive(false),`             | Chip flips back off. Pressing it again does nothing, forever.                                                                                      |
| IP-geolocate fetch fails          | `packages/earth/lib/runtime/use/browser-geolocation.ts:44` — `.catch(() => fallback())` | Silently centred on the US.                                                                                                                        |
| Autocomplete throws               | `packages/earth/lib/runtime/use/geocoder-runtime.ts:467` — `} catch { return [] }`      | Indistinguishable from "no matches"; `packages/react/lib/map/PlaceAutocomplete.tsx:63` returns `null` on empty, so there is no empty state at all. |
| Street tier (rooftop) unavailable | `geocoder-runtime.ts:314` — `console.warn(...)`                                         | Console only. User gets a city centroid with no precision downgrade notice.                                                                        |
| Crisp polygon unavailable         | `geocoder-runtime.ts:509` — `console.error(...)`                                        | Console only.                                                                                                                                      |
| Decode-path trace fails           | `geocoder-runtime.ts:534` → `packages/earth/lib/panels/DebugDrawer.tsx:64`              | Tick "Trace the decode path", drawer never opens, no reason given.                                                                                 |
| `loadManifest` resolves `null`    | `packages/react/lib/runtime/useReleaseRuntime.ts:227`                                   | `ready` never true, `errorMessage` stays null, footer pinned to "Loading releases…" permanently.                                                   |
| Any load error                    | `useReleaseRuntime.ts:283` sets the message but leaves `assets` null                    | `bundleLoading` stays true → the progress bar sweeps _forever underneath the error_, footer stuck on "Loading…".                                   |
| Any of the above                  | —                                                                                       | No retry control anywhere, and `GeocoderControls.tsx:194` `disabled={!runtime.ready}` leaves the search box permanently dead.                      |

Also: `packages/earth/lib/main.tsx:19` calls `registerSW()` with no `onNeedRefresh` / `onOfflineReady`,
and `packages/react/lib/map/MapCanvas.tsx` has no `onError` — a dead tile worker renders a blank canvas
silently. No `navigator.onLine` handling anywhere.

The one good state in the app is `packages/react/lib/pipeline/FailureDiagnostic.tsx:48` ("No gazetteer
hit" with hints). It is the model for the nine above.

### 3. `/training` is published in the footer and shows "No data points"

Footer → Training renders a run picker with **35 raw internal run ids** (`v0.8.1-ft-scratch-s42`,
`v1.0.2-consolidation-run8-s42`, …), four preselected, an auto-refresh countdown, a Linear/Log toggle,
and an empty chart reading "No data points". The config already admits the placement is provisional:

> `docs/docusaurus.config.ts:340` — "…This is the smallest fix for that, not a considered placement — revisit when the Resources door lands."

Either hold it behind the Resources door until it has real data, or drop the footer link.

### 4. Pricing and licensing do not connect

The two halves of the money path never reference each other:

- `/docs/pricing` (`docs/articles/pricing.mdx`) states the prices and ends in a **mailto**. It has no link
  to `/license` and no buy CTA at all.
- `/license` (`docs/src/pages/license.mdx`) holds the actual Stripe checkout (`BuyLicense`), and its two
  plan cards carry **no price** — only "Renews every month; the key follows the paid period plus 14 days."
  A buyer has to hold the $250 figure in their head from another page.
- Nothing in the navbar or the footer links to `/license`. Its only inbound links are from
  `IssuedLicense.tsx:176` and the terms page — both of which you reach _after_ buying.
- `docs/src/components/PricingTiers/` — the tier cards with price + CTA — is dead code. Its own docblock
  says so: `index.tsx:11` "UNMOUNTED as of the docs-reorg Task 5 skeleton cutover."
- `/pricing` (no `/docs`) **404s**, despite the navbar item being labelled "Pricing".

Fix, smallest first: add `/pricing → /docs/pricing` and `/licensing → /license` to the existing
`plugin-client-redirects` block (`docusaurus.config.ts:118`); put the price on the two plan cards; end
`pricing.mdx` with a real CTA to `/license` instead of the mailto; add "License" to the footer's More
column. Then decide whether `PricingTiers` gets mounted on `/docs/pricing` or deleted.

---

## P1 — the disjointed feeling

### 5. The `/license` tree sits outside the docs IA

`/license`, `/license/terms/commercial-2026-10` and `/license/issued` are `src/pages` routes, so they get
no sub-header band, no breadcrumb, no sidebar. `DocsSubHeader` only mounts for pages whose sidebar is one
of `DOCS_SECTIONS` (`docs/src/components/DocsSubHeader/index.tsx:27`). Moving from `/docs/pricing` to
`/license` drops the band and **shifts the whole page up by its height** — that jump is a large part of
what reads as disjointed.

### 6. Two nav rows disagree about where you are

On `/docs/pricing` the navbar highlights **Pricing** (`docusaurus.config.ts:314`, a direct doc link) while
the sub-header highlights **About** (pricing lives in the `about` sidebar, `sidebars.ts:236`). Pick one:
either give pricing its own door, or drop the navbar shortcut and let About own it.

### 7. `/license/issued` visited cold is a bare sentence

No layout, no branding, a single line of copy in the top-left of an otherwise empty viewport. It is only
ever reached as a Stripe return URL, but that is exactly the moment a customer is most anxious. It needs
a real "what happens next" state.

### 8. The 404 tells the visitor to contact the site owner

Stock Docusaurus copy: _"Please contact the owner of the site that linked you to the original URL and let
them know their link is broken."_ On `/pricing` — a URL your own navbar label invites people to guess —
that reads as a bug report addressed to the wrong person. No home link, no search, no suggestions.

### 9. Two internal review docs are published to `/docs/reviews/…`

`docs/articles/reviews/2026-08-02-mailfail-robustness.md` and
`docs/articles/reviews/2026-08-04-resolver-score-abstention.md` publish live (`routeBasePath: "docs"`
with no exclusion), with **no frontmatter at all** — no title, no description — no sidebar entry and no
inbound link. The second one's second paragraph reads _"This is a characterization only. No scoring code
was changed, and none of the designs at the end were implemented."_ Move them to `docs/records/reviews/`
where the rest of this genre already lives.

---

## P1 — the font pop-in

Measured on a cold load of `mailwoman.ai`: the six WOFF2 files all start at **~1570 ms**, and the document
has **zero `<link rel="preload">` for fonts** (only `mailwoman-seal-magenta.svg`). The chain is
HTML → `styles.*.css` → parse → discover `@font-face` → cross-origin fetch to `public.mailwoman.ai`. With
`font-display: swap` on all 48 faces (`docs/src/css/fonts/IosevkaNexus.css`,
`IosevkaNexusMono.css`), every visitor gets a guaranteed flash plus a reflow.

The reflow is the worse half: the fallback stack is
`"Iosevka Nexus Web", "Iosevka", system-ui, …` (`docs/src/css/theme-light.css:57`). `system-ui` is
substantially wider than Iosevka Nexus, so the swap re-wraps every line on the page. Nothing declares
`size-adjust` / `ascent-override` / `descent-override` for a metric-matched fallback.

Four fixes, in order of payoff:

1. `preload` the four faces that paint above the fold (Regular 400, Book 450, Bold 700, Mono Regular
   400). Everything else can stay lazy. The `preconnect` to `public.mailwoman.ai`
   (`docusaurus.config.ts:71`) saves the handshake but not the CSS-parse discovery delay.
2. Add a metric-matched `@font-face` fallback (`local("system-ui")` + `size-adjust`) so the swap does not
   move text.
3. Consider self-hosting the four critical faces on the docs origin and leaving the rest on
   `public.mailwoman.ai` — removes a connection from the critical path entirely.
4. 48 faces are declared, 6 load. Worth trimming the declaration set or splitting the rarely-used
   stretches into a second sheet.

Minor, same file: the proportional font's bucket path is misspelled — `/fonts/IoveskaNexus/…` (Iovesk**a**,
not Iosevka) while the mono path is spelled correctly. It 200s today, so it is a rename-hazard, not a bug.

---

## P2 — Earth UI polish

**Search input**

- `packages/earth/lib/App.tsx:78` — `defaultAddress={query ?? DEFAULT_ADDRESS}` pre-fills the field with
  the full White House address. There is **no `autoFocus`, no `onFocus`, no `.select()`** anywhere in
  `packages/earth/lib` or `packages/react/lib`. Clicking the field drops a caret mid-string: typing an
  address produces `1600 Pennsylvania Ave NW, W<your text>ashington, DC 20500`, which is exactly what
  happened on the first run of this audit. Select-on-focus, or ship the field empty with the address as
  placeholder only.
- The same string is also the placeholder (`packages/react/lib/map/Geocoder.tsx:185`), which is therefore
  dead code — it can only appear after the user clears the field, at which point it re-suggests the text
  they had deleted.
- The field is `disabled` for the entire 38 MB download, so the pre-filled text sits there uneditable for
  the whole wait.

**Model download (~38 MB)**

- Real byte progress _is_ computed (`packages/mailwoman/lib/browser-runtime/load-assets.ts:127`) and
  reaches `aria-valuenow` (`packages/react/lib/map/MapProgressBar.tsx:50`) — so a screen reader gets a
  percentage that no sighted user can see.
- Visually it is a **3px hairline at the top of the viewport** (`packages/react/styles.css:2100`), with no
  numerals, plus a truncated caption in a 1.9rem footer strip. No "12 MB of 38 MB", no ETA, nothing in the
  centre of the screen where a first-time visitor is looking.
- `packages/react/lib/map/GeocoderControls.tsx:167` — the `* 1` is a leftover no-op, and the whole 38 MB
  transfer is compressed into the first `1/steps` (≈ the first third) of the bar.

**Example chips**

- 12 chips (`packages/mailwoman/lib/browser-runtime/classify.ts:63-89`) inside a `max-width: 34rem`
  container (`packages/react/styles.css:1389`) — roughly 3–4× the available width. The only affordance is
  a 2rem mask fade (`styles.css:1802`); scrollbars are hidden on both engines (`:1814`), there are no
  arrows, no snap points, no wheel shim. Without a trackpad the row is unreachable past chip 3. The
  mobile rule _shrinks_ the fade to 1.25rem (`:1654`).
- Chip labels leak internal vocabulary at demo visitors: `Berlin city-state (int'l order)`,
  `Paris (street fall-through)`, `Macclesfield (GB dependent_locality)`,
  `Plimmerton (NZ dependent_locality)`.
- `packages/earth/lib/panels/Controls.tsx:32` reuses `.mw-map-chiprow` for a **single** button, so
  "Use my location" gets an overflow-scroll edge fade for no reason.

**Result panel**

- Component labels run together with no separator: the strip reads
  `house_numberstreetstreet_suffix locality regionpostcode`. Unreadable, and it is the first thing a
  visitor looks at.
- Candidate scores mix scales: `#1 350 5th Ave — interpolated · 1.00`, `#2 New York — locality · 6.95`,
  `#3 10118 — postalcode · 0.00`. A 6.95 beside a 1.00 reads as a bug whatever the intent.
- Vocabulary disagrees with itself in one panel: the parse tags `postcode`, the candidate says
  `postalcode`; `placetype: interpolated` and `precision: ≈ interpolated · ±64 m` say the same word twice.
- `packages/react/lib/map/GeocoderControls.tsx:326` — the result sheet has **no close button, no Escape
  handler, no `role`**. It covers 52vh and can only be removed by running another query. Its header
  (title + Copy JSON) scrolls away with the content instead of sticking.
- While a new query resolves, the previous result stays pinned on the map undimmed — during the
  "Resolving in gazetteer…" step the map still showed the _last_ address.

**Controls and chrome**

- Top-right rail (`packages/react/styles.css:1904`): 2.5rem = **40px targets**, under the 44px minimum,
  unchanged on touch. It defines `:hover`, `:active`, `--active`, `:disabled` but **no `:focus-visible`**,
  and the parent's `overflow: hidden` (`:1892`) clips even the UA outline. Every sibling control has a
  focus ring; this rail is the gap.
- Developer panel: the Model version `<select>` truncates mid-string
  (`v9.1.0 — the suffix-boundary cure (model v4.4.0` — closing paren missing, no ellipsis), and its
  checkboxes are native/unstyled beside magenta styling everywhere else.
- `packages/earth/lib/panels/ResultExtras.tsx:67,85` — `demoStyles.xml` and `demoStyles.hierarchy` are
  **not defined** in `panels.module.css`, so both render `className="undefined"`. The XML dump and the
  hierarchy block are unstyled. Conversely `.examples` / `.examplesLabel` are defined and referenced by
  nothing.
- `packages/earth/lib/panels/Controls.tsx:37` — a **139-character `title=`** is the only explanation of
  what "Use my location" does. Invisible on touch, and the button already has a text name so it adds
  nothing for screen readers either.
- Map attribution: `packages/earth/lib/styles/app.css:62` hides MapLibre's control with `display: none`,
  and the replacement (`packages/earth/lib/panels/EarthFooter.tsx:22`) is three **plain unlinked strings**
  behind a "Sources" toggle. OSM/ODbL attribution behind a click with no link to
  openstreetmap.org/copyright is the weakest defensible form.
- `packages/earth/index.html:4` hardcodes `data-theme="dark"` with no light path and no
  `prefers-color-scheme` handling, even though `packages/react/tokens/index.css:61` ships a complete light
  palette.
- Sheets (`packages/react/lib/map/MapSheet.tsx:36-60`): Escape closes, but focus is never moved in,
  trapped, or returned. On mobile they are `inset: 0` full-screen — a de-facto modal as a bare `<aside>`
  with no `aria-modal`, so a screen reader keeps reading the map behind it.

**Responsive / tokens**

- Six `@media` rules total across both packages, at three unshared breakpoints (600 / 640 / 768). Nothing
  between 601px and desktop; no tablet or landscape case.
- 601–615px: `.mw-map-chrome--top` and `.mw-map-control-stack` overlap and the rail (higher z-index)
  covers the right end of the search pill. The ≤600px rule at `styles.css:1623` exists to prevent exactly
  this and its breakpoint is ~16px too low.
- `packages/earth/lib/panels/VersionCompare/styles.module.css` — 9 hardcoded state colours (`#d8504a`,
  `#1aa84d` and their rgba washes at `:129-169`) where `--color-state-danger` / `-success` / `-warning`
  already exist, none of which respond to the theme switch.
- `packages/earth/vite.config.ts:26` — `themeColor: "#0b1020"` matches no token (`--brand-navy` is
  `#00093a`). A fourth, undocumented brand colour in the PWA manifest.
- ~30 raw `px` spacing values across 7 earth CSS files; 7 inline styles hardcoding type sizes
  (`0.8rem` / `0.85rem` / `0.9rem`) that correspond to no step in the scale.

---

## P2 — docs polish

- **`--ifm-color-content-secondary: rebeccapurple;`** — `docs/src/css/theme-light.css:45`. A CSS named
  colour, shipped. It drives `--ifm-font-color-secondary` (`:53`) and `--ifm-toc-link-color` (`:218`), so
  in light mode the right-hand TOC and every piece of secondary copy on the homepage render `#663399`.
  The dark theme's counterpart carries a `/* FIX: was pure white (too bright) */` marker at
  `theme-dark.css:35` — this one never got the same pass.
- **A dead component tree.** `PipelineExplorer` has zero importers site-wide, which orphans its whole
  subtree: `BIOHighlight`, `CRFDiff`, `ClassifierOverlay`, `FSTWalker`, `SubwordExplorer`, `GuidedTour`.
  Also unreferenced: `CalibrationShowcase`, `F1ScoreTable`, `PricingTiers`, `DashboardMap`, `POIExplorer`,
  and the stray `TrainingChart.tsx` (superseded by `TrainingCharts/`). Roughly 2,000 lines of TSX and
  1,600 of CSS that nothing renders. Mount them or delete them — the half-state is what makes the site
  feel unfinished from the inside.
- `docs/src/pages/index.module.css` — 25 colour literals, 2 media queries, **zero `[data-theme]`
  overrides**; `:119-153` adds eight `rgba(255,255,255,…)` values that assume a dark hero.
  `GuidedTour/styles.module.css:172-186` is half-tokenised: the correct
  `var(--ifm-color-info-contrast-background, …)` pattern sits ten lines above four rules that skip it.
- ~~`docs/src/components/TrainingCharts/styles.module.css:176` — `min-width: 600px` forces horizontal
  overflow on a phone.~~ WITHDRAWN: its parent `.chartWrapper` already carries `overflow-x: auto`, so the
  600px scrolls the chart in its own container, not the document. The rule is correct as written.
- Homepage cards clip their mono example lines mid-string with a hard truncation — no ellipsis, no fade:
  `"apt 4b 350 5th ave new york ny 10118" → unit=house-street·` and
  `type an address → components, coordinate, and the source it`.
- `docs/src/pages/index.tsx:154,194` — `alt` strings of 205 and 196 characters, both inside a `<Link>`, so
  the link's accessible name is that whole paragraph. The adjacent visible heading already says it.
- Onnxruntime emits two `W:` warnings to the console as errors on every Earth load
  (`VerifyEachNodeIsAssignedToAnEp`). Harmless, but it is the first thing anyone sees in devtools.

---

## Judgment call, not a defect

`docs/research/authors.yml` publishes field notes under **"Playpen Agent — Autonomous Researcher"**
alongside Teffen. Worth a deliberate decision about how that authorship is framed on a public research
log, rather than leaving it as a config detail.
