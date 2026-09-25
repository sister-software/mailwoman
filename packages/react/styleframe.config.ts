/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The design tokens for `@mailwoman/react`. This file is the source of record, and `tokens.css` is generated
 *   from it. `styleframe dtcg export` publishes the same values as W3C DTCG JSON.
 *
 *   The tokens have three layers. Primitives are raw values. Semantic tokens describe what a value is used for, and
 *   component rules may read only this layer. Component tokens exist where a component needs a name of its own.
 *
 *   The light theme serves the docs site. The dark theme serves the map apps, which set `data-theme="dark"` on
 *   `<html>`. Every semantic token has a value in both themes.
 */

import { styleframe } from "styleframe"

const s = styleframe({
	themes: {
		// The apps and the docs toggle select a theme by attribute.
		selector: ({ name }) => `[data-theme="${name}"]`,
	},
})

const { variable, theme, ref } = s

// #region Primitives

/*
 * Only the semantic layer may reference primitives.
 */

/**
 * The brand colours from the design system.
 * `#ff00b0` is the primary.
 */
const brandMagenta = variable("brand-magenta", "#ff00b0")
const brandBlue = variable("brand-blue", "#1a00ff")
const brandNavy = variable("brand-navy", "#00093a")
const brandAmber = variable("brand-amber", "hsl(39deg 100% 50%)")
const brandTeal = variable("brand-teal", "hsl(97.78deg 100% 50%)")

/**
 * The neutral ramp.
 *
 * It uses oklch so the lightness steps are perceptually even, and one hue
 * so the ramp keeps a constant temperature.
 */
const neutral0 = variable("neutral-0", "oklch(100% 0 264)")
const neutral50 = variable("neutral-50", "oklch(97% 0.004 264)")
const neutral100 = variable("neutral-100", "oklch(93% 0.006 264)")
const neutral200 = variable("neutral-200", "oklch(87% 0.01 264)")
const neutral300 = variable("neutral-300", "oklch(78% 0.015 264)")
const neutral400 = variable("neutral-400", "oklch(66% 0.02 264)")
const neutral500 = variable("neutral-500", "oklch(55% 0.024 264)")
const neutral600 = variable("neutral-600", "oklch(45% 0.026 264)")
const neutral700 = variable("neutral-700", "oklch(35% 0.028 264)")
const neutral800 = variable("neutral-800", "oklch(26% 0.028 264)")
const neutral900 = variable("neutral-900", "oklch(18% 0.026 264)")
const neutral950 = variable("neutral-950", "oklch(12% 0.022 264)")
const neutral1000 = variable("neutral-1000", "oklch(0% 0 264)")

/**
 * The base state hues.
 *
 * The semantic layer derives a strong value and a background tint from each.
 */
const successBase = variable("success-base", "oklch(62% 0.15 150)")
const warningBase = variable("warning-base", "oklch(75% 0.15 75)")
const dangerBase = variable("danger-base", "oklch(58% 0.2 25)")
const infoBase = variable("info-base", "oklch(65% 0.13 230)")

// #endregion

// #region Type

/*
 * A rule refers to a scale role, a scale role refers to a face role,
 * and only a face role refers to a font family.
 */

/**
 * The face roles.
 * A typeface change edits only these five tokens.
 *
 * The `number` face needs tabular lining figures so a column of coordinates keeps its width.
 * The `code` face must distinguish `0` from `O` and `1` from `l`.
 *
 * The `glyph` face needs monochrome marks that sit on the text baseline.
 */
const fontFamilyDisplay = variable("font-family-display", `"Iosevka Nexus Web", "Iosevka", system-ui, sans-serif`)
const fontFamilyText = variable("font-family-text", `"Iosevka Nexus Web", "Iosevka", system-ui, sans-serif`)
const fontFamilyNumber = variable("font-family-number", `"Iosevka Nexus Web", "Iosevka", system-ui, sans-serif`)

