/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Defines the design tokens for `@mailwoman/react`. `tokens.css` is generated from this file.
 *   `styleframe dtcg export` publishes the values as W3C DTCG JSON.
 *
 *   The brand comes from `@sister.software/theme`: colour roles, type, spacing, shape and motion are the shared
 *   `--ss-*` tokens, including the dark theme the map apps select with `data-theme="dark"` on `<html>`. This file adds
 *   only what is Mailwoman's own, under `--mw-*`: the confidence and pipeline-stage colours, the app type scale, the
 *   glass material, the safe-area insets and the map's label font.
 *
 *   Component rules read `--ss-*` roles or `--mw-*` tokens, never a palette colour.
 */

import { cssName } from "@sister.software/theme"
import { createSisterSoftwareStyleframe, SisterSoftwareStyleframeOptions } from "@sister.software/theme/styleframe"

/**
 * Mailwoman's tokens are named `mw.<token>` and compile to `--mw-<token>`; the shared tokens keep `--ss-*`.
 */
const s = createSisterSoftwareStyleframe({
	...SisterSoftwareStyleframeOptions,
	variables: {
		name: ({ name }) => (name.startsWith("mw.") ? `mw-${name.slice(3)}` : cssName(name).slice(2)),
	},
})

const { variable, theme, ref } = s

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
 * They avoid the confidence colours so that green keeps a single meaning.
 */
variable("mw.color-stage-shape", ref("figure.cobalt"))
variable("mw.color-stage-classify", ref("figure.violet"))
variable("mw.color-stage-resolve", ref("color.turquoise"))

// #endregion

// #region Type

/**
 * The app type scale.
 *
 * The docs use Infima's heading sizes; the map apps set denser UI text on this scale.
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
 * The value must be a stack that the glyph host serves; Go has no glyph ranges there
 * yet, so labels stay on Bliss Pro.
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
