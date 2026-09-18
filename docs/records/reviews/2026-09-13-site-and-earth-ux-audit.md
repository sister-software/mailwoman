# Site + Earth UX audit — 2026-09-13

Scope: `mailwoman.ai` (Docusaurus docs site) and `earth.mailwoman.ai` (geocoder demo), walked live in
Chrome plus a source sweep of `docs/` and `packages/earth` + `packages/react`. Ordered by severity.
Every claim states the file:line or the live observation it came from.

---

## Verification, 2026-09-13

Everything below was checked against the Docusaurus build output and a `docusaurus serve` of it. The
docs build is the check that matters, because `onBrokenLinks` and `onBrokenAnchors` are both `"throw"`
— it passing means every link added here resolves.

Why half of this was hard to check at all is its own record: `.yarnrc.yml` declared
`supportedArchitectures` for `cpu` and `os` but not `libc`, so a macOS install silently dropped every
`libc=glibc` package and left a tree no Linux machine could build from. Fixed in a0eac6ce3.

| Check                                          | Result                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `/pricing`, `/licensing`, `/licenses`          | 200, each a redirect page to its target                                        |
| `/nope-not-a-page`                             | 404, carrying the new body; upstream's "contact the owner of the site" is gone |
| `/docs/reviews/2026-08-02-mailfail-robustness` | 404 — the orphan is off the published site                                     |
| Font preloads in `index.html`                  | 4, all `rel=preload as=font type=font/woff2 crossorigin=anonymous`             |
| Purchase cards                                 | `$250`, `$2,400`, "Works out to $200 a month", both billing-basis lines        |
| `/docs/pricing`                                | "Buying one" + "Purchase a commercial license" CTA                             |
| Footer                                         | `href=/license>License`                                                        |
| `rebeccapurple`                                | absent from the built CSS                                                      |
| Card example lines                             | `white-space:normal; overflow-wrap:anywhere` shipped                           |
| Long `alt` strings                             | gone; replaced by the short forms                                              |

Earth, once the `libc` fix landed (2026-09-14): `vite build` completes on Linux, so the Earth changes
compile, bundle and pass the PWA precache step. `packages/react`'s node-mode suite is green (21 tests,
including `place-render.node.test.ts` — the camera logic this pass deliberately did not touch), and so
are `packages/earth`'s unit tests (14, including `routes.test.ts`, the `?q=` parser `initialQuery`
rides on).

Still not verified: anything needing a real browser. `@mailwoman/react`'s component suite is Vitest
browser mode over playwright/chromium, and the Earth browser specs likewise; the chromium download is
refused by this workspace's egress allowlist. So the select-on-focus, the result sheet's close, the
focus ring and the span-tag spacing are compiled and reasoned about, but nobody has watched them work.
`oxlint` cannot run here either — with its binding correctly installed it now loads and then panics
inside its own allocator pool (`oxc_allocator/src/pool/fixed_size.rs`), single-threaded too, so that
one is this VM rather than the toolchain.

### How the permalink change lands in the existing browser specs

`initialQuery` makes a `?q=` run on arrival, and `GeocoderFixture.goto(query)` navigates to exactly
that URL — so eleven specs now exercise the permalink path for free (`200-demo-resolve` ×6,
`000-demo-production-smoke` ×3, `270-demo-debug-drawer`, `300-demo-theme`, plus `shell.spec.ts`).

All of them stay green. Each one submits the same query it navigated with, so whether the fixture's
Enter is swallowed by the `busy` guard mid-auto-run or re-runs after it, `readResult()` reads a result
for the query the spec asked about. Specs that call `demo.goto()` with no query are untouched — no
auto-run fires.

One new flake vector worth knowing about if one ever appears: when the auto-run finishes before the
fixture presses Enter, `submit()`'s wait for "Parsed components" is satisfied by the first run's panel
while the second is still in flight. Both runs carry the same query and render the same DOM, so there
is nothing observable to differ — but that is why a re-run is happening at all.

---

## Memory, added 2026-09-14

