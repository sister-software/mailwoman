/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The design tokens every consumer of `@mailwoman/react` reads. This file is the source of record; `tokens.css` is
 *   its compiled output and is generated, never hand-edited. `styleframe dtcg export` publishes the same values as
 *   W3C DTCG JSON for Figma and any other tool — DTCG is the interchange format here, not the input, because
 *   `styleframe dtcg import` is a one-shot code generator rather than a build step.
 *
 *   THREE LAYERS, and a component rule may read only the middle one. Primitives are raw values with no opinion about
 *   use; semantics say what a value is FOR; the few component tokens exist where a component needs a name of its own.
 *   `styles.css` reading raw primitives is the defect this file replaces: it read 22 Infima names it did not own, and
 *   eight of them were undefined in production, so those rules silently took Infima's LIGHT fallbacks inside a dark
 *   app.
 *
 *   THEMES. Light is the docs site; dark is the three map apps, which set `data-theme="dark"` on `<html>` themselves.
 *   Every semantic token is defined in both, so a value can never resolve to nothing.
 */

import { styleframe } from "styleframe"

const s = styleframe({
	themes: {
		// The apps and the docs toggle both address a theme by attribute rather than by class.
		selector: ({ name }) => `[data-theme="${name}"]`,
	},
})

const { variable, theme, ref } = s

//#region Primitives

/*
 * Raw values with no opinion about use. Only the semantic layer below may reference them; a component rule that
 * reaches one has skipped the layer that says what the value is for.
 */

/**
 * The brand anchors, carried verbatim from the design system. `#ff00b0` is the primary; Earth shipped a drifted
 * `#e0367c` for as long as it read Infima's palette, and that value is retired.
 */
const brandMagenta = variable("brand-magenta", "#ff00b0")
const brandBlue = variable("brand-blue", "#1a00ff")
const brandNavy = variable("brand-navy", "#00093a")
const brandAmber = variable("brand-amber", "hsl(39deg 100% 50%)")
const brandTeal = variable("brand-teal", "hsl(97.78deg 100% 50%)")

/**
 * Neutrals in OKLCH so the lightness steps are perceptually even rather than even in sRGB, where a mid-grey reads
 * darker than its number. One hue for the whole ramp keeps chrome from drifting warm at one end and cool at the other.
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
 * State hues. Each carries a strong value for text and marks, and a tint for the background behind them.
 */
const successBase = variable("success-base", "oklch(62% 0.15 150)")
const warningBase = variable("warning-base", "oklch(75% 0.15 75)")
const dangerBase = variable("danger-base", "oklch(58% 0.2 25)")
const infoBase = variable("info-base", "oklch(65% 0.13 230)")

//#endregion

//#region Type

/*
 * Two axes. A rule names a scale role; a scale role names a face role; only a face role names a family.
 */

/**
 * Swapping the typeface edits these five and nothing else. Each role states what any face bound to it must do: `number`
 * needs tabular lining figures so a column of coordinates holds its width as it updates; `code` needs `0` and `O`, `1`
 * and `l` to be told apart; `glyph` needs monochrome marks that sit on the text baseline.
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
 * A map label is drawn by MapLibre from a signed-distance-field range rather than by the browser from a `@font-face`,
 * so the DOM faces above cannot reach the globe. This names the SDF stack, and its value must be one the glyph host
 * serves — today `Noto Sans Regular`, `Noto Sans Medium` or `Noto Sans Italic`.
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

//#endregion

//#region Shape and motion

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
 * Safe-area insets belong to the chrome, not to each component that happens to sit near an edge. They stay CSS
 * expressions because `env()` resolves per device and has no static value.
 */
variable("safe-area-top", "env(safe-area-inset-top, 0px)")
variable("safe-area-right", "env(safe-area-inset-right, 0px)")
variable("safe-area-bottom", "env(safe-area-inset-bottom, 0px)")
variable("safe-area-left", "env(safe-area-inset-left, 0px)")

/**
 * How tall the footer strip stands, so a sheet ending above it and the strip itself read one number instead of two that
 * drift. One line of caption type over 0.35rem of padding on each side.
 */
variable("map-footer-height", "1.9rem")

//#endregion

//#region Semantics

/*
 * The one layer a component rule may read. Every token here is defined in light and overridden in dark, so a value
 * can never resolve to nothing the way eight Infima names did in production.
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
 * Every state colour carries a paired tint for the ground behind it. The eight names that were undefined in production
 * were all of this shape — a foreground whose background partner was missing.
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

//#endregion

//#region Material

/*
 * Glass is a composition of background, border, blur, saturation, shadow and highlight — never one background
 * colour, because the parts respond differently to the ground behind them.
 */

const glassBackground = variable("material-glass-background", "oklch(100% 0 264 / 0.72)")
const glassBorder = variable("material-glass-border", "oklch(0% 0 264 / 0.1)")
const glassBlur = variable("material-glass-blur", "24px")
const glassSaturation = variable("material-glass-saturation", "180%")
const glassShadow = variable("material-glass-shadow", "0 4px 28px oklch(0% 0 264 / 0.14)")
const glassHighlight = variable("material-glass-highlight", "oklch(100% 0 264 / 0.5)")

/**
 * What the material becomes where `backdrop-filter` is unavailable or the viewer asks for less transparency. It is
 * opaque on purpose: no control may depend on the blur to stay readable.
 */
const glassFallbackBackground = variable("material-glass-fallback-background", ref(neutral0))

//#endregion

//#region Dark theme — the three map apps, and the docs toggle.

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

	// The state hues lift in a dark ground: the same hue at higher lightness reads at the same strength.
	themeVariable(stateSuccess, "oklch(76% 0.16 150)")
	themeVariable(stateSuccessBackground, "oklch(76% 0.16 150 / 0.18)")
	themeVariable(stateWarning, "oklch(84% 0.15 75)")
	themeVariable(stateWarningBackground, "oklch(84% 0.15 75 / 0.18)")
	themeVariable(stateDanger, "oklch(70% 0.19 25)")
	themeVariable(stateDangerBackground, "oklch(70% 0.19 25 / 0.18)")
	themeVariable(stateInfo, "oklch(78% 0.12 230)")
	themeVariable(stateInfoBackground, "oklch(78% 0.12 230 / 0.18)")
	themeVariable(accentBackground, "oklch(65% 0.29 340 / 0.18)")

	// Denser than the light theme's 0.72: a dark pane over a bright map lets a white label under it read through the
	// blur, and the pane a search field sits on may never compete with the text typed into it.
	themeVariable(glassBackground, "oklch(18% 0.026 264 / 0.86)")
	themeVariable(glassBorder, "oklch(100% 0 264 / 0.14)")
	themeVariable(glassShadow, "0 4px 28px oklch(0% 0 264 / 0.45)")
	themeVariable(glassHighlight, "oklch(100% 0 264 / 0.12)")
	themeVariable(glassFallbackBackground, ref(neutral900))
})

//#endregion

// Referenced by name from `styles.css` and the app stylesheets; listed here so the compiler keeps them.
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
	radiusControl,
	radiusPanel,
	radiusSheet,
	radiusPill,
	durationFast,
	durationStandard,
	durationSheet,
	easingStandard,
	easingDecelerate,
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

export default s