const fontFamilyCode = variable(
	"font-family-code",
	`"Iosevka Nexus Mono Web", "Iosevka", ui-monospace, "SF Mono", monospace`
)

const fontFamilyGlyph = variable("font-family-glyph", `"Iosevka Nexus Mono Web", "Iosevka", ui-monospace, monospace`)

/**
 * The SDF font stack for map labels.
 *
 * MapLibre draws labels from signed-distance-field glyph ranges, so the DOM
 * faces above do not apply to the map.
 *
 * The value must be a stack that the glyph host serves.
 */
const fontFamilyMap = variable("font-family-map", `"Noto Sans Regular"`)

const fontSizeDisplay = variable("font-size-display", "2.125rem")
const fontSizeTitle = variable("font-size-title", "1.375rem")
const fontSizeHeadline = variable("font-size-headline", "1.0625rem")
const fontSizeBody = variable("font-size-body", "1.0625rem")
const fontSizeCallout = variable("font-size-callout", "1rem")
const fontSizeSubheadline = variable("font-size-subheadline", "0.9375rem")
const fontSizeFootnote = variable("font-size-footnote", "0.8125rem")
const fontSizeCaption = variable("font-size-caption", "0.75rem")

const lineHeightTight = variable("line-height-tight", "1.2")
const lineHeightBody = variable("line-height-body", "1.45")

const fontWeightRegular = variable("font-weight-regular", "400")
const fontWeightMedium = variable("font-weight-medium", "500")
const fontWeightSemibold = variable("font-weight-semibold", "600")

// #endregion

// #region Shape and motion

/**
 * The spacing scale, in seven steps on a 2px grid.
 * Padding, margins and gaps should use these steps.
 */
const space0 = variable("space-0", "0.125rem")
const space1 = variable("space-1", "0.25rem")
const space2 = variable("space-2", "0.375rem")
const space3 = variable("space-3", "0.5rem")
const space4 = variable("space-4", "0.75rem")
const space5 = variable("space-5", "1rem")
const space6 = variable("space-6", "1.5rem")

/**
 * The radius scale.
 *
 * `radius-tick` is for marks a few pixels across, such as a legend swatch,
 * where a larger radius would distort the shape.
 * `radius-tight` is for inline blocks.
 */
const radiusTick = variable("radius-tick", "0.125rem")
const radiusTight = variable("radius-tight", "0.25rem")
const radiusControl = variable("radius-control", "0.5rem")
const radiusPanel = variable("radius-panel", "0.875rem")
const radiusSheet = variable("radius-sheet", "0.875rem")
const radiusPill = variable("radius-pill", "999px")

const durationFast = variable("duration-fast", "120ms")
const durationStandard = variable("duration-standard", "220ms")
const durationSheet = variable("duration-sheet", "320ms")
const easingStandard = variable("easing-standard", "cubic-bezier(0.4, 0, 0.2, 1)")
const easingDecelerate = variable("easing-decelerate", "cubic-bezier(0, 0, 0.2, 1)")

/**
 * The safe-area insets.
 *
 * They stay `env()` expressions because each device resolves them at runtime.
 */
variable("safe-area-top", "env(safe-area-inset-top, 0px)")
variable("safe-area-right", "env(safe-area-inset-right, 0px)")
variable("safe-area-bottom", "env(safe-area-inset-bottom, 0px)")
variable("safe-area-left", "env(safe-area-inset-left, 0px)")

/**
 * The height of the map footer strip.
 *
 * The strip and any sheet that ends above it both read this token.
 */
variable("map-footer-height", "1.9rem")

// #endregion

// #region Semantics

/*
 * Component rules may read only this layer.
 *
 * The dark theme below overrides these tokens where the light value does not suit a dark ground.
 */

const backgroundCanvas = variable("color-background-canvas", ref(neutral50))
const backgroundRaised = variable("color-background-raised", ref(neutral0))
const backgroundSunken = variable("color-background-sunken", ref(neutral100))