Reported symptom: Safari force-reloads the Earth tab with a memory warning. Cause: `session.release()`
appeared nowhere in the repository.

An ONNX `InferenceSession` keeps its weights and arenas in the WASM heap, or on the GPU — memory the
JavaScript collector does not own. Dropping the last reference to a loaded bundle freed the wrapper and
left the model resident. `useReleaseRuntime` rebuilds the bundle whenever the version or the backend
force changes (`useReleaseRuntime.ts:289`, deps `[selectedVersion, forceWASM]`), so every model-version
pick, every Force WASM toggle and every compare-mode entry added a model's worth of native memory that
never came back. A visitor poking at the Developer panel a few times accumulated several.

Three leaks, fixed in 86e85929f:

1. `WebONNXRunner` held `modelBytes` for its whole life. `InferenceSession.create` copies the graph into
   the runtime's own heap, so that was a second full copy of a 38 MB model, kept for the page's life,
   for nothing. Dropped as soon as a session owns it.
2. `WebONNXRunner.release()` did not exist. It does now, and is what hands the session's memory back.
   Safe to call twice, and safe mid-load — an in-flight session is awaited and then released, so an
   aborted load cannot leak the session it was half-way through building.
3. `useReleaseRuntime` now takes `disposeAssets` and calls it in the three places a bundle stopped being
   anybody's: the outgoing bundle when a reload begins (before the replacement is built, so two models
   are never resident at once — the peak is what kills a tab), a bundle whose load was aborted after it
   had already resolved, and the last bundle on unmount.

This is separate from the main-thread stall below, and does not fix it. It does reduce what the page
holds while that work runs, and it is the more likely explanation of a tab being killed outright.

---

## P0 — broken in front of a visitor

### 1. A `?q=` permalink never runs

`packages/earth/lib/App.tsx:78` passed the URL's query as `defaultAddress`, which only pre-fills the
field. Nothing submitted it. A shared link therefore landed on the world view with the address sitting
in the search box, unrun, and the visitor had to press Enter themselves — so "Copy link" produced a
link that did not reproduce the result it was copied from. Reproduced on
`?q=350+5th+Ave+New+York+NY+10118`: field populated, no result sheet, no marker, 48 s after load.

fixed — `Geocoder` takes an `initialQuery` prop, distinct from `defaultAddress`, and runs it once as
soon as `runtime.ready` flips. Only the URL's query goes through it, so a cold visit still pre-fills
the demo address without spending the visitor's first seconds on a parse they did not ask for.

### 1b. The map is black for ~20 s the result — NOT a camera bug

An earlier draft of this record called this a fly-to that overshot the basemap's maxzoom. That was
wrong, and it is recorded here because it is the kind of wrong that gets a camera "fixed" into a
second bug.

What is settled is that the camera is correct. `computeMapPlaceRenderSpec`
(`packages/react/lib/map/place-render.ts:126`) flies an interpolated hit to z15, well inside the
Protomaps source's `maxzoom: 15`, and the marker lands on the right building. The viewport is
nevertheless black for tens of seconds and then fills in on its own with no interaction. Why it does
that is the open question below — an earlier answer to it has also been withdrawn.

The cause is not established. The 2026-09-14 entry that claimed it was has been withdrawn — this is the
second confident wrong answer about this one symptom, and the pattern is worth naming in place.

**Fact, from source.** Inference runs on the page's main thread.
`packages/neural/lib/web/onnx-runner.ts:140` creates the session with
`executionProviders: ["webgpu", "wasm"]` in the page rather than a worker. The gazetteer is in a worker
(sql.js-httpvfs).

**Fact, from the tests.** The camera is right — `place-render.node.test.ts` (10 tests) covers the
arithmetic, and an interpolated hit flies to z15, inside the Protomaps source's `maxzoom: 15`.

**Fact, observed.** The viewport is black for roughly twenty seconds, then paints
with no interaction. Scrolling appeared to fix it because any interaction forces a repaint of tiles
that had by then arrived.

