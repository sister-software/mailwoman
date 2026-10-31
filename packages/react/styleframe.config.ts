/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Defines the design tokens for `@mailwoman/react`. `tokens.css` is generated from this file.
 *   `styleframe dtcg export` publishes the values as W3C DTCG JSON.
 *
 *   The brand comes from `@sister.software/theme`: color roles, type, spacing, shape and motion are the shared
 *   `--ss-*` tokens, including the dark theme the map apps select with `data-theme="dark"` on `<html>`. This file adds
 *   only what is Mailwoman's own, under `--mw-*`: the confidence and pipeline-stage colors, the app type scale, the
 *   glass material, the safe-area insets and the map's label font.
 *
 *   Component rules read `--ss-*` roles or `--mw-*` tokens, never a palette color.
 */

import {
	cssName,
	DispositionSpecs,
	dispositionTokens,
	nightTone,
	TokenIndex,
	type TokenEntry,
} from "@sister.software/theme"
import { createSisterSoftwareStyleframe, SisterSoftwareStyleframeOptions } from "@sister.software/theme/styleframe"

/**
 * Mailwoman's tokens use the `mw.<token>` names and compile to `--mw-<token>`; shared tokens keep `--ss-*`.
 */
const s = createSisterSoftwareStyleframe({
	...SisterSoftwareStyleframeOptions,
	variables: {
		name: ({ name }) => (name.startsWith("mw.") ? `mw-${name.slice(3)}` : cssName(name).slice(2)),
	},
})

const { variable, theme, ref } = s

// #region Product theme

/*
 * Mailwoman keeps the Sister Software structure (type, keys, hard shadows, windows) in its
 * own colors: the blue, navy and magenta of the seal instead of the house pinks and mint.
 *
 * Shared components read these color roles and inherit the product palette.
 * Each pair below holds at least 5.3:1.
 */

/**
 * Mailwoman's palette.
 */
const blue = "#1a00ff"
const sky = "#e6e9ff"
const rule = "#cfd4f0"

const Palette: readonly TokenEntry[] = [
	{ name: "mw.color-blue", value: blue, usage: "Links, primary fills, the current item. White on it 8.4:1." },
	{ name: "mw.color-navy", value: "#00093a", usage: "The seal's ground. Text on the light-blue night link." },
	{ name: "mw.color-magenta", value: "#ff00b0", usage: "The seal. Focal accents only." },
	{ name: "mw.color-ground", value: "#f6f7fb", usage: "Cool page ground. Charcoal 10.3:1, blue 7.9:1." },
	{ name: "mw.color-surface", value: "#edf0fb", usage: "Panels: TOC, footer." },
	{ name: "mw.color-sky", value: sky, usage: "Keys and the hero band. Charcoal 9.2:1, blue 7.0:1." },
	{ name: "mw.color-rule", value: rule, usage: "Hairline rules." },
	// The night tones are the day colors with the lights turned down, as in the shared dark theme.
	{ name: "mw.color-night", value: nightTone(sky, 0.2), usage: "Dark page ground: sky at night. Text 14.8:1." },
	{ name: "mw.color-night-surface", value: nightTone(sky, 0.235), usage: "Dark panels: TOC, footer." },
	{ name: "mw.color-night-raised", value: nightTone(sky, 0.27, 0.035), usage: "Dark raised fills. Text 12.3:1." },
	{ name: "mw.color-night-key", value: nightTone(sky, 0.3, 0.04), usage: "Dark keys. Text 11.2:1, link 5.3:1." },
	{ name: "mw.color-night-key-hover", value: nightTone(sky, 0.34, 0.045), usage: "A dark key under the pointer." },
	{ name: "mw.color-night-rule", value: nightTone(rule, 0.38, 0.035), usage: "Dark hairline rules." },
	{ name: "mw.color-night-edge", value: nightTone(rule, 0.48, 0.03), usage: "Dark panel and table borders." },
	{ name: "mw.color-night-table-head", value: nightTone(blue, 0.34, 0.08), usage: "Dark table header row." },
	{ name: "mw.color-night-shadow", value: nightTone(sky, 0.12, 0.02), usage: "Dark hard shadows, below the ground." },
	{ name: "mw.color-link-night", value: "#9a95ff", usage: "Dark links and primary fills. 5.3:1 or better." },
	{ name: "mw.color-focus-night", value: "#b9b5ff", usage: "Dark focus ring." },
]

