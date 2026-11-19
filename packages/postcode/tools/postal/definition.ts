// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the family definition of the `postal` family from the package's own
 *   readers of every country's postcode syntax.
 *
 *   The definition is the input format `recognize-build --definition` compiles.
 *   See `packages/recognizer/crates/recognize-build/src/definition.rs`.
 *
 *   # What a recognition reports
 *
 *   A recognition of the family reports that a string has the form of a postcode in some countries.
 *   It leaves open whether the code is allocated: PCB1 and PFX1 membership
 *   stays with the dictionary readers.
 *
 *   The family has two kinds of shape, and each is scoped `whole_or_embedded`:
 *
 *   - `postal.<cc>` is a bare code.
 *     Its language is the body of `postcodeSyntaxText`: the libaddressinput pattern
 *     and the written forms, with each space tolerated as `\s*`.
 *     One shape stands for every country whose body has the same language,
 *     and `<cc>` is the first of them in ISO order.
 *   - `printed.<cc>` is a code as the country's layout prints it: the printed prefix,
 *     any white space, and a bare code, as in `〒100-0001`, `L-1234` and `AZ 1000`.
 *     Its metadata points to the bare shape of the same country.
 *
 *   # Which strings the shapes accept
 *
 *   The package compiles its patterns with the `iu` flags.
 *   In JavaScript, `\d` is `[0-9]` and `\s` is the white space `String.prototype.trim`
 *   removes, and case folding is the simple folding of the Unicode `CaseFolding.txt`,
 *   so the Kelvin sign and the long s match `k` and `s` beside the letters.
 *
 *   The compiler's parser reads a pattern in Unicode mode, where `\d` holds every
 *   decimal digit and `\s` holds `Unicode.White_Space`.
 *   The generator therefore writes `\d` as `[0-9]` and `\s` as an explicit class
 *   derived from the running engine, and it writes the pattern inside `(?i:...)`,
 *   where the parser's case folding is the same simple folding.
 *
 *   A printed prefix is matched by the rule `acceptPostcode` applies,
 *   `trimmed.toUpperCase().startsWith(prefix)`: each prefix character becomes the
 *   class of code units whose upper case is that character.
 *   The class for `I` holds `ı`, and the class for `S` holds `ſ`.
 *
 *   # One case rule, for both sides
 *
 *   Every shape matches either case, so a person's `sw1a 1aa` is a postcode.
 *   The serving side and the training encoder read this one family, so both apply the rule.
 *
 *   The old shape table required upper case to stay off lower-case prose.
 *   The serving side upper-cased the text before it matched, and the training encoder matched the raw case.
 *
 *   A lower-case run that fits a postcode form is a candidate on both sides now.
 *   The anchor table decides whether the candidate is a postcode that exists.
 *   A candidate without an entry paints no piece.
 *
 *   # The form of each shape
 *
 *   Each shape's metadata states a `form`: `designated` for a printed form, `alnum` for a
 *   bare form whose language holds a letter, and `numeric` for a bare form of digits.
 *   See `PostalForm` in `lib/recognize/postal/readers.ts`.
 *
 *   # The embedded boundary
 *
 *   Every shape has `boundary: "alnum"`: the engine reports an embedded match only when the
 *   character before it and the one after it are not an ASCII letter or an ASCII digit.
 *   A connector may touch a match, so `54000` stands in `Lahore-54000` and in `FI-FI-01730`,
 *   the spellings the old shape table matched with `\b`.
 *   See `lib/recognize/postal/readers.ts`.
 *
 *   # What the compiler refuses
 *
 *   The compiler refuses `^`, `$` and `\b`.
 *   Only Bahrain's pattern holds them, as `(?:^|\b)` before its code and `(?:$|\b)` after it.
 *
 *   Each shape's scope anchors it, so the assertion before the code stands at the start
 *   of the text, where `^` holds, and the one after it at the end, where `$` holds.
 *   The generator removes exactly those two groups when they begin and end a top-level
 *   alternative, and it refuses any other `^`, `$` or `\b`.
 */

import { postcodeSyntaxCountries, printedPostcodePrefix } from "#country-formats"
import { postcodeSyntaxText } from "#country-formats/source"

/**
 * The family's ID.
 */
export const FAMILY_ID = "postal"

