/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Checks the stylesheet invariants that the map apps' chrome depends on.
 *
 *   The check asserts two resets on the system stylesheet and runs detectors over every app stylesheet. `docs/` is
 *   out of scope because the Docusaurus site uses Infima's styles.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { normalizeWhitespace } from "@mailwoman/core/strings/format"
import { relative } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * The stylesheet that holds the design system's reset and base layer.
 */
const SYSTEM_STYLESHEET = "packages/react/styles.css"

/**
 * One style rule with its selector list, declaration body and enclosing at-rules.
 *
 * The enclosing at-rules identify a material fallback.
 * Only rules inside `@supports not (backdrop-filter…)` or `@media (prefers-reduced-transparency: reduce)`
 * count as the fallback, even though other rules may paint the fallback colour.
 */
interface StyleRule {
	selector: string
	body: string
	line: number
	/**
	 * Every enclosing at-rule preamble, outermost first, such as `@layer components`.
	 */
	context: readonly string[]
}

/**
 * Splits a stylesheet into rules and records the at-rules around each one.
 *
 * The parser replaces comments with spaces, so line numbers match the file
 * and a declaration inside a comment is ignored.
 */
function styleRules(css: string): StyleRule[] {
	const clean = css.replaceAll(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replaceAll(/[^\n]/gu, " "))
	const rules: StyleRule[] = []
	const context: string[] = []
	// `pending` holds the text since the last brace.
	let pending = ""
	// `selectorLine` records the line of the first non-blank character in `pending`,
	// so a diagnostic points at the selector itself.
	let line = 1
	let selectorLine = 1

	for (let index = 0; index < clean.length; index++) {
		const character = clean[index]!

		if (character === "\n") {
			line++
		} else if (!pending.trim() && character.trim()) {
			selectorLine = line
		}

		if (character === "{") {
			const preamble = normalizeWhitespace(pending)

			pending = ""

			if (preamble.startsWith("@")) {
				context.push(preamble)

				continue
			}

			// A declaration block ends at the next closing brace because declarations contain no braces.
			const close = clean.indexOf("}", index)
			const end = close === -1 ? clean.length : close
			const body = clean.slice(index + 1, end)

			if (preamble) {
				rules.push({ selector: preamble, body, line: selectorLine, context: [...context] })
			}

			for (const skipped of body) {
				if (skipped === "\n") {
					line++
				}
			}

			index = end

			continue
		}

		if (character === "}") {
			context.pop()
			pending = ""

			continue
		}

		pending += character
	}

	return rules
}

/**
 * Returns whether the rule sits inside an at-rule that guards a material's opaque fallback.
 */
function isMaterialFallback(rule: StyleRule): boolean {
	return rule.context.some(
		(at) => at.startsWith("@supports not") || /prefers-reduced-transparency\s*:\s*reduce/u.test(at)
	)
}

function declares(body: string, property: string): boolean {
	return new RegExp(String.raw`(?:^|[;{])\s*${property}\s*:`, "u").test(body)
}

/**
 * Matches a selector for a state such as `:hover`, `:disabled` or a `--active` modifier.
 *
 * A state rule declares only what changes and inherits its color from the base rule.
 */
const STATE_SELECTOR = /:(?:hover|active|disabled|focus|focus-visible|focus-within|checked|first|last|nth)|--[a-z]+$/u

/**
 * Properties with a `-webkit-` twin.
 *
 * The minifier keeps only the last declaration of such a pair, so the standard property must come last.
 */
const VENDOR_PAIRS = ["backdrop-filter", "mask-image", "user-select", "text-stroke", "box-decoration-break"] as const

/**
 * Matches a `border-radius` written in raw pixels.
 *
 * Rules should use the `--radius-*` tokens instead.
 * Values without `px`, such as `0` and `50%`, pass.
 */
const RAW_RADIUS = /border-radius\s*:\s*[^;}]*\d+px/u

// The token that marks a glass surface, and the token that its fallbacks paint instead.
const MATERIAL_BACKGROUND = "var(--material-glass-background)"
const MATERIAL_FALLBACK = "var(--material-glass-fallback-background)"

/**
 * Returns a selector list as an order-independent key, so a fallback that lists
 * the same surfaces in another order still matches.
 */
function selectorSet(selector: string): string {
	return selector
		.split(",")
		.map((part) => part.trim())
		.toSorted()
		.join(", ")
}