for (const token of Palette) {
	variable(token.name, token.value)
}

const palette = new TokenIndex(Palette)

/**
 * Sets a role in both the default theme and the Paper scope (`data-theme="light"`), and optionally at night.
 */
const role = (name: string, paper: string, night?: string) => {
	const value = (v: string) => (v.startsWith("{") ? ref(v.slice(1, -1)) : v)

	variable(name, value(paper))
	theme("light", (context) => context.variable(name, value(paper)))

	if (night) {
		theme("dark", (context) => context.variable(name, value(night)))
	}
}

role("color.background", "{mw.color-ground}", "{mw.color-night}")
role("color.background-surface", "{mw.color-surface}", "{mw.color-night-surface}")
role("color.background-raised", "{color.white}", "{mw.color-night-raised}")
role("color.rail", "{mw.color-sky}", "{mw.color-night-surface}")
role("color.key", "{mw.color-sky}", "{mw.color-night-key}")
role("color.key-edge", "{mw.color-blue}", "{mw.color-link-night}")
role("color.key-hover", "{color.white}", "{mw.color-night-key-hover}")
role("color.key-current", "{color.white}", "{mw.color-night}")
role("color.utility", "{color.white}", "{mw.color-night-key}")
role("color.rule", "{mw.color-rule}", "{mw.color-night-rule}")
role("color.edge", "{color.frame-gray}", "{mw.color-night-edge}")
role("color.table-head", "{mw.color-sky}", "{mw.color-night-table-head}")
role("color.selected", "{mw.color-blue}", "{mw.color-link-night}")
role("color.chrome", "{color.chrome-bar-active}", "{mw.color-night-surface}")
role("color.chrome-inactive", "{color.chrome-bar}", "{mw.color-night-raised}")
role("color.frame", "{color.chrome-edge}", "{mw.color-night-rule}")
role("color.focus-ring", "{mw.color-blue}", "{mw.color-focus-night}")

// Hard shadows: blue-tinted on the day grounds, and at night a slab below the ground like every shared shadow.
const nightShadow = palette.resolve("mw.color-night-shadow")

role("shadow.tile", "-6px 9px 0 rgba(26, 0, 255, 0.22)", `-6px 9px 0 ${nightShadow}`)
role("shadow.tile-pressed", "-2px 3px 0 rgba(26, 0, 255, 0.22)", `-2px 3px 0 ${nightShadow}`)
role("shadow.utility", "-6px 9px 0 rgba(0, 9, 58, 0.14)", `-6px 9px 0 ${nightShadow}`)
role("shadow.utility-pressed", "-2px 3px 0 rgba(0, 9, 58, 0.14)", `-2px 3px 0 ${nightShadow}`)
theme("dark", (context) => context.variable("shadow.primary", `-6px 9px 0 ${nightShadow}`))

// The primary ladder is recomputed from Mailwoman blue with the shared theme's own arithmetic.
const primary = (base: string) =>
	dispositionTokens("primary", { ...DispositionSpecs.primary, base }, palette).filter(
		({ name }) => !name.includes("-contrast-") && name !== "color.primary"
	)

const nightPrimary = new Map(primary("mw.color-link-night").map(({ name, value }) => [name, value]))

role("color.primary", "{mw.color-blue}", "{mw.color-link-night}")

for (const { name, value } of primary("mw.color-blue")) {
	role(name, value, nightPrimary.get(name))
}

// #endregion

// #region Confidence and stages