/**
 * The largest dense serialization the compiler accepts for the postal family's automata.
 *
 * The generator passes it to `recognize-build --dense-bytes`, so the family chooses
 * its own backend and no global limit changes.
 * An automaton over the budget is stored sparse.
 *
 * The manifest records the backend of each automaton and the budget under `limits.denseBytes`.
 */
export const POSTAL_DENSE_BYTES = 0

/**
 * Why the postal family has the dense budget above.
 */
export const POSTAL_BACKEND_REASON =
	"a budget of zero stores both automata sparse: the artifact is 326,696 bytes against 1,873,640 dense, and the browser and the Workers carry it; countriesAcceptingPostcode on the sparse artifact took 4.1 and 1.7 microseconds for 12345 and SW1A 1AA against 12.6 and 11.9 for the RegExp set it replaced, at a load average near 5"

/**
 * The file name the definition is written under.
 */
export const DEFINITION_FILE = `${FAMILY_ID}.definition.json`

/**
 * The command the generated files name as their generator.
 */
export const GENERATOR = "node packages/postcode/tools/generate.run.ts"

/**
 * One construct the compiler refuses, and what the generator wrote in its place.
 */
export interface Rewrite {
	readonly country: string
	readonly construct: string
	readonly replacement: string
}

/**
 * Whether a UTF-16 code unit is white space for JavaScript's `\s` and `trim`.
 */
const WHITESPACE_TEST = /\s/u

const LAST_CODE_UNIT = 0xff_ff
const FIRST_SURROGATE = 0xd8_00
const LAST_SURROGATE = 0xdf_ff

/**
 * A class of code points as a regular-expression string for the compiler's parser.
 */
function classOf(codePoints: readonly number[]): string {
	const ranges: string[] = []

	for (let index = 0; index < codePoints.length;) {
		let end = index

		while (end + 1 < codePoints.length && codePoints[end + 1] === codePoints[end]! + 1) {
			end++
		}

		const low = codePoints[index]!.toString(16)
		const high = codePoints[end]!.toString(16)

		ranges.push(end === index ? `\\x{${low}}` : `\\x{${low}}-\\x{${high}}`)

		index = end + 1
	}

	return `[${ranges.join("")}]`
}

/**
 * The class of the code points JavaScript's `\s` accepts, read from the running engine.
 */
export function whitespaceClass(): string {
	const found: number[] = []

	for (let code = 0; code <= LAST_CODE_UNIT; code++) {
		if (WHITESPACE_TEST.test(String.fromCodePoint(code))) {
			found.push(code)
		}
	}

	return classOf(found)
}

/**
 * The class of the code units whose `toUpperCase()` is exactly `character`.
 *
 * It holds `character` itself for a character with no case.
 */
export function upperCaseClass(character: string): string {
	const found: number[] = []

	for (let code = 0; code <= LAST_CODE_UNIT; code++) {
		if (code >= FIRST_SURROGATE && code <= LAST_SURROGATE) continue

		if (String.fromCodePoint(code).toUpperCase() === character) {
			found.push(code)
		}
	}

	if (!found.length) throw new Error(`no code unit has the upper case "${character}"`)

	return classOf(found)
}

/**
 * Splits `source` at the `|` that sit outside every group and every character class.
 */
function topLevelAlternatives(source: string): string[] {
	const parts: string[] = []
	let depth = 0
	let inClass = false
	let start = 0

	for (let index = 0; index < source.length; index++) {
		const character = source[index]!

		if (character === "\\") {
			index++
		} else if (inClass) {
			if (character === "]") {
				inClass = false
			}
		} else if (character === "[") {
			inClass = true
		} else if (character === "(") {
			depth++
		} else if (character === ")") {
			depth--
		} else if (character === "|" && depth === 0) {
			parts.push(source.slice(start, index))
			start = index + 1
		}
	}

	parts.push(source.slice(start))

	return parts
}

const LEADING_BOUNDARY = "(?:^|\\b)"
const TRAILING_BOUNDARY = "(?:$|\\b)"

/**
 * Translates one alternative of a country's compiled pattern into the compiler's regular-expression syntax.
 *
 * `\d` becomes `[0-9]` (`0-9` inside a class) and `\s` becomes the white-space class.
 * An assertion group at the start or the end of the alternative is removed
 * and recorded, and any other assertion throws.
 */
