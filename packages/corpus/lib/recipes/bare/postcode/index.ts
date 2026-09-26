/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `bare-postcode` — a postcode standing alone, in the form its country writes, and no other component;
 * every surface the recipe renders is run through `detectKnownFormats` and refused unless the detector
 * calls it a postcode, so the rendering table and `known-formats.ts`'s patterns must agree.
 */

import { isNLPostcodeKey } from "@mailwoman/codex/nl"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { SeededRandom } from "@mailwoman/core/utils"
import { computeQueryShape } from "@mailwoman/query-shape"
import { isPostcodeFormat } from "@mailwoman/query-shape/known-formats"
import type { PathBuilderLike } from "path-ts"

import { isReservedBarePostcode } from "#recipes/bare/postcode/eval"
import { alignAndWrite, type CorpusRecipe, readCSVRecords, recipeSourceID } from "#recipes/scaffold"
import { SourceRegister } from "#registers"
import { normalizeGauntletSurface, readGauntletInputs } from "#tools/gauntlet-inputs"
import { SurfaceOrigin } from "#types"

/**
 * A postcode in the form its country writes, with no surrounding text; the codes come from this
 * repository's postcode-format tables rather than a national postcode file, so the register is the codex.
 */
const BARE_POSTCODE_PROVENANCE = {
	register: SourceRegister.Codex,
	surface: SurfaceOrigin.Attested,
}

/**
 * One country's postcodes: the CSV under the extracted OpenAddresses tree and the country it covers,
 * where Sweden publishes sixteen municipality files against CZ/SK/NL's one countrywide file each.
 */
interface PostcodeSource {
	csv: PathBuilderLike
	country: string
}

const EXTRACTED = dataRootPath("openaddresses", "extracted")

/**
 * Read from the archive rather than guessed, because OpenAddresses keeps the Swedish
 * spelling on two of these (`savsjö`, `Österåker`) while folding the rest to ascii.
 */
const SWEDISH_MUNICIPALITIES = [
	"alingsas",
	"gislaved",
	"goteborg",
	"helsingborg",
	"hoganas",
	"kalmar",
	"kristinehamn",
	"malmo",
	"nacka",
	"savsjö",
	"stockholm",
	"uppsala",
	"vasteras",
	"vaxholm",
	"vaxjo",
	"Österåker",
]

/**
 * Greece is deliberately absent: its only member declares a `postcode` column with no values over
 * 10,877 rows, though `gr_postcode` shares `NNN NN` with CZ/SK/SE, so no row here claims to be Greek.
 */
const SOURCES: PostcodeSource[] = [
	{ csv: EXTRACTED("cz", "countrywide.csv"), country: "CZ" },
	{ csv: EXTRACTED("sk", "countrywide.csv"), country: "SK" },
	{ csv: EXTRACTED("nl", "countrywide.csv"), country: "NL" },
	...SWEDISH_MUNICIPALITIES.map((name) => ({
		csv: EXTRACTED("se", `municipality_of_${name}.csv`),
		country: "SE",
	})),
]

/**
 * How a country writes its postcode when typed alone, and the locale to stamp;
 * only countries whose bare postcode collides with a house number are here, `render` answers
 * the spaced form first, and GB is deliberately absent because `SW1A 1AA` opens with letters.
 */
const WRITTEN_FORMS: ReadonlyMap<string, { locale: string; render: (compact: string) => string[] }> = new Map([
	// `NNN NN`, written with the space; the four countries share the shape,
	// so `detectKnownFormats` labels all four the same.
	["CZ", { locale: "cs-CZ", render: spacedThree }],
	["SK", { locale: "sk-SK", render: spacedThree }],
	["SE", { locale: "sv-SE", render: spacedThree }],
	["GR", { locale: "el-GR", render: spacedThree }],
	// `nnnn LL`; both spellings are attested, and the spaced one is the failing one.
	[
		"NL",
		{
			locale: "nl-NL",
			render: (compact) => (isNLPostcodeKey(compact) ? [`${compact.slice(0, 4)} ${compact.slice(4)}`, compact] : []),
		},
	],
])

