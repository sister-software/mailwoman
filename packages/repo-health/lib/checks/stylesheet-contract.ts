/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The stylesheet invariants the map apps' chrome depends on.
 *
 *   Every rule here was earned by a defect that reached production, and each one is either an INVARIANT the design
 *   system states once (a reset that makes a class of bug impossible) or a DETECTOR for a shape no invariant can
 *   express. There is no CSS linter in this repository; these are the specific things that broke.
 *
 *   `docs/` is out of scope. It is a Docusaurus site on Infima's own system, and its stylesheets answer to that.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { relative } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * The stylesheet that carries the design system's own invariants — the reset and the base layer live here, and the
 * first two rules below assert their contents rather than searching for their absence everywhere else.
 */
const SYSTEM_STYLESHEET = "packages/react/styles.css"

/**
 * A rule, as the text gives it up: the selector list, the declarations inside the braces, and the at-rules it is nested
 * in.
 *
 * The enclosing at-rules are what separate a rule that USES a token from a rule that is a material's fallback. The
 * chip's hover background and a sticky header both paint the fallback colour on purpose; only the rules inside
 * `@supports not (backdrop-filter…)` and `@media (prefers-reduced-transparency: reduce)` are the fallback itself.
 */
interface StyleRule {
	selector: string
	body: string
	line: number
	/**
	 * Every enclosing at-rule preamble, outermost first — `@layer components`, `@media (max-width: 600px)`.
	 */
	context: readonly string[]
}

/**
 * Split a stylesheet into rules, carrying the at-rule nesting each one sits in.
 *
 * Comments are BLANKED rather than deleted, so every reported line number still matches the file on disk and a
 * declaration quoted in prose is not read as one.
 */
function styleRules(css: string): StyleRule[] {
	const clean = css.replaceAll(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replaceAll(/[^\n]/gu, " "))
	const rules: StyleRule[] = []
	const context: string[] = []
	// The text since the last brace: an at-rule preamble, a selector list, or a run of declarations.
	let pending = ""
	// Where the current line is, and where the first NON-blank character of `pending` sat — the second is the line a
	// diagnostic names, so a selector is reported at its own line rather than at the blank one after the rule above.
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
			const preamble = pending.trim().replaceAll(/\s+/gu, " ")

			pending = ""

			if (preamble.startsWith("@")) {
				context.push(preamble)

				continue
			}

			// A declaration block: it runs to the next closing brace, since declarations carry no braces of their own.
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
 * Whether the rule sits inside the guards a material's opaque fallback is declared under.
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
 * Whether the selector names a STATE of something styled elsewhere — `:hover`, `:disabled`, a `--active` modifier.
 *
 * A state rule states only what changes, and takes the rest from the rule it varies, so asking it to repeat a color
 * would be asking for the copy this file exists to prevent.
 */
const STATE_SELECTOR = /:(?:hover|active|disabled|focus|focus-visible|focus-within|checked|first|last|nth)|--[a-z]+$/u

/**
 * Vendor pairs the bundler collapses. A minifier keeps the LAST of two declarations carrying the same value, so the
 * standard property has to come after its prefixed twin or it is the one dropped from the output.
 */
const VENDOR_PAIRS = ["backdrop-filter", "mask-image", "user-select", "text-stroke", "box-decoration-break"] as const

/**
 * The token that marks a glass surface, and the token its fallbacks paint instead.
 */
const MATERIAL_BACKGROUND = "var(--material-glass-background)"
const MATERIAL_FALLBACK = "var(--material-glass-fallback-background)"

/**
 * A selector list as an order-independent key, so a fallback that names the same surfaces in another order matches.
 */
function selectorSet(selector: string): string {
	return selector
		.split(",")
		.map((part) => part.trim())
		.toSorted()
		.join(", ")
}

/**
 * Every diagnostic one stylesheet earns, from its text alone.
 *
 * Exported so the rules are exercised on the shapes that broke rather than only on a tree that already passes: a check
 * that has never been shown to fail is a check nobody has tested.
 *
 * @param file The repo-relative path, which decides whether the system-wide invariants are asserted on it.
 */
export function stylesheetDiagnostics(file: string, css: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const rules = styleRules(css)

	// ── Invariants, asserted once on the system stylesheet ───────────────────────────────────────────────────────
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

	// ── Detectors, over every app stylesheet ─────────────────────────────────────────────────────────────────────
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

	// ── A material and its fallbacks name the same surfaces ──────────────────────────────────────────────────────
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
 * The check the chrome arc ends on: the invariants that make two of these defects impossible, and detectors for the two
 * no invariant expresses. Registered in `#registry` and run by `mwops health stylesheet-contract`.
 */
export const stylesheetContractCheck: RepoCheck = {
	id: "stylesheet-contract",
	description:
		"The app stylesheets carry the box-sizing reset and the button color default, put a standard property after its vendor-prefixed twin, state a color wherever they paint an interactive background, and repeat a material's selector list exactly in each of its fallbacks.",
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