const textPrimary = variable("color-text-primary", ref(neutral900))
const textSecondary = variable("color-text-secondary", ref(neutral600))
const textTertiary = variable("color-text-tertiary", ref(neutral500))

const separator = variable("color-separator", ref(neutral200))
const accent = variable("color-accent", ref(brandMagenta))
const accentContrast = variable("color-accent-contrast", ref(neutral0))
const selection = variable("color-selection", ref(brandMagenta))

const controlBackground = variable("control-background", ref(neutral100))
const controlBackgroundPressed = variable("control-background-pressed", ref(neutral200))
const controlForeground = variable("control-foreground", ref(neutral900))
const controlBorder = variable("control-border", ref(neutral300))

/**
 * The state colours.
 * Each colour has a paired background tint.
 */
const stateSuccess = variable("color-state-success", ref(successBase))
const stateSuccessBackground = variable("color-state-success-background", "oklch(62% 0.15 150 / 0.14)")
const stateWarning = variable("color-state-warning", ref(warningBase))
const stateWarningBackground = variable("color-state-warning-background", "oklch(75% 0.15 75 / 0.16)")
const stateDanger = variable("color-state-danger", ref(dangerBase))
const stateDangerBackground = variable("color-state-danger-background", "oklch(58% 0.2 25 / 0.14)")
const stateInfo = variable("color-state-info", ref(infoBase))
const stateInfoBackground = variable("color-state-info-background", "oklch(65% 0.13 230 / 0.14)")

const accentBackground = variable("color-accent-background", "oklch(65% 0.29 340 / 0.14)")

/**
 * The three confidence tiers.
 *
 * They reuse the state palette: high maps to success, mid to warning and low to danger.
 * Every confidence display should read these tokens so the legend matches the results.
 */
const confidenceHigh = variable("color-confidence-high", ref(stateSuccess))
const confidenceHighTint = variable("color-confidence-high-tint", ref(stateSuccessBackground))
const confidenceMid = variable("color-confidence-mid", ref(stateWarning))
const confidenceMidTint = variable("color-confidence-mid-tint", ref(stateWarningBackground))
const confidenceLow = variable("color-confidence-low", ref(stateDanger))
const confidenceLowTint = variable("color-confidence-low-tint", ref(stateDangerBackground))

/**
 * The pipeline stage hues for the timing bar.
 *
 * They avoid the confidence colours so that green keeps a single meaning.
 */
const stageShape = variable("color-stage-shape", "#3578e5")
const stageClassify = variable("color-stage-classify", "#8b5cf6")
const stageResolve = variable("color-stage-resolve", "#14b8a6")

// #endregion

// #region Material

/*
 * The glass material combines a background, border, blur, saturation, shadow and highlight.
 */

const glassBackground = variable("material-glass-background", "oklch(100% 0 264 / 0.72)")
const glassBorder = variable("material-glass-border", "oklch(0% 0 264 / 0.1)")
const glassBlur = variable("material-glass-blur", "24px")
const glassSaturation = variable("material-glass-saturation", "180%")
const glassShadow = variable("material-glass-shadow", "0 4px 28px oklch(0% 0 264 / 0.14)")
const glassHighlight = variable("material-glass-highlight", "oklch(100% 0 264 / 0.5)")

/**
 * The opaque glass background for browsers without `backdrop-filter`
 * and for viewers who prefer reduced transparency.
 */
const glassFallbackBackground = variable("material-glass-fallback-background", ref(neutral0))

// #endregion

// #region Dark theme

