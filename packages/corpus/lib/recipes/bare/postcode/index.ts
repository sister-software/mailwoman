/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `bare-postcode` — a postcode standing ALONE, in the form its country writes.
 *
 *   The shape is absent from the corpus. A census of the 685,187,151 rows the v0.29.0 mixture reads
 *   found ZERO two-token rows of `NNN NN` and one of `NNNN LL`, so `100 00` and `1012 LG` are out of
 *   distribution and every model's answer for them is generalization off longer lines. That
 *   generalization is what moved: held-out CZ/SK codes read 31/32 as a postcode under v5.0.0, v5.2.0
 *   AND v5.3.0 — a seed pair agreeing, so not training noise — and 0/32 under v5.4.0, whose added
 *   OpenStreetMap PK/BD/VN rows raise the leading-digit-is-a-house-number evidence at that opening
 *   from 393 to 444 samples per epoch.
 *
 *   Neither existing repair reaches it. `nl-postcode` and `cz-pcfirst-preposition` teach the same
 *   postcodes IN CONTEXT — every row they emit carries a street, a number and a city — and the
 *   12,759 in-context `NNN NN` rows do not transfer to the bare input. The deterministic half,
 *   `buildEmissionPriors`, caps near 0.95 at the default `biasScale` against a measured 1.67-to-3.78
 *   nat deficit.
 *
 *   So this recipe emits the postcode and NOTHING else, which is the one thing no sibling does.
 *
 *   VERIFIED AGAINST THE PRIOR, NOT MERELY MATCHED TO IT. Every surface is run through
 *   `detectKnownFormats` and refused unless the detector calls it a postcode. The recipe's rendering
 *   table and `known-formats.ts`'s patterns have to agree, and matched constants would not prove
 *   they do — the trained surface and the prior that boosts it come from one check.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { SeededRandom } from "@mailwoman/core/utils"
import { computeQueryShape } from "@mailwoman/query-shape"
import { isPostcodeFormat } from "@mailwoman/query-shape/known-formats"
import { join, type PathBuilderLike } from "path-ts"

import { isReservedBarePostcode } from "#recipes/bare/postcode/eval"
import { alignAndWrite, type CorpusRecipe, readCSVRecords, sliceSourceID } from "#recipes/scaffold"

/**
 * One country's postcodes: the CSV under the extracted OpenAddresses tree, and the country it covers.
 *
 * `openaddresses/extracted/` rather than a cached zip, because the extracted tree is what survives on this lab and its
 * paths mirror the archive's member paths exactly (`cz/countrywide.csv`). Sweden publishes per municipality, so SE is
 * sixteen files; CZ, SK and NL are one countrywide file each.
 */
interface PostcodeSource {
	csv: PathBuilderLike
	country: string
}

const EXTRACTED = dataRootPath("openaddresses", "extracted")

/**
 * Read from the archive rather than guessed: `readZippedCSVRecords` throws on a member that is not there, and
 * OpenAddresses keeps the Swedish spelling on two of these (`savsjö`, `Österåker`) while folding the rest to ASCII.
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
 * GREECE IS ABSENT ON PURPOSE. `gr/b/municipality_of_kalamaria.csv` is the archive's only Greek member and it declares
 * a `postcode` column carrying nothing: 0 values in 10,877 rows. `gr_postcode` shares `NNN NN` with the three below, so
 * a Greek reader is served by what they teach until a Greek source with postcodes exists — but no row here claims to be
 * Greek.
 */
const SOURCES: PostcodeSource[] = [
	{ csv: join(EXTRACTED, "cz", "countrywide.csv"), country: "CZ" },
	{ csv: join(EXTRACTED, "sk", "countrywide.csv"), country: "SK" },
	{ csv: join(EXTRACTED, "nl", "countrywide.csv"), country: "NL" },
	...SWEDISH_MUNICIPALITIES.map((name) => ({
		csv: join(EXTRACTED, "se", `municipality_of_${name}.csv`),
		country: "SE",
	})),
]

/**
 * How a country writes its postcode when a person types it alone, and the locale to stamp.
 *
 * `render` receives the source's own spelling with whitespace stripped, and answers every surface that country writes —
 * the spaced form first where one exists, because that is the failing one. A country whose written form is the source's
 * form answers a single entry.
 *
 * Only countries whose bare postcode COLLIDES with a house number are here: an all-digit or digits-then-letters opening
 * is what the model reads as `house_number`. `SW1A 1AA` opens with letters and was never in doubt, so GB is
 * deliberately absent.
 */
const WRITTEN_FORMS: ReadonlyMap<string, { locale: string; render: (compact: string) => string[] }> = new Map([
	// `NNN NN`, written with the space. The four countries share the shape, which is why
	// `detectKnownFormats` answers all four for one string and why the label is the same for each.
	["CZ", { locale: "cs-CZ", render: spacedThree }],
	["SK", { locale: "sk-SK", render: spacedThree }],
	["SE", { locale: "sv-SE", render: spacedThree }],
	["GR", { locale: "el-GR", render: spacedThree }],
	// `NNNN LL`. Both spellings are attested and the spaced one is what fails.
	[
		"NL",
		{
			locale: "nl-NL",
			render: (compact) =>
				/^\d{4}[A-Z]{2}$/.test(compact) ? [`${compact.slice(0, 4)} ${compact.slice(4)}`, compact] : [],
		},
	],
])

/**
 * `10000` → `["100 00", "10000"]`. Sweden and Greece write five digits with the space after the third, exactly as
 * Czechia and Slovakia do; the compact form rides along because sources store it that way and a reader types it both
 * ways.
 */