function translateAlternative(country: string, alternative: string, whitespace: string, rewrites: Rewrite[]): string {
	let body = alternative

	if (body.startsWith(LEADING_BOUNDARY)) {
		body = body.slice(LEADING_BOUNDARY.length)
		rewrites.push({ country, construct: LEADING_BOUNDARY, replacement: "(nothing; the scope anchors the start)" })
	}

	if (body.endsWith(TRAILING_BOUNDARY)) {
		body = body.slice(0, -TRAILING_BOUNDARY.length)
		rewrites.push({ country, construct: TRAILING_BOUNDARY, replacement: "(nothing; the scope anchors the end)" })
	}

	let out = ""
	let inClass = false

	for (let index = 0; index < body.length; index++) {
		const character = body[index]!

		if (character === "\\") {
			const next = body[index + 1]

			index++

			if (next === "d") {
				out += inClass ? "0-9" : "[0-9]"
			} else if (next === "s" && !inClass) {
				out += whitespace
			} else if (next === "-") {
				out += "\\-"
			} else throw new Error(`${country}: the escape \\${next ?? ""} has no translation, in /${alternative}/`)

			continue
		}

		if (!inClass && (character === "^" || character === "$")) {
			throw new Error(`${country}: an assertion ${character} the generator does not rewrite, in /${alternative}/`)
		}

		if (character === "[") {
			inClass = true
		} else if (character === "]") {
			inClass = false
		}

		out += character
	}

	return out
}

/**
 * The body of `country`'s postcode as a regular expression for the compiler.
 *
 * It reads the pattern text of `postcodeSyntaxText`, so the libaddressinput pattern,
 * the written forms and the spacing tolerance are the package's own.
 * The result has no assertion and is wrapped in `(?i:...)`.
 */
export function translateBody(country: string, rewrites: Rewrite[] = []): string {
	const syntax = postcodeSyntaxText(country)

	if (!syntax) throw new Error(`${country} has no postcode syntax`)

	const source = syntax.pattern

	if (!source.startsWith("^(?:") || !source.endsWith(")$")) {
		throw new Error(`${country}: the pattern is not anchored as postcodeSyntaxText writes it: /${source}/`)
	}

	const whitespace = whitespaceClass()

	const alternatives = topLevelAlternatives(source.slice("^(?:".length, -")$".length)).map((wrapped) => {
		if (!wrapped.startsWith("(?:") || !wrapped.endsWith(")")) {
			throw new Error(`${country}: an alternative is not a group: ${wrapped}`)
		}

		return translateAlternative(country, wrapped.slice("(?:".length, -1), whitespace, rewrites)
	})

	return `(?i:${alternatives.map((alternative) => `(?:${alternative})`).join("|")})`
}

/**
 * The printed form of `country`'s postcode as a regular expression, or null
 * when its layout prints no prefix.
 *
 * It is the prefix, any white space, and the body, with the prefix matched
 * case-insensitively by the upper-case rule.
 */
export function translatePrinted(country: string): string | null {
	const prefix = printedPostcodePrefix(country)

	if (!prefix) return null

	const classes = [...prefix].map((character) => upperCaseClass(character)).join("")

	return `${classes}${whitespaceClass()}*(?:${translateBody(country)})`
}

/**
 * The shapes of one probe: every country's bare form and every prefixed
 * country's printed form, one shape each.
 *
 * Its only use is to ask the compiler which shapes have equal languages.
 */
export function postalProbeDefinition(): DefinitionDocument {
	const shapes: DefinitionShape[] = []

	for (const country of postcodeSyntaxCountries()) {
		shapes.push({ id: `bare.${country.toLowerCase()}`, pattern: translateBody(country), scope: "whole_or_embedded" })

		const printed = translatePrinted(country)

		if (printed) {
			shapes.push({ id: `printed.${country.toLowerCase()}`, pattern: printed, scope: "whole_or_embedded" })
		}
	}

	return { format: "mailwoman.recognize.family-definition", version: 1, family: "postal_probe", shapes }
}

/**
 * One shape of a definition.
 */
export interface DefinitionShape {
	id: string
	pattern: string
	scope?: "whole" | "embedded" | "whole_or_embedded"
	boundary?: "token" | "alnum"
	overlaps?: string[]
	metadata?: Record<string, unknown>
}

/**
 * The definition `recognize-build --definition` reads.
 */
export interface DefinitionDocument {
	format: string
	version: number
	family: string
	generator?: string
	metadata?: Record<string, unknown>
	shapes: DefinitionShape[]
}

/**
 * A pair the compiler reports, as `recognize-build --definition --list-overlaps` prints it.
 */