**The withdrawn claim** was that MapLibre never requested a tile at all, evidenced by
`performance.getEntriesByType("resource")` reporting three requests to `tiles.mailwoman.ai` for the
whole page life. That measurement cannot state the claim:

- Resource Timing holds **250 entries by default** and drops the rest silently. This page fetches the
  model, the tokenizer, six lexicons, the postcode binaries, eight pair indexes, the sqlite range reads
  and several dozen terrarium elevation tiles. The buffer is long gone before a vector tile is asked
  for, so "three entries" measures the buffer rather than the network.
- And the tiles come from the host that was counted:
  `packages/tile-worker/lib/protomaps/index.ts:72` builds the template as
  `https://tiles.mailwoman.ai/{tilesetName}/{z}/{x}/{y}.{ext}`. Detailed tiles demonstrably rendered, so
  requests to that host were made and went unrecorded. The two observations cannot both stand,
  and the measurement is the one that gives.

**2026-09-14, measured at last — and the repro does not survive it.** Instrumented the live page with
a longtask `PerformanceObserver` and a `requestAnimationFrame` sampler:

- **1 long task in 66 seconds, 174 ms total.** The main thread is idle rather than saturated. That kills the
  main-thread theory outright.
- **11 animation frames in 66 seconds, with a 52.9-second gap between two of them.**
- `document.visibilityState === "hidden"` for the whole session.

Chrome zeroes `requestAnimationFrame` for a hidden tab, and MapLibre both renders and decides which
tiles to request inside that loop. No rAF, no render, no tile requests, black canvas — every symptom,
with no bug required. And `totalResources` was 66, well under the 250-entry cap, so `tileReqs: 0` was a
true count this time rather than a buffer artifact: the tab in fact never asked for a tile because it
never rendered a frame.

Every observation of this symptom in this record came from a tab driven by browser automation, which
runs the page hidden. So the black map is, on the evidence available, **an artifact of how it was
observed**. It has never been reproduced in a browser tab a human was looking at.

That does not prove the app is fine — a visible tab might still stall for its own reasons, and the
original report deserves a look. It does mean there is currently no evidence of a bug here, and the
next step is not a fix but a five-minute check in a visible tab:
`yarn workspace @mailwoman/earth preview`, open `http://localhost:7770`, run a query, watch.

**How to measure it properly**, for whoever picks this up: a Performance-panel recording across the
resolve, which shows long tasks and main-thread occupancy directly — or
`performance.setResourceTimingBufferSize(5000)` before the query if request counts are what is wanted.
The question to answer first is whether the main thread is occupied or idle during those twenty
seconds. Everything else follows from that, and nothing should be changed until it is known.

NOT FIXED, and not to be fixed from here. The candidate actions — inference in a worker, yielding
between pipeline stages — are architecture changes whose whole value is what they do to frame timing,
which is the one thing a workspace that cannot open a browser must not be trusted to judge. The memory
work above (86e85929f) was a separate and established bug; it is not a fix for this.

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

> `docs/docusaurus.config.ts:340` — "…This is the smallest fix for that rather than a considered placement — revisit when the Resources door lands."

Either hold it behind the Resources door until it has real data, or drop the footer link.

### 4. Pricing and licensing do not connect

The two halves of the money path never reference each other:

- `/docs/pricing` (`docs/articles/pricing.mdx`) states the prices and ends in a **mailto**. It has no link
  to `/license` and no provide CTA at all.
- `/license` (`docs/src/pages/license.mdx`) holds the actual Stripe checkout (`BuyLicense`), and its two
  plan cards carry **no price** — only "Renews every month; the key follows the paid period plus 14 days."
  A buyer has to hold the $250 figure in their head from another page.
- Nothing in the navbar or the footer links to `/license`. Its only inbound links are from
  `IssuedLicense.tsx:176` and the terms page — both of which you reach _after_ buying.
- `docs/src/components/PricingTiers/` — the tier cards with price + CTA — is dead code. Its own docblock
  says so: `index.tsx:11` "UNMOUNTED as of the docs-reorg Task 5 skeleton cutover."