/**
 * `10000` → `["100 00", "10000"]`; Sweden and Greece space five digits after the third as Czechia
 * and Slovakia do, and the compact form rides along because sources store it that way.
 */
function spacedThree(compact: string): string[] {
	if (!/^\d{5}$/.test(compact)) return []

	return [`${compact.slice(0, 3)} ${compact.slice(3)}`, compact]
}

/**
 * Choose distinct postcodes without inheriting the publisher's row order; sorting first makes the
 * result input-order independent, and the seeded sample spreads reproducibly across the complete set.
 */
export function selectPostcodes(codes: Iterable<string>, limit: number, seed: number): string[] {
	const pool = [...new Set(codes)].toSorted()

	if (limit >= pool.length) return pool

	return new SeededRandom(seed).sample(pool, Math.max(0, limit))
}

/**
 * Return every required input path that is absent, preserving declaration order for diagnostics.
 */
export async function findMissingPostcodeSources<P extends PathBuilderLike>(
	paths: readonly P[],
	exists: (path: P) => Promise<boolean> = pathExists
): Promise<P[]> {
	const results = await Promise.all(paths.map(async (path) => ({ path, exists: await exists(path) })))

	return results.filter((result) => !result.exists).map(({ path }) => path)
}

/**
 * Every surface a country writes for one postcode, spaced form first, or `[]`
 * when this recipe carries no form for that country or the code does not fit; exported
 * so a test can pin that every rendered surface is one {@linkcode detectedAsPostcode} accepts.
 */
export function renderBarePostcode(country: string, postcode: string): string[] {
	const form = WRITTEN_FORMS.get(country.trim().toUpperCase())

	if (!form) return []

	return form.render(postcode.trim().toUpperCase().replaceAll(/\s+/gu, ""))
}

/**
 * Whether `known-formats.ts` reads this surface as a postcode across its whole span;
 * a surface the detector does not recognize would train the model on a string
 * the query-shape prior cannot then support.
 */
export function detectedAsPostcode(surface: string): boolean {
	return computeQueryShape(surface).knownFormats.some(
		(hit) => isPostcodeFormat(hit.format) && hit.span.start === 0 && hit.span.end === surface.length
	)
}

/**
 * Recipe registered with the corpus builder.
 */