theme("dark", ({ variable: themeVariable }) => {
	themeVariable(backgroundCanvas, ref(neutral950))
	themeVariable(backgroundRaised, ref(neutral900))
	themeVariable(backgroundSunken, ref(neutral1000))

	themeVariable(textPrimary, ref(neutral100))
	themeVariable(textSecondary, ref(neutral400))
	themeVariable(textTertiary, ref(neutral500))

	themeVariable(separator, "oklch(100% 0 264 / 0.12)")
	themeVariable(accentContrast, ref(neutral1000))

	themeVariable(controlBackground, "oklch(100% 0 264 / 0.08)")
	themeVariable(controlBackgroundPressed, "oklch(100% 0 264 / 0.14)")
	themeVariable(controlForeground, ref(neutral100))
	themeVariable(controlBorder, "oklch(100% 0 264 / 0.16)")

	// The state hues use higher lightness on a dark ground so they read at the same strength.
	themeVariable(stateSuccess, "oklch(76% 0.16 150)")
	themeVariable(stateSuccessBackground, "oklch(76% 0.16 150 / 0.18)")
	themeVariable(stateWarning, "oklch(84% 0.15 75)")
	themeVariable(stateWarningBackground, "oklch(84% 0.15 75 / 0.18)")
	themeVariable(stateDanger, "oklch(70% 0.19 25)")
	themeVariable(stateDangerBackground, "oklch(70% 0.19 25 / 0.18)")
	themeVariable(stateInfo, "oklch(78% 0.12 230)")
	themeVariable(stateInfoBackground, "oklch(78% 0.12 230 / 0.18)")
	themeVariable(accentBackground, "oklch(65% 0.29 340 / 0.18)")

	// The dark glass is more opaque than the light glass so that white map labels
	// do not show through the blur behind a search field.
	themeVariable(glassBackground, "oklch(18% 0.026 264 / 0.86)")
	themeVariable(glassBorder, "oklch(100% 0 264 / 0.14)")
	themeVariable(glassShadow, "0 4px 28px oklch(0% 0 264 / 0.45)")
	themeVariable(glassHighlight, "oklch(100% 0 264 / 0.12)")
	themeVariable(glassFallbackBackground, ref(neutral900))
})

// #endregion

// The stylesheets read these tokens by name.
// This list keeps the compiler from dropping them.
void [
	brandBlue,
	brandNavy,
	brandAmber,
	brandTeal,
	neutral700,
	neutral800,
	fontFamilyDisplay,
	fontFamilyText,
	fontFamilyNumber,
	fontFamilyCode,
	fontFamilyGlyph,
	fontFamilyMap,
	fontSizeDisplay,
	fontSizeTitle,
	fontSizeHeadline,
	fontSizeBody,
	fontSizeCallout,
	fontSizeSubheadline,
	fontSizeFootnote,
	fontSizeCaption,
	lineHeightTight,
	lineHeightBody,
	fontWeightRegular,
	fontWeightMedium,
	fontWeightSemibold,
	space0,
	space1,
	space2,
	space3,
	space4,
	space5,
	space6,
	radiusTick,
	radiusTight,
	radiusControl,
	radiusPanel,
	radiusSheet,
	radiusPill,
	durationFast,
	durationStandard,
	durationSheet,
	easingStandard,
	easingDecelerate,
	confidenceHigh,
	confidenceHighTint,
	confidenceMid,
	confidenceMidTint,
	confidenceLow,
	confidenceLowTint,
	stageShape,
	stageClassify,
	stageResolve,
	backgroundRaised,
	backgroundSunken,
	textSecondary,
	textTertiary,
	separator,
	accent,
	accentContrast,
	accentBackground,
	selection,
	controlBackground,
	controlBackgroundPressed,
	controlForeground,
	controlBorder,
	stateSuccess,
	stateSuccessBackground,
	stateWarning,
	stateWarningBackground,
	stateDanger,
	stateDangerBackground,
	stateInfo,
	stateInfoBackground,
	glassBackground,
	glassBorder,
	glassBlur,
	glassSaturation,
	glassShadow,
	glassHighlight,
	glassFallbackBackground,
	neutral400,
	neutral600,
	backgroundCanvas,
	textPrimary,
]

/**
 * The styleframe instance that compiles to `tokens.css`.
 */
export default s