- `/pricing` (no `/docs`) **404s**, despite the navbar item being labeled "Pricing".

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

Minor, same file: the proportional font's bucket path is misspelled — `/fonts/IoveskaNexus/…` (Iovesk**a** rather than Iosevka) while the mono path is spelled correctly. It 200s today, so it is a rename-hazard rather than a bug.

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
  center of the screen where a first-time visitor is looking.
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
- ~~Candidate scores mix scales.~~ FIXED. They were never on one scale: `score` is
  implementation-defined and its type says to treat it as ordinal — 6.95 is `log10(8.9M)` from the
  candidate regime, 1.00 a bounded blend from the FTS regime. The row now carries the rank and the
  placetype; the raw value stays on the button's `title`.
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
- Developer panel: ~~the Model version `<select>` truncates mid-string.~~ FIXED (ellipsis, plus the
  whole label on `title`). Its checkboxes are still native/unstyled beside magenta styling elsewhere.
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
- ~~601–615px: the rail covers the right end of the search pill.~~ FIXED, and not by moving the
  breakpoint: `.mw-map-chrome--top` reserves the rail's width at every viewport. Above ~620px
  `max-width` decides the box and the inset is never reached, so it costs nothing and cannot drift out
  of tune when a control changes size.
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
- ~~**A dead component tree.**~~ DELETED: 14 paths, 29 files, 6,531 lines. `PipelineExplorer` and its
  orphaned subtree (`BIOHighlight`, `CRFDiff`, `ClassifierOverlay`, `FSTWalker`, `SubwordExplorer`,
  `GuidedTour`), plus `src/contexts/RuntimeEmbed.tsx` — those four were its only consumers —
  `CalibrationShowcase`, `F1ScoreTable`, `POIExplorer`, `DashboardMap`, `SplashScreen` and the stray
  `TrainingChart.tsx`. `PricingTiers` stays: its docblock records a decision to keep it for the Product
  door, which has since landed, so that is now a choice rather than a wait. Verified by `docusaurus
build` completing with `onBrokenLinks` and `onBrokenAnchors` both `"throw"`.
- `docs/src/pages/index.module.css` — 25 colour literals, 2 media queries, **zero `[data-theme]`
  overrides**; `:119-153` adds eight `rgba(255,255,255,…)` values that assume a dark hero.
  `GuidedTour/styles.module.css:172-186` is half-tokenised: the correct
  `var(--ifm-color-info-contrast-background, …)` pattern sits ten lines above four rules that skip it.
- ~~`docs/src/components/TrainingCharts/styles.module.css:176` — `min-width: 600px` forces horizontal
  overflow on a phone.~~ WITHDRAWN: its parent `.chartWrapper` already carries `overflow-x: auto`, so the
  600px scrolls the chart in its own container rather than the document. The rule is correct as written.
- Homepage cards clip their mono example lines mid-string with a hard truncation — no ellipsis, no fade:
  `"apt 4b 350 5th ave new york ny 10118" → unit=house-street·` and
  `type an address → components, coordinate, and the source it`.
- `docs/src/pages/index.tsx:154,194` — `alt` strings of 205 and 196 characters, both inside a `<Link>`, so
  the link's accessible name is that whole paragraph. The adjacent visible heading already says it.
- Onnxruntime emits two `W:` warnings to the console as errors on every Earth load
  (`VerifyEachNodeIsAssignedToAnEp`). Harmless, but it is the first thing anyone sees in devtools.

---

## Map chrome, second pass (reported from a phone and a desktop)

Five faults reported against the floating-pill-plus-bottom-sheet arrangement, all of them the same fault
seen from different widths: two surfaces over one map, neither of which owned the search.