/**
 * Returns the diagnostics for one stylesheet's text.
 * Tests call it directly with failing inputs.
 *
 * @param file The repo-relative path.
 * The system-wide invariants apply only to {@link SYSTEM_STYLESHEET}.
 */
export function stylesheetDiagnostics(file: string, css: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const rules = styleRules(css)

	// The system stylesheet must carry the box-sizing reset and the button color default.
	if (file === SYSTEM_STYLESHEET) {
		const universalBorderBox = rules.some(
			(rule) => rule.selector.includes("*") && /box-sizing\s*:\s*border-box/u.test(rule.body)
		)

		if (!universalBorderBox) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				file,
				message:
					"No universal `box-sizing: border-box` reset. Without it `max-height` measures the content box, so any rule pairing a size with padding overflows its own cap.",
			})
		}

		const buttonColor = rules.some(
			(rule) => /(?:^|[\s,])button(?:[\s,]|$)/u.test(rule.selector) && /color\s*:\s*inherit/u.test(rule.body)
		)

		if (!buttonColor) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				file,
				message:
					"No `button { color: inherit }` default. A button paints the user agent's `buttontext` otherwise, which is near-black inside a dark panel.",
			})
		}
	}

	// The detectors run over every rule in every app stylesheet.
	for (const rule of rules) {
		const paintsBackground = declares(rule.body, "background") || declares(rule.body, "background-color")

		if (
			paintsBackground &&
			declares(rule.body, "cursor") &&
			!declares(rule.body, "color") &&
			!STATE_SELECTOR.test(rule.selector)
		) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				file,
				line: rule.line,
				message: `\`${rule.selector}\` paints an interactive background and states no color, so its text takes whatever the user agent last decided.`,
			})
		}

		if (RAW_RADIUS.test(rule.body)) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				file,
				line: rule.line,
				message: `\`${rule.selector}\` sets \`border-radius\` in raw pixels. The radius scale is \`--radius-tick\`, \`--radius-tight\`, \`--radius-control\`, \`--radius-panel\` / \`--radius-sheet\` and \`--radius-pill\`; a seventh value nobody can name is how two surfaces meant to match stop matching.`,
			})
		}

		for (const property of VENDOR_PAIRS) {
			const standard = new RegExp(String.raw`(?:^|[;{])\s*${property}\s*:`, "u").exec(rule.body)?.index
			const prefixed = new RegExp(String.raw`-webkit-${property}\s*:`, "u").exec(rule.body)?.index

			if (standard !== undefined && prefixed !== undefined && standard < prefixed) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					file,
					line: rule.line,
					message: `\`${rule.selector}\` declares \`${property}\` before \`-webkit-${property}\`. The minifier keeps the last of the pair, so the standard property is the one dropped from the bundle.`,
				})
			}
		}
	}

	// Each material fallback must list the same selectors as the material.
	const material = rules.find((rule) => rule.body.includes(MATERIAL_BACKGROUND))

	if (material) {
		const surfaces = selectorSet(material.selector)

		for (const rule of rules) {
			if (!rule.body.includes(MATERIAL_FALLBACK) || !isMaterialFallback(rule)) continue

			if (selectorSet(rule.selector) !== surfaces) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					file,
					line: rule.line,
					message:
						"A material fallback names a different set of surfaces than the material does, so a surface missing here keeps its transparency where the blur cannot run or the viewer asked for less of it.",
				})
			}
		}
	}

	return diagnostics
}

/**
 * The `stylesheet-interface` check.
 *
 * It runs {@link stylesheetDiagnostics} over every tracked app stylesheet.
 */
export const stylesheetCheck: RepoCheck = {
	id: "stylesheet-interface",
	description:
		"The app stylesheets carry the box-sizing reset and the button color default, put a standard property after its vendor-prefixed twin, state a color wherever they paint an interactive background, take their radii from the scale rather than raw pixels, and repeat a material's selector list exactly in each of its fallbacks.",
	async run(context) {
		const diagnostics: Diagnostic[] = []

		const stylesheets = await trackedSourcePaths(context, {
			globs: ["packages/react/*.css", "packages/*/lib/**/*.css"],
			existingOnly: true,
		})

		for (const filePath of stylesheets) {
			const file = relative(context.repoRoot, filePath)

			diagnostics.push(...stylesheetDiagnostics(file, await readLocalTextFile(filePath)))
		}

		return diagnostics
	},
}
