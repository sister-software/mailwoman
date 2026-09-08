# The map visual system: tokens, materials and chrome for Earth, Moon and Mars

Three deployed apps — `earth.mailwoman.ai`, `moon.mailwoman.ai`, `mars.mailwoman.ai` — share one React
component package and one stylesheet, and none of them looks like a product. This design gives the four
consumers of `@mailwoman/react` a single owned vocabulary, replaces the desktop control panel with map
chrome, and repairs the rendering defects measured below.

## Measured state

Every number here was read from the deployed apps or from the tracked source, not inferred.

### The stylesheet reads a vocabulary it does not own

`packages/react/styles.css` is 1,195 lines. It reads 22 distinct `--ifm-*` custom properties and defines
zero. Four files each hold a partial copy of the values:

| File                                           | Defines                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/react/styles.css`                    | 0 of the 22 it reads                                                                           |
| `packages/earth/lib/styles/app.css`            | 19                                                                                             |
| `packages/react/.storybook/preview-tokens.css` | 14, light values                                                                               |
| `packages/planetary/lib/styles/app.css`        | 0 — hardcodes `#05070d`, `#e8eef7`, `#0a0604`, `#f6e3d1` and eight `rgb(0 0 0 / 0.x)` literals |

Eight of the 22 are undefined on the deployed Earth app. Read from the live page, each returns the empty
string: `--ifm-font-color-base`, `--ifm-color-emphasis-400`, `--ifm-color-success`, `--ifm-color-danger`,
`--ifm-color-info-darkest`, `--ifm-color-warning-darkest`, `--ifm-color-primary-contrast-background`,
`--ifm-color-info-contrast-background`. Each has an inline fallback and every fallback is Infima's light
value, so `.mw-subject__badge` paints `#92400e` on a translucent amber and `.mw-subject__badge--brand`
paints `#14657d` on translucent cyan, both inside a dark app.

### The control panel is light because a Docusaurus selector travelled with it

`packages/earth/lib/panels/geocoder.module.css:22` sets `background: rgba(255, 255, 255, 0.85)`. The dark
rule beneath it is scoped `:global([data-theme="dark"])`. Nothing under `packages/earth/lib/` or in
`packages/earth/index.html` sets `data-theme`, so the light rule wins permanently while `app.css` puts
`#e6edf3` text on it.

`packages/earth/test/browser/300-demo-theme.spec.ts` is the only test that touches the theme, and
`GeocoderFixture.setTheme` sets the attribute itself before asserting. The test exercises a state
production never enters, which is why this shipped.

The same file offsets the panel and the MapLibre control stack by `var(--ifm-navbar-height, 60px)` for a
navbar that does not exist outside Docusaurus.

### Two shipped styles request a glyph stack the bucket does not serve

`packages/cartographer/lib/planetary/layers.ts:93` and `packages/cartographer/lib/base/buildings.ts:117`
both set `"text-font": ["Fira Sans Regular"]`. Probing `https://public.mailwoman.ai/protomaps/fonts/<stack>/0-255.pbf`:

| Stack                                                                 | Result            |
| --------------------------------------------------------------------- | ----------------- |
| `Noto Sans Regular`                                                   | 200, 76,044 bytes |
| `Noto Sans Medium`                                                    | 200, 77,628 bytes |
| `Noto Sans Italic`                                                    | 200, 79,344 bytes |
| `Fira Code Regular`                                                   | 200, 75,442 bytes |
| `Fira Code Medium`                                                    | 200, 78,848 bytes |
| `Fira Sans Regular`, `Fira Sans Medium`, `Fira Sans Italic`           | 404               |
| `Open Sans Regular` (MapLibre's default stack)                        | 404               |
| `Noto Sans Bold`, `Iosevka Nexus Regular`, `Arial Unicode MS Regular` | 404               |

MapLibre renders no text at all when a glyph range fails. The 404 for `Fira Sans Regular` appears in the
live failed-request list on `moon.mailwoman.ai`, and it is why no nomenclature label draws at zoom 1.5 or
at zoom 7. The nomenclature TileJSON serves zoom 0–8, so the data was never the limit.

### Mars and the Moon render as the same picture

`PALETTES` in `packages/cartographer/lib/planetary/layers.ts` colors space, labels, label halos and the
selection ring. It does not reach the hillshade, so `hillshadeLayer()` draws both bodies' DEMs through
MapLibre's default grey ramp.

### The brand palette exists and never left the docs site

`docs/src/css/theme-light.css` declares the canonical anchors. The apps ship an Infima-era approximation.

| Token    | Brand                     | Earth today                                   |
| -------- | ------------------------- | --------------------------------------------- |
| primary  | `--mw-magenta: #ff00b0`   | `--ifm-color-primary: #e0367c`                |
| link     | `--mw-blue: #1a00ff`      | absent                                        |
| chrome   | `--mw-navy: #00093a`      | absent                                        |
| accents  | `--mw-amber`, `--mw-teal` | absent                                        |
| hairline | `--mw-line: #b9d8ec`      | absent                                        |
| type     | Iosevka Nexus Web / Mono  | `system-ui`, and the UA default on `<button>` |

The typeface is already served from `public.mailwoman.ai` as two `@font-face` files totalling 20 KB in
`docs/src/css/fonts/`, on an origin both apps already preconnect to.

### Three font families, no system

Read from the deployed Earth page: `main` computes `system-ui`, `label` computes `ui-monospace`, and
`button` computes `Arial` — no family is set on it at all, so it takes the user agent's default.

### The panel leads with the model card

The first prose on `earth.mailwoman.ai` is the release note for v9.1.0, followed by a model-version
select, a backend readout, a Force WASM checkbox and a Compare checkbox — four expert controls above the
address field. The right-hand panel lists internal style-layer counts (`Roads (39)`,
`Landuse / parks (12)`). The example chips wrap 3/3/2/1/1/1 down five rows.

## Decisions

1. **DTCG is the canonical token model.** Design Tokens Community Group JSON on disk is the artifact of
   record. Styleframe compiles it; styleframe is replaceable because the output is plain CSS custom
   properties and the input is a published standard.
2. **`@mailwoman/react` owns the tokens.** The declaring package declares the vocabulary. No new
   workspace: a new workspace joins seven registers, and nothing here needs a separate publish identity.
3. **Three token layers.** Primitive, semantic, component. Component rules read semantic names only. The
   current defect is component rules reading raw primitives.
4. **Aesthetic: Apple materials, Google density.** Translucent glass chrome, neutral by default, in the
   restrained Apple register. Map content carries the richness — label hierarchy, category color,
   icon markers — in the Google Maps register.
5. **Magenta is an accent, not a theme.** `#ff00b0` appears in exactly three roles: the primary action
   fill, the focus and selection ring, and the selected-feature marker. Everything else is neutral. This
   is a rule a reviewer can check by grepping the compiled CSS.
6. **`#e0367c` is retired.** It is Infima-era drift from `#ff00b0`, which `docs/src/css/theme-light.css`
   holds as `--mw-magenta`.
7. **The typeface is bound per role, and the binding is expected to change.** No rule names a family; a
   rule names a scale role and a scale role names one of five face roles. Iosevka Nexus is the current
   binding of all five and is not assumed permanent — a swap edits `font.family.*` and nothing else.
   Map labels carry a separate binding, `font.family.map`, because MapLibre draws them from a
   signed-distance-field range rather than a `@font-face`; its value must name a stack the bucket serves,
   which today means `Noto Sans Regular`, `Noto Sans Medium` or `Noto Sans Italic`.
8. **Base UI is deferred behind a trigger.** No UI library exists in any of the 74 workspaces today, and
   the whole inventory across `@mailwoman/react`, `packages/earth` and `packages/planetary` is six element
   types: 13 `<button>`, 10 `<label>`, 10 `<input>`, 6 `<summary>`, 6 `<select>`, 6 `<details>`. Two
   places want behavior that is a mistake to hand-roll — the layers panel wants a popover with dismissal
   and focus return, and the result view wants a sheet. When Phase 2 reaches either, take `@base-ui/react`
   for those two alone, behind our own component names. Not a fourteen-component build-out.
9. **No control depends on glass to be usable.** Every material carries an opaque fallback under
   `@supports not (backdrop-filter: blur(1px))` and under `prefers-reduced-transparency`. Text contrast
   holds in all three states.

## Token architecture

### Files

```
packages/react/lib/tokens/
  primitive.tokens.json     DTCG primitives: color ramps, dimensions, durations, easings
  semantic.tokens.json      DTCG semantics with light/dark modifiers
  material.tokens.json      DTCG composites for the glass materials
packages/react/styleframe.config.ts
packages/react/tokens.css   generated, exported as @mailwoman/react/tokens.css
packages/react/fonts.css    the two Iosevka @font-face blocks, re-homed from docs
```

### Primitive layer

Neutral ramps derived in OKLCH so lightness steps are perceptually even. Brand anchors carried verbatim
from `theme-light.css`: magenta `#ff00b0`, blue `#1a00ff`, navy `#00093a`, amber, teal, `--mw-line`,
`--mw-line-strong`. Two body ramps for the planetary hillshades, one cool and one warm, each derived from
a single hue.

### Semantic layer

The API component rules consume:

```
color.background.canvas      color.text.primary        control.background
color.background.raised      color.text.secondary      control.background.pressed
color.background.sunken      color.text.tertiary       control.foreground
color.separator              color.accent              control.border
color.selection              color.accent.contrast     control.radius
```

State colors keep their own names (`color.state.success`, `.warning`, `.danger`, `.info`) with a paired
`.contrast-background` for each, because the eight undefined names above were all of this shape.

### Material layer

Glass is a composition, not a background color:

```
material.glass.background      material.glass.blur
material.glass.border          material.glass.saturation
material.glass.shadow          material.glass.highlight
material.glass.fallback-background
```

Applied through `[data-material="glass"]`, with the fallback branch required.

### Themes

Light and dark as DTCG modifiers, compiled to `[data-theme="light"]` and `[data-theme="dark"]`. Earth and
planetary set `data-theme="dark"` on `<html>` in `index.html`. The attribute stops being something
inherited and becomes something the app declares.

### Cascade layers

```css
@layer reset, tokens, base, components, utilities, overrides;
```

`@mailwoman/react` writes into `tokens` and `components`. This is what keeps the package embeddable in
Docusaurus without claiming the page's global CSS, and it is why the docs bridge cannot lose to Infima on
specificity.

### Consumers

- `packages/earth`, `packages/planetary` — import `tokens.css` and `fonts.css`; their `app.css` files
  shrink to layout and stop carrying color literals.
- `docs/` — one bridge file mapping `--ifm-*` to the semantic tokens, so Docusaurus chrome and the theme
  toggle keep working. `theme-light.css` and `theme-dark.css` stop declaring the brand anchors and read
  them instead.
- Storybook — `.storybook/preview-tokens.css` is deleted; the real tokens serve it.

`packages/react/styles.css` is rewritten against the semantic names. No `--ifm-` string remains in it.

## Typography

Type is organized on two axes so the face is swappable. A rule never names a family; it names a scale
role, and a scale role names a face role. Changing the typeface edits five tokens.

### Face roles

| Role                  | Carries                                                     | Requirement of any face bound to it                                                   |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `font.family.display` | Wordmark, large titles                                      | —                                                                                     |
| `font.family.text`    | Titles, body, captions                                      | —                                                                                     |
| `font.family.number`  | Coordinates, diameters, confidence values                   | Tabular lining figures, so a column of coordinates does not shift width as it updates |
| `font.family.code`    | Identifiers, JSON, file paths                               | Monospaced, with `0`/`O` and `1`/`l` distinguishable                                  |
| `font.family.glyph`   | Control glyphs — close, chevron, compass letter, microphone | Monochrome, inherits color and size, sits on the text baseline                        |

Iosevka Nexus satisfies all five today, its mono covering number, code and glyph. That is why the single
face has not hurt yet, and it is also why nothing currently records which role a rule wanted. Binding the
roles now means the swap is an edit to `font.family.*` and to nothing else.

### Scale roles

Each names a face role and carries size, line height and weight. Apple's iOS metrics, our face.

| Scale role                                                                                                      | Face role        |
| --------------------------------------------------------------------------------------------------------------- | ---------------- |
| `font.display`, `font.large-title`                                                                              | `family.display` |
| `font.title`, `font.headline`, `font.body`, `font.callout`, `font.subheadline`, `font.footnote`, `font.caption` | `family.text`    |
| `font.number`, `font.number.compact`                                                                            | `family.number`  |
| `font.code`, `font.code.compact`                                                                                | `family.code`    |
| `font.glyph`, `font.glyph.large`                                                                                | `family.glyph`   |

`<button>` inherits the family. That single omission is why the deployed page renders Arial.

### Icons are SVG, not a font

A control glyph is typeset — it inherits color and size and aligns to the baseline, so it belongs to a
face role. An icon is artwork: the category markers in the reference are a colored disc carrying a white
mark, which a monochrome icon font cannot express. So `glyph` is a font role and `icons` is an SVG sprite
with a documented viewBox and a two-color contract.

There are zero inline `<svg>` elements across `@mailwoman/react`, `packages/earth` and
`packages/planetary` today. Every control glyph is a literal character — `✓` in `CopyButton`,
`PipelineExplorer` and `ResultPanel`, `×` in the planetary `FeaturePanel` — and two are emoji, `📍` and
`🏛` in `ResolvedPlace.tsx`. Emoji render per platform and cannot take the accent color; they are the
first thing the glyph role replaces.

### Map labels are a separate binding

A map label is drawn by MapLibre from a signed-distance-field glyph range, not by the browser from a
`@font-face`. So `font.family.*` does not reach the map, and a face bound in the DOM does not appear on
the globe until an SDF range for it exists in the bucket. Map labels therefore carry their own token,
`font.family.map`, whose value must name a stack the bucket serves.

## Map chrome

Five presentational components in `@mailwoman/react/map`, each taking tokens and children and holding no
app logic. The placement follows the operator's layout: search on top, examples beneath it, controls in a
right-hand column, footer near the bottom.

| Component           | Behavior                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `<MapSearchBar>`    | Fully rounded glass pill, leading and trailing icon slots. Wraps the host's input.                |
| `<MapChipRow>`      | Horizontal scroll, never wrap. Replaces Earth's 3/3/2/1/1/1 stack.                                |
| `<MapControlStack>` | Right-hand column of glass buttons, grouped into pills the way Apple groups map-type with locate. |
| `<MapCompass>`      | Enters the stack when bearing leaves north, fades out on return. Honors `prefers-reduced-motion`. |
| `<MapFooter>`       | Attribution and identity strip.                                                                   |

A result view arrives as a bottom sheet with a drag handle and rounded top corners, translucent over the
map, rather than inside a full-height panel.

Safe-area insets (`env(safe-area-inset-*)`) are semantic tokens consumed by the chrome, not repeated per
component. Both apps ship as installable PWAs through `vite-plugin-pwa` and neither handles insets today.

## Cartography

### Labels

- `"text-font"` becomes `["Noto Sans Regular"]` in `planetary/layers.ts` and `base/buildings.ts`. This
  alone restores every planetary nomenclature label and Earth's building labels.
- A tiered treatment matching the reference: region-scale features (`ME`, `PL`, `OC`, `TA`) uppercase and
  letterspaced, which `layers.ts` already does; water-analogue and basin names in `Noto Sans Italic`;
  point features in `Noto Sans Regular`. Size continues to interpolate on `diameterKm`.
- A `repo-health` check refuses a `text-font` value that is not in the bucket's served set, so the class
  of defect above cannot ship again.

### Mars

`PlanetaryPalette` gains `hillshadeAccent` and `hillshadeShadow`, and `hillshadeLayer()` reads them. Moon
takes the cool ramp, Mars the warm oxide ramp. The two bodies stop being the same picture.

### Space

A star field behind the globe, matching the reference: small light points at varied opacity on the body's
space color. Rendered behind a transparent map canvas so it does not rotate with the body.

### Framing

`framingZoom` is capped at the hillshade's own maximum zoom, so a selected feature is sharp
rather than the upsampled blur at zoom 7. The selected feature draws a label and a marker, so the panel
and the map name the same thing.

## Earth layout

Default view: wordmark, one line of what the page does, the search pill, the chip row, the control stack,
the footer. Results in a bottom sheet.

Model version, backend readout, Force WASM, Compare and the style-layer counts move under a **Developer**
section of the layers panel, reachable by toggle or `?dev=1`. Nothing is deleted; the expert set stops
being the front door.

`geocoder.module.css` loses the orphan `[data-theme="dark"]` rule and both `--ifm-navbar-height` offsets.

## Verification

- `300-demo-theme.spec.ts` stops setting `data-theme` and asserts the attribute the app sets.
- A contrast check over every semantic foreground/background pair in both themes. A light value inside the
  dark theme fails rather than ships.
- A check that `packages/react/styles.css` contains no `--ifm-` string.
- A `repo-health` check that every `text-font` in `packages/cartographer` names a served glyph stack.
- A render check that each app draws a non-zero count of label features after load, so a future glyph
  regression fails a test rather than shipping a blank body.
- Screenshots at phone and desktop widths, light and dark, over default, focus-visible, pressed, disabled,
  open and selected. Glass is excluded from pixel comparison; blur compositing varies by browser and host.

## Phases

Each phase is deployable on its own.

| #   | Contents                                                                                                                     | Result                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | `text-font` repair in both styles                                                                                            | Planetary labels and Earth building labels draw. One-line change, ships ahead of everything else                 |
| 2   | DTCG tokens, styleframe compile, `fonts.css`, docs bridge, cascade layers, delete the orphan selector and the navbar offsets | Panel readable, brand palette and typeface live, no layout change                                                |
| 3   | The five chrome components, glass material with fallback, safe-area and motion tokens                                        | Nothing in production yet; stories and tests                                                                     |
| 4   | Earth relayout, Developer demotion                                                                                           | The new front door                                                                                               |
| 5   | Mars ramp, star field, framing cap, planetary chrome                                                                         | Moon and Mars distinct and legible                                                                               |
| 6   | An SDF glyph range built from a `@font-face` source and published to the bucket                                              | A face chosen for the DOM can also be bound to `font.family.map`, so the globe and the panel read as one product |

## Open items

- Which face replaces Iosevka Nexus, and against which of the five role requirements it is judged. The
  role table is the acceptance list: tabular lining figures for `number`, a distinguishable `0`/`O` and
  `1`/`l` for `code`, baseline-aligned monochrome marks for `glyph`.
- Whether Earth's basemap gains category color and icon markers for POI labels, in the Google register.
  That is a basemap style change in `@mailwoman/cartographer` and a larger piece than the chrome work.