/**
 * The three confidence tiers.
 *
 * They reuse the shared dispositions: high maps to success, mid to warning and low to danger.
 * Every confidence display should read these tokens so the legend matches the results.
 */
variable("mw.color-confidence-high", ref("color.success"))
variable("mw.color-confidence-high-tint", ref("color.success-contrast-background"))
variable("mw.color-confidence-mid", ref("color.warning"))
variable("mw.color-confidence-mid-tint", ref("color.warning-contrast-background"))
variable("mw.color-confidence-low", ref("color.danger"))
variable("mw.color-confidence-low-tint", ref("color.danger-contrast-background"))

/**
 * The pipeline stage hues for the timing bar.
 *
 * They avoid the confidence colors so that green keeps a single meaning.
 */
variable("mw.color-stage-shape", ref("figure.cobalt"))
variable("mw.color-stage-classify", ref("figure.violet"))
variable("mw.color-stage-resolve", ref("color.turquoise"))

// #endregion

// #region Type

/**
 * The app type scale.
 *
 * The docs use Infima's heading sizes.
 * The map apps set denser UI text on this scale.
 */
variable("mw.font-size-display", "2.125rem")
variable("mw.font-size-title", "1.375rem")
variable("mw.font-size-headline", "1.0625rem")
variable("mw.font-size-body", "1.0625rem")
variable("mw.font-size-callout", "1rem")
variable("mw.font-size-subheadline", "0.9375rem")
variable("mw.font-size-footnote", "0.8125rem")
variable("mw.font-size-caption", "0.75rem")

/**
 * The SDF font stack for map labels.
 *
 * MapLibre draws labels from signed-distance-field glyph ranges, so the DOM faces do not apply to the map.
 * The value must be a stack that the glyph host serves.
 *
 * Go has no glyph ranges there yet, so labels stay on Bliss Pro.
 */
variable("mw.font-family-map", `"Bliss Pro Regular"`)

// #endregion

// #region Layout

/**
 * The safe-area insets.
 *
 * They stay `env()` expressions because each device resolves them at runtime.
 */
variable("mw.safe-area-top", "env(safe-area-inset-top, 0px)")
variable("mw.safe-area-right", "env(safe-area-inset-right, 0px)")
variable("mw.safe-area-bottom", "env(safe-area-inset-bottom, 0px)")
variable("mw.safe-area-left", "env(safe-area-inset-left, 0px)")

/**
 * The height of the map footer strip.
 *
 * The strip and any sheet that ends above it both read this token.
 */
variable("mw.map-footer-height", "1.9rem")

// #endregion

// #region Material

/*
 * The glass material for panels floating over the map: a background, border,
 * blur, saturation, shadow and highlight.
 * Its shadow is the brand's hard offset rather than a blur.
 */

const glassBackground = variable("mw.material-glass-background", "rgba(246, 242, 241, 0.78)")
const glassBorder = variable("mw.material-glass-border", ref("color.emphasis-300"))
variable("mw.material-glass-blur", "24px")
variable("mw.material-glass-saturation", "180%")
const glassShadow = variable("mw.material-glass-shadow", ref("shadow.utility"))
const glassHighlight = variable("mw.material-glass-highlight", "rgba(255, 255, 255, 0.5)")

/**
 * The opaque glass background for browsers without `backdrop-filter`
 * and for viewers who prefer reduced transparency.
 */
variable("mw.material-glass-fallback-background", ref("color.background-raised"))

theme("dark", ({ variable: themeVariable }) => {
	// The dark glass is more opaque than the light glass so that white map labels
	// do not show through the blur behind a search field.
	themeVariable(glassBackground, "rgba(27, 30, 32, 0.86)")
	themeVariable(glassBorder, "rgba(236, 231, 229, 0.14)")
	themeVariable(glassShadow, "-6px 9px 0 rgba(0, 0, 0, 0.45)")
	themeVariable(glassHighlight, "rgba(236, 231, 229, 0.12)")
})

// #endregion

export default s