export const barePostcodeRecipe: CorpusRecipe = {
	name: "bare-postcode",
	description:
		"A postcode alone, in its country's written form — the shape no other recipe output carries (CZ/SK/SE/NL)",
	mode: "generate",
	options: [
		{
			flag: "--count",
			description: "Cap on emitted rows; each country contributes an equal share until its codes run out",
		},
	],
	async run(opts, write) {
		let read = 0
		let emitted = 0
		let skipped = 0
		let unrecognized = 0

		// Preflight the complete input set before writing a row; a missing municipality would
		// otherwise produce a plausible artifact with less Swedish coverage than the recipe declares.
		const missing = await findMissingPostcodeSources(SOURCES.map(({ csv }) => csv))

		if (missing.length) {
			throw new Error(
				`bare-postcode is missing ${missing.length} of ${SOURCES.length} required OpenAddresses files, ` +
					`starting with ${missing[0]}. Fetch the per-source runs into \`openaddresses/extracted/\` ` +
					"(anonymous, see packages/corpus/CLAUDE.md)."
			)
		}

		// Per-country budget, because supply is uneven: the Netherlands publishes ~460,000
		// distinct `nnnn LL` codes against Czechia's 2,669 and Slovakia's 1,059, so an uncapped
		// pass would emit 98.9% Dutch rows and teach the `NNN NN` countries almost no pattern.
		const countries = [...new Set(SOURCES.map((source) => source.country))]
		const budget = opts.count ? Math.ceil(opts.count / countries.length) : Number.POSITIVE_INFINITY
		const perCountry = new Map(countries.map((country) => [country, 0]))
		const codesByCountry = new Map(countries.map((country) => [country, new Set<string>()]))

		// The gauntlet boards are a second held-out register, separate from
		// `BARE_POSTCODE_EVAL_CASES`, and `cz/bare-postcode.jsonl` predates this recipe.
		const boardInputs = await readGauntletInputs()
		let boardRefused = 0

		for (const source of SOURCES) {
			const form = WRITTEN_FORMS.get(source.country)

			if (!form) continue

			for await (const row of readCSVRecords(source.csv)) {
				read++

				const compact = String(row.postcode ?? "")
					.trim()
					.toUpperCase()
					.replaceAll(/\s+/gu, "")

				const countryCodes = codesByCountry.get(source.country)!

				if (!compact || isReservedBarePostcode(compact) || countryCodes.has(compact)) {
					skipped++

					continue
				}

				// A board row is refused on any of its written forms, so the check runs over
				// each rendered surface rather than the compact code; `normalizeGauntletSurface`
				// makes `100 00` and `10000` one string.
				if (form.render(compact).some((surface) => boardInputs.has(normalizeGauntletSurface(surface)))) {
					boardRefused++

					skipped++

					continue
				}

				if (!form.render(compact).length) {
					skipped++

					continue
				}

				countryCodes.add(compact)
			}
		}

		for (const country of countries) {
			const form = WRITTEN_FORMS.get(country)!
			const maximumCodes = Number.isFinite(budget) ? Math.ceil(budget / 2) : Number.POSITIVE_INFINITY
			const countrySeed = opts.seed ^ (country.charCodeAt(0) << 8) ^ country.charCodeAt(1)
			const selected = selectPostcodes(codesByCountry.get(country)!, maximumCodes, countrySeed)

			for (const compact of selected) {
				const surfaces = form.render(compact)

				for (const surface of surfaces) {
					if (perCountry.get(country)! >= budget) break

					// A surface the detector does not read as a postcode is a disagreement
					// between this table and `known-formats.ts`.
					if (!detectedAsPostcode(surface)) {
						unrecognized++

						continue
					}

					const components = { postcode: surface }

					const canonical = {
						raw: surface,
						components,
						country,
						locale: form.locale,
						source: "synth-bare-postcode",
						source_id: recipeSourceID("synth-bare-postcode", {
							...components,
							c: country,
						}),
						corpus_version: "0.30.0",
						license:
							"Synthetic — bare-postcode; postcodes from OpenAddresses (per-source attribution in the model card)",
					}

					if (alignAndWrite(write, canonical, "bare-postcode", BARE_POSTCODE_PROVENANCE)) {
						emitted++
						perCountry.set(country, perCountry.get(country)! + 1)
					} else {
						skipped++
					}
				}
			}
		}

		// A rendered surface the detector refuses is an interface failure, not a data quirk: every
		// form here is one `known-formats.ts` declares a pattern for, so the count is expected to be zero.
		if (unrecognized > 0) {
			throw new Error(
				`${unrecognized} rendered surfaces were not read as a postcode by detectKnownFormats — the ` +
					"WRITTEN_FORMS table and known-formats.ts's PATTERNS disagree. Reconcile them before building."
			)
		}

		// An empty build is a failure rather than an empty answer: the required
		// files were preflighted above, so zero rows means their postcode columns
		// or the written-form rules stopped providing usable data.
		if (emitted === 0) {
			throw new Error(
				`bare-postcode emitted no rows from ${SOURCES.length} readable sources. ` +
					"The postcode columns or the written-form rules changed."
			)
		}

		// Reported rather than folded into `skipped` so a growing board is visible; a count of zero
		// where the boards hold postcodes means the check stopped reaching them.
		console.error(
			`  bare-postcode: ${boardRefused.toLocaleString()} rows refused as gauntlet board inputs ` +
				`(${boardInputs.size.toLocaleString()} inputs read)`
		)

		return { read, emitted, skipped }
	},
}
