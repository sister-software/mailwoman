/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Labels Chinese rows whose settlement ends in an organizational unit chain.
 *
 *   The unit grammar tags the whole chain as `locality_unit` and its named head as `dependent_locality`. Input is JSONL
 *   with `{ raw, country }`. Rows are aligned per character for the CJK model.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { splitCNUnitChain } from "@mailwoman/core/locale/zh-cn-units"

import { type CorpusRecipe, readTuples, recipeSourceID } from "#recipes/scaffold"
import { alignRow } from "#utils/align"
import { cjkAwareTokenizer } from "#utils/tokenize"

/**
 * Matches the leading run of Han characters and digits.
 */
const LEADING_HAN = /^[\p{Script=Han}〇\d]+/u

/**
 * Administrative prefixes, matched in order from broadest to narrowest.
 */
const ADMIN_PREFIXES: ReadonlyArray<readonly [pattern: RegExp, tag: "region" | "locality" | "subregion"]> = [
	[/^(.+?(?:省|自治区))/u, "region"],
	[/^(.+?市)/u, "locality"],
	[/^(.+?(?:自治县|县|旗))/u, "subregion"],
]

/**
 * Labels the components of a row, or returns `null` when the row has no unit chain.
 */
export function labelCNOrganizationalRow(raw: string): Record<string, string> | null {
	const han = LEADING_HAN.exec(raw)?.[0]

	if (!han) return null

	const components: Record<string, string> = {}
	let rest = han

	for (const [pattern, tag] of ADMIN_PREFIXES) {
		const match = pattern.exec(rest)

		// A prefix is taken only when text remains after it for the settlement.
		if (match && match[1]!.length < rest.length) {
			components[tag] = match[1]!
			rest = rest.slice(match[1]!.length)
		}
	}

	const split = splitCNUnitChain(rest)

	if (!split) return null

	if (split.head) {
		components.dependent_locality = split.head
	}

	components.locality_unit = split.chain

	const tail = raw.slice(han.length).trim()

	if (tail) {
		// A Latin tail becomes a region and a trailing "China" country.
		const segments = tail.includes(",")
			? tail
					.split(",")
					.map((segment) => segment.trim())
					.filter((segment) => segment.length)
			: tailWithoutCommas(tail)

		for (const segment of segments) {
			if (/^china$/iu.test(segment)) {
				components.country = segment
			} else if (!components.region && !/^\d+$/u.test(segment)) {
				components.region = segment
			}
		}
	}

	return components
}

/**
 * Splits a trailing `China` off a tail without commas.
 * Any other tail stays one segment.
 */
function tailWithoutCommas(tail: string): string[] {
	const words = tail.split(/\s+/u).filter((word) => word.length)
	const last = words.at(-1)

	if (last && /^china$/iu.test(last) && words.length > 1) {
		return [words.slice(0, -1).join(" "), last]
	}

	return [words.join(" ")]
}

const SOURCE = "coarse-placer-cn-units"

/**
 * The recipe registered with the corpus builder.
 */
export const cnOrganizationalUnitsRecipe: CorpusRecipe = {
	name: "cn-organizational-units",
	description:
		"CN rows whose settlement is an organizational ladder (分场/队/连/组), labeled by the suffix grammar as one locality_unit span, per-character BIO",
	mode: "tuples",
	options: [],
	async run(opts, write) {
		if (!opts.input) {
			throw new Error("cn-organizational-units: --input <rows.jsonl> is required ({ raw, country } rows)")
		}

		const tokenizer = cjkAwareTokenizer()
		let emitted = 0
		let skipped = 0
		let quarantined = 0

		for await (const tuple of readTuples(opts.input)) {
			const raw = typeof tuple["raw"] === "string" ? tuple["raw"].trim() : ""
			const country = typeof tuple["country"] === "string" ? tuple["country"].toUpperCase() : "CN"

			if (!raw || country !== "CN") {
				skipped++

				continue
			}

			const components = labelCNOrganizationalRow(raw)

			if (!components) {
				skipped++

				continue
			}

			if (opts.golden) {
				write(stringifyJSON({ raw, components, country: "CN", locale: "zh-CN" }))

				emitted++

				continue
			}

			const canonical = {
				raw,
				components,
				country: "CN",
				locale: "zh-CN",
				source: opts.sourceName ?? SOURCE,
				source_id: recipeSourceID(opts.sourceName ?? SOURCE, { raw }),
				corpus_version: "0.4.0",
				license:
					"CC-BY-4.0 — GeoNames populated places, INFERRED from the `<name>, <admin1>, <country>` row shape; data/coarse-placer carries no per-row source",
			}

			// Every component must appear verbatim in `raw`.
			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0], { tokenizer, maxEditDistance: 0 })

			if (aligned.kind !== "labeled" || !aligned.row) {
				quarantined++

				continue
			}

			write(stringifyJSON({ ...aligned.row, synth_method: "cn-organizational-units", synth_base_id: null }))

			emitted++
		}

		console.error(
			`  cn-organizational-units: ${emitted} labeled, ${skipped} without a chain, ${quarantined} quarantined`
		)

		return { emitted, skipped, quarantined }
	},
}