| Reported                                      | Resolution                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weird gap at the top                          | FIXED. The grip bar took a 2.5rem minimum whether or not it held anything; on a desktop with no result it held nothing. Its height is now its contents. |
| Overlap with the pills                        | FIXED. The search and the control rail no longer share a row at any width — the panel is a left column, the rail stays at the right.                    |
| Magnifying glass too small                    | FIXED. Drawn as a path (`SearchGlyph`) rather than typed as `⌕`, which the glyph face draws at the weight of a punctuation mark.                        |
| Mobile layout gets stuck with the box open    | FIXED. The drawer detents: drag the grabber down and the result goes, leaving the search field and the examples.                                        |
| Search box shares its width with the controls | FIXED. The search is inside the panel, so it spans the panel.                                                                                           |

Three layout faults found while fixing those, all at the panel's top edge, all worth writing down because
each looked correct in the stylesheet:

- An absolutely positioned close reserves no space. Hung off a bar with no height of its own, a 44px
  button came down across the right end of the search field below it.
- A negative top margin does not pull a grid item out of its padding. The track is sized from the margin
  box while the item is laid out at the track's start, so the bar painted 12px past its own row.
- A drawer at its tall detent crosses the control rail's corner. Under it, the rail sat on the drawer's
  own close; the drawer is now raised over the rail, which is what a sheet over a map does.

Still open here: `MapSheet`'s side sheets keep a header pattern of their own rather than the grip bar, so
the About, Layers and Developer panels close differently from the result.

---

## Duplicate-behaviour sweep over the map chrome

Run after the restructure, because a rearrangement is when copies of one idea get left behind. Every item
fixed here was two implementations of one thing, and four of them had already disagreed.

| Duplicate                                      | What the disagreement cost                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Glass material, hand-rolled on `.mw-map-panel` | Vendor pair reversed (no blur on Firefox), hardcoded `blur(20px)` with no saturation, and absent from both fallbacks — reduced-transparency still got glass. |
| Detent toggle, written three times             | The third copy was the literal `0.7`, which is `(medium + large) / 2` by hand. `aria-expanded` would desync the moment a detent moved.                       |
| Two document-level `Escape` listeners          | Escape over an open About/Layers panel closed the panel and dismissed the result behind it. One keystroke, two dismissals.                                   |
| Sheet close button, markup re-typed            | Against `MapSheet`'s own docblock: "One component carries it so the four sheets cannot disagree."                                                            |
| `"(max-width: 600px)"` in three places         | The JS gestures arm on it and the CSS moves the panel on it; a drift arms a drag on a layout with nowhere to drag to.                                        |

Dead rules removed: `.mw-map-sheet--bottom` (×2), `.mw-map-sheet__grip`, `.mw-map-searchbar__clear`.
`.mw-map-chrome__search` was the last member of a deleted namespace, now `.mw-map-panel__search`.

**The finding worth remembering.** `CHROME_SELECTORS` in `packages/site-kit/lib/playwright/chrome-contract.ts`
still listed `.mw-map-chrome--top` and `.mw-map-sheet--bottom`, and `visibleBoxes` SKIPS a selector whose
`count() !== 1` — so the overlap contract had stopped testing the surface the restructure was about, and
said nothing. A contract that skips what it cannot find reports green for a deleted subject. Two unit and
browser assertions were stale the same way and had not been run since.

Left alone deliberately:

- `.mw-map-panel__header` and `.mw-map-sheet__header` are the same sticky-header pattern in different
  tokens. Neither is canonical yet; merging them means settling what a sheet header is across two
  components, which is more than a sweep.
- `MapControlStackProps.side` has no consumer and `.mw-map-control-stack--left` is therefore unreachable;
  `MapSearchBarProps.trailing` is used only by a story. Both are library surface rather than dead product code.

**Environment note.** The node on the workspace VM is 22.23.2 while `.nvmrc` pins 24.18.0, so `ci:test:fast`
reports 167 failing files on `AsyncDisposableStack is not defined` and `mwops health` cannot parse
`await using` at all. Neither is a defect in this work; the react node suite (26 tests) passes, and the
browser suites need Playwright browsers that VM has no egress to fetch.

---

## Magic numbers in the stylesheets