export interface ReportedOverlap {
	a: { family: string; shape: string }
	b: { family: string; shape: string }
	witness: string
	declared: boolean
	equivalent: boolean
}

/**
 * The groups of country codes whose shapes of `prefix` have equal languages,
 * by the compiler's equivalence analysis.
 *
 * Each group is in ISO order and the groups are in the ISO order of their first member.
 */
export function equivalenceGroups(prefix: "bare" | "printed", reported: readonly ReportedOverlap[]): string[][] {
	const countries = postcodeSyntaxCountries().filter((country) => prefix === "bare" || printedPostcodePrefix(country))
	const parent = new Map(countries.map((country) => [country, country]))

	const find = (country: string): string => {
		let root = country

		while (parent.get(root) !== root) {
			root = parent.get(root)!
		}

		return root
	}

	for (const pair of reported) {
		if (!pair.equivalent || pair.a.family !== "postal_probe" || pair.b.family !== "postal_probe") continue

		const [kindA, codeA] = pair.a.shape.split(".")
		const [kindB, codeB] = pair.b.shape.split(".")

		if (kindA !== prefix || kindB !== prefix) continue

		const rootA = find(codeA!.toUpperCase())
		const rootB = find(codeB!.toUpperCase())

		if (rootA !== rootB) {
			parent.set(rootB < rootA ? rootA : rootB, rootB < rootA ? rootB : rootA)
		}
	}

	const groups = new Map<string, string[]>()

	for (const country of countries) {
		const root = find(country)

		groups.set(root, [...(groups.get(root) ?? []), country])
	}

	return [...groups.values()].map((members) => members.toSorted()).toSorted((a, b) => a[0]!.localeCompare(b[0]!))
}

/**
 * The form of a bare shape, from the text of its pattern.
 *
 * A letter outside a `\x{...}` escape makes the shape alphanumeric.
 * `PostalForm` in `lib/recognize/postal/readers.ts` states what each form may do.
 */
export function bareForm(pattern: string): "alnum" | "numeric" {
	const readable = pattern.replaceAll(/\\x\{[0-9a-f]+\}/gu, "").replace("(?i:", "")

	return /[A-Za-z]/u.test(readable) ? "alnum" : "numeric"
}

/**
 * The shape of `prefix`'s group whose first member is `lead`.
 */
export function postalShapeID(prefix: "bare" | "printed", lead: string): string {
	return `${prefix === "bare" ? "postal" : "printed"}.${lead.toLowerCase()}`
}

/**
 * The family definition: one shape for each group of equal bare languages and one for each group
 * of equal printed languages, with the overlaps `declared` lists on the shape that declares them.
 */
export function postalDefinition(
	bare: readonly (readonly string[])[],
	printed: readonly (readonly string[])[],
	declared: ReadonlyMap<string, readonly string[]> = new Map()
): DefinitionDocument {
	const bareOf = new Map(
		bare.flatMap((group) => group.map((country) => [country, postalShapeID("bare", group[0]!)] as const))
	)

	const shapes: DefinitionShape[] = []

	for (const group of bare) {
		const id = postalShapeID("bare", group[0]!)

		const pattern = translateBody(group[0]!)

		shapes.push({
			id,
			pattern,
			scope: "whole_or_embedded",
			boundary: "alnum",
			...(declared.get(id)?.length && { overlaps: [...declared.get(id)!] }),
			metadata: { kind: "code", form: bareForm(pattern), countries: [...group] },
		})
	}

	for (const group of printed) {
		const id = postalShapeID("printed", group[0]!)
		const prefix = printedPostcodePrefix(group[0]!)!
		const bodies = new Set(group.map((country) => bareOf.get(country)))

		if (bodies.size !== 1) throw new Error(`the printed group ${group.join(",")} has several bare shapes`)

		shapes.push({
			id,
			pattern: translatePrinted(group[0]!)!,
			scope: "whole_or_embedded",
			boundary: "alnum",
			...(declared.get(id)?.length && { overlaps: [...declared.get(id)!] }),
			metadata: { kind: "printed", form: "designated", countries: [...group], prefix, bare: [...bodies][0] },
		})
	}

	return {
		format: "mailwoman.recognize.family-definition",
		version: 1,
		family: FAMILY_ID,
		generator: GENERATOR,
		metadata: { build: { denseBudgetBytes: POSTAL_DENSE_BYTES, reason: POSTAL_BACKEND_REASON } },
		shapes,
	}
}
