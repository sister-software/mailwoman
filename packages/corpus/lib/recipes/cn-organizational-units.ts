/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `cn-organizational-units` recipe (#2034) — real CN address strings whose settlement is an ORGANIZATIONAL
 *   ladder (`赵光三分场二十九队`: the Zhaoguang farm, No. 3 sub-farm, No. 29 production team), labeled by rule and aligned
 *   character by character for the CJK sibling model.
 *
 *   THE LABELS ARE A READING OF THE SUFFIX, NOT A GUESS. Every generic that ends an ordinal unit (`分场`, `大队`, `队`,
 *   `连`, `团`, `组`, `场部`) is in `@mailwoman/core/locale/zh-cn-units`' one table, and the same table reads the span back
 *   after decode. The whole ordinal chain is ONE `locality_unit` span; the named head it belongs to (`赵光`, `孟定农场`) is
 *   `dependent_locality`; a province, city or county written in front of it takes `region`, `locality`, `subregion`; a
 *   Latin admin tail (`, Heilongjiang, China`) takes `region` and `country`. A row with no chain is skipped, not labeled:
 *   `红卫大队` is a village name whose generic carries no ordinal, and `苗辽林场` is a named forest farm.
 *
 *   WHERE THE ROWS COME FROM. `--input` is a JSONL of `{ raw, country }` rows — the shape of `data/coarse-placer/*.jsonl`,
 *   whose 50,000 CN rows hold 328 with unit vocabulary. That file is a local artifact and carries no per-row source; the
 *   `<name>, <admin1>, <country>` shape is the corpus's GeoNames adapter's, so the rows are stamped with GeoNames'
 *   licence and the inference is stated in the `license` field rather than hidden behind it.
 *
 *   FOR THE CJK MODEL ONLY. The tokenizer is {@link cjkAwareTokenizer}: one token per Han character, because the
 *   whitespace tokenizer reads `三分场八队` as one word and could never give it two labels. The Latin model never trains
 *   on this recipe's rows; its label set has no `locality_unit`.
 */

import { splitCNUnitChain } from "@mailwoman/core/locale/zh-cn-units"

import { type CorpusRecipe, readTuples, sliceSourceID } from "#recipes/scaffold"
import { alignRow } from "#utils/align"
import { cjkAwareTokenizer } from "#utils/tokenize"

/**
 * The leading run of Han characters (plus the digits an ordinal may be written with): the Chinese half of a row.
 */
const LEADING_HAN = /^[\p{Script=Han}〇\d]+/u

/**
 * Admin prefixes a CJK address writes in front of the settlement, coarsest first. Each is matched at the START of what
 * remains, so `云南省临沧市孟定农场三分场二队` peels `云南省` (province), `临沧市` (city), and hands `孟定农场三分场二队` to the unit reader.
 */
const ADMIN_PREFIXES: ReadonlyArray<readonly [pattern: RegExp, tag: "region" | "locality" | "subregion"]> = [
	[/^(.+?(?:省|自治区))/u, "region"],
	[/^(.+?市)/u, "locality"],
	[/^(.+?(?:自治县|县|旗))/u, "subregion"],
]

/**
 * The components a row's string supports, every value a verbatim substring of `raw`, or `null` when the string carries
 * no organizational chain and so teaches nothing this recipe exists for.
 */
export function labelCNOrganizationalRow(raw: string): Record<string, string> | null {
	const han = LEADING_HAN.exec(raw)?.[0]

	if (!han) return null

	const components: Record<string, string> = {}
	let rest = han

	for (const [pattern, tag] of ADMIN_PREFIXES) {
		const match = pattern.exec(rest)

		// A prefix must leave something behind it, or the whole run was the admin name and there is no settlement.
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
		// `, Heilongjiang, China` or `Hunan China` or `Inner Mongolia`: comma segments when there are commas, else the last
		// word is the country when it says so and the rest is the admin1 name.
		const segments = tail.includes(",")
			? tail
					.split(",")
					.map((segment) => segment.trim())
					.filter(Boolean)
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
 * A space-separated tail: `Hunan China` → [`Hunan`, `China`]; `Inner Mongolia` → [`Inner Mongolia`]; `Xinjiang Uyghur`
 * → [`Xinjiang Uyghur`].
 */
function tailWithoutCommas(tail: string): string[] {
	const words = tail.split(/\s+/u).filter(Boolean)
	const last = words.at(-1)

	if (last && /^china$/iu.test(last) && words.length > 1) {
		return [words.slice(0, -1).join(" "), last]
	}

	return [words.join(" ")]
}

const SOURCE = "coarse-placer-cn-units"

/**
 * Slice recipe registered with the corpus builder — see the file header for the rows it labels and why every label is a
 * reading of a generic rather than a guess.
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
				write(JSON.stringify({ raw, components, country: "CN", locale: "zh-CN" }) + "\n")

				emitted++

				continue
			}

			const canonical = {
				raw,
				components,
				country: "CN",
				locale: "zh-CN",
				source: opts.sourceName ?? SOURCE,
				source_id: sliceSourceID(opts.sourceName ?? SOURCE, { raw }),
				corpus_version: "0.4.0",
				license:
					"CC-BY-4.0 — GeoNames populated places, INFERRED from the `<name>, <admin1>, <country>` row shape; data/coarse-placer carries no per-row source",
			}

			// Verbatim only: every value above was sliced out of `raw`, so an edit-distance match would mean this file
			// has a bug, not that the source spells something differently.
			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0], { tokenizer, maxEditDistance: 0 })

			if (aligned.kind !== "labeled" || !aligned.row) {
				quarantined++

				continue
			}

			write(JSON.stringify({ ...aligned.row, synth_method: "cn-organizational-units", synth_base_id: null }) + "\n")

			emitted++
		}

		console.error(
			`  cn-organizational-units: ${emitted} labeled, ${skipped} without a chain, ${quarantined} quarantined`
		)

		return { emitted, skipped, quarantined }
	},
}