| Was                                                                 | Count                                      | Now                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Confidence tier colours as raw hex, in **two disagreeing palettes** | 5 rule groups + 9 more in `VersionCompare` | `--color-confidence-{high,mid,low}` and their tints, over the state palette |
| Padding / margin / gap values picked by eye                         | 19 distinct, 171 declarations              | `--space-0` … `--space-6`, seven steps on a 2px grid                        |
| Raw pixel `border-radius`                                           | 6 values (2/3/4/6/8/10) + `999px` ×4       | `--radius-tick`, `--radius-tight`, and the three steps that existed         |
| Pixel lengths that should scale with type                           | 7 (`720px`, `320px`, `480px`, …)           | rem                                                                         |
| Stage hues on the timing bar, raw hex                               | 3                                          | `--color-stage-{shape,classify,resolve}`                                    |

**The one that was a defect rather than untidiness.** The bars and the About legend painted `#22c55e / #f59e0b /
#ef4444`; the span ribbon and the containment tree painted `#1aa84d / #e6a800 / #d8504a`. So the legend that
explains the confidence colours used colours the results table does not, and the comment above the span
rules said _"The tier tints match `.mw-conf__bar--high/--mid/--low`."_ Raw hex also meant the tiers did not
follow the theme, on surfaces that flip from white to near-black.

**Where the tokens live.** `packages/react/tokens/index.css` is GENERATED by `yarn workspace @mailwoman/react
tokens`, and the generator runs `--clean`. New tokens go in `styleframe.config.ts` or they vanish on the next
run — which is how the first attempt at this pass was written, and would have gone unnoticed until someone
regenerated.

`stylesheet-contract` grew a detector for a raw pixel `border-radius`, so the scale is enforced rather than
merely documented. The spacing scale is not enforced: it would need a lint over four properties and a way to
exempt the values that are deliberate, and the check's house rule is that every rule in it is a defect that
reached production.

Kept raw on purpose: `1px` / `2px` / `3px` borders, outlines and hairlines (they should not scale with the
reader's type size), and `packages/planetary/lib/styles/app.css`'s starfield gradients, which are artwork
rather than palette. Still outstanding: one `rgba(0, 0, 0, 0.18)` shadow in `panels.module.css` and two raw
background hexes in the planetary app.

---

## What the linter caught that the tests did not

`oxlint` cannot run in the workspace VM (node 22 against the repo's 24), so these came back from a run on
real hardware. Four were mine, and one of them was a rule I had argued myself out of.

**The ref written during render.** The permalink race — `?q=` answering "Classifier not ready" on a page
whose classifier had loaded — came from mirroring `rt.assets` into a ref in an EFFECT: React runs effects
child-first, so the descendant that reacts to `ready` flipping true read the mirror before the parent wrote
it. Moving the write into render closed that window and broke a different rule, and `react(refs)` was right
to say so: a value written during render is one React is entitled to discard.

The fix is neither mirror. The callbacks that parse with a bundle now DEPEND on the bundle — `rt.assets`,
`rt.selectedRelease`, `rt.selectedVersion` in their dependency arrays — so every consumer gets the new
callback in the same render that produced the new assets, and there is no second copy of the truth to keep
in step. The identity churns once per release load, which is the only moment it means anything. The refs
existed to hold identity fixed across exactly that change, which is the one time it should not be.

**The rest.** A test reaching into `#map/graticule`, the package's private imports map, instead of a public
export (`./map/graticule` added, and the test now imports it the way the geometry test does); two missing
hook dependencies; two unnamed thresholds in the drawer gestures (`3` for a press that has travelled far
enough to be a drag, `8` for a pull at the top of the scroll that has travelled far enough to be one — the
second is larger on purpose, because that gesture starts on content that could still turn out to be
scrolling); `180` written out where `MAX_LONGITUDE` belonged beside the `MAX_LATITUDE` already there; and
`beforeId`, which title-cases an acronym the house style capitalizes whole.

---

## Judgment call rather than a defect

`docs/research/authors.yml` publishes field notes under **"Playpen Agent — Autonomous Researcher"**
alongside Teffen. Worth a deliberate decision about how that authorship is framed on a public research
log, rather than leaving it as a config detail.