function spacedThree(compact: string): string[] {
	if (!/^\d{5}$/.test(compact)) return []

	return [`${compact.slice(0, 3)} ${compact.slice(3)}`, compact]
}

/**
 * Choose distinct postcodes without inheriting the publisher's row order.
 *
 * Sorting first makes the result independent of input-file order; the seeded sample then gives a reproducible spread
 * across the complete set instead of taking the first municipality or numeric prefix that happens to fill the cap.
 */
export function selectPostcodes(codes: Iterable<string>, limit: number, seed: number): string[] {
	const pool = [...new Set(codes)].toSorted()

	if (limit >= pool.length) return pool

	return new SeededRandom(seed).sample(pool, Math.max(0, limit))
}

/**
 * Return every required input path that is absent, preserving declaration order for diagnostics.
 */
export async function findMissingPostcodeSources(
	paths: readonly string[],
	exists: (path: string) => Promise<boolean> = pathExists
): Promise<string[]> {
	const results = await Promise.all(paths.map(async (path) => ({ path, exists: await exists(path) })))

	return results.filter((result) => !result.exists).map(({ path }) => path)
}

/**
 * Every surface a country writes for one postcode, spaced form first, or `[]` when this recipe carries no form for that
 * country or the code does not fit the one it carries.
 *
 * Exported because it is the half of the recipe a test can reach: `run` reads a 500 MB archive from the data root, and
 * the contract worth pinning — that every surface this renders is one {@linkcode detectedAsPostcode} accepts — needs
 * neither.
 */
export function renderBarePostcode(country: string, postcode: string): string[] {
	const form = WRITTEN_FORMS.get(country.trim().toUpperCase())

	if (!form) return []

	return form.render(postcode.trim().toUpperCase().replaceAll(/\s+/gu, ""))
}

/**
 * Whether `known-formats.ts` reads this surface as a postcode across its whole span.
 *
 * A surface the detector does not recognize would train the model on a string the query-shape prior cannot then
 * support, which is the divergence this recipe exists to close rather than widen.
 */
export function detectedAsPostcode(surface: string): boolean {
	return computeQueryShape(surface).knownFormats.some(
		(hit) => isPostcodeFormat(hit.format) && hit.span.start === 0 && hit.span.end === surface.length
	)
}

/**
 * Slice recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const barePostcodeRecipe: CorpusRecipe = {
	name: "bare-postcode",
	description: "A postcode alone, in its country's written form — the shape no slice carries (CZ/SK/SE/NL)",
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

		// Check the complete input set before writing the first row. A missing municipality otherwise
		// produces a plausible non-empty artifact with less Swedish coverage than the recipe declares.
		const missing = await findMissingPostcodeSources(SOURCES.map(({ csv }) => String(csv)))

		if (missing.length) {
			throw new Error(
				`bare-postcode is missing ${missing.length} of ${SOURCES.length} required OpenAddresses files, ` +
					`starting with ${missing[0]}. Fetch the per-source runs into \`openaddresses/extracted/\` ` +
					"(anonymous, see packages/corpus/CLAUDE.md)."
			)
		}

		// A PER-COUNTRY budget, because supply is wildly uneven and the shortage is where the capability
		// broke: the Netherlands publishes ~460,000 distinct `NNNN LL` codes against Czechia's 2,669 and
		// Slovakia's 1,059, so an uncapped pass emits 98.9% Dutch rows and teaches the `NNN NN` countries —
		// the ones reading 0/32 — almost nothing. Equal shares, each country keeping whatever it can fill.
		const countries = [...new Set(SOURCES.map((source) => source.country))]
		const budget = opts.count ? Math.ceil(opts.count / countries.length) : Number.POSITIVE_INFINITY
		const perCountry = new Map(countries.map((country) => [country, 0]))
		const codesByCountry = new Map(countries.map((country) => [country, new Set<string>()]))

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

					// A surface the detector does not read as a postcode is a disagreement between this table
					// and `known-formats.ts`, and emitting it would teach a string the prior cannot support.
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
						source_id: sliceSourceID("synth-bare-postcode", {
							...components,
							c: country,
						}),
						corpus_version: "0.30.0",
						license:
							"Synthetic — bare-postcode; postcodes from OpenAddresses (per-source attribution in the model card)",
					}

					if (alignAndWrite(write, canonical, "bare-postcode")) {
						emitted++
						perCountry.set(country, perCountry.get(country)! + 1)
					} else {
						skipped++
					}
				}
			}
		}

		// A surface this table renders and the detector refuses is a contract break, not a data quirk: every
		// form here is one `known-formats.ts` declares a pattern for, so the count is expected to be zero and
		// a non-zero one names which side moved.
		if (unrecognized > 0) {
			throw new Error(
				`${unrecognized} rendered surfaces were not read as a postcode by detectKnownFormats — the ` +
					"WRITTEN_FORMS table and known-formats.ts's PATTERNS disagree. Reconcile them before building."
			)
		}

		// AN EMPTY BUILD IS A FAILURE, NOT AN EMPTY ANSWER. Required files were preflighted above, so zero
		// rows here means their postcode columns or the written-form rules no longer provide usable data.
		if (emitted === 0) {
			throw new Error(
				`bare-postcode emitted no rows from ${SOURCES.length} readable sources. ` +
					"The postcode columns or the written-form rules changed."
			)
		}

		return { read, emitted, skipped }
	},
}
