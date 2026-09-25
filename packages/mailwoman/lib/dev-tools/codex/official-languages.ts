/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Regenerates the committed `codex/country/official-languages.ts` table from Unicode CLDR supplemental data.
 */

import { isAlpha2CodeShape } from "@mailwoman/codex/country"
import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { PathBuilder, type PathBuilderLike } from "path-ts"
/**
 * Resolves the committed table from the `@mailwoman/codex` package root, so the path
 * is the same from the source tree, `out/` and a published tarball.
 */
const DEFAULT_OUT = resolvePackagePath("@mailwoman/codex", "lib", "country", "official-languages.ts")

/**
 * Configures {@linkcode generateOfficialLanguages}.
 */
export interface GenerateOfficialLanguagesOptions {
	/**
	 * Reads `cldr-territoryInfo.json` and `cldr-aliases.json` from this directory instead of fetching them.
	 */
	cldrDir?: PathBuilderLike
	/**
	 * Sets the cldr-core release to fetch from jsdelivr when `cldrDir` is absent.
	 */
	cldrVersion?: string
	/**
	 * Overrides the output path, which defaults to the committed `codex/country/official-languages.ts`.
	 */
	out?: string
}

/**
 * Summarizes a {@linkcode generateOfficialLanguages} run.
 */
export interface GenerateOfficialLanguagesSummary {
	territories: number
	cldrVersion: string
	outPath: string
}

/**
 * Fetches CLDR supplemental files with retries.
 *
 * The generator makes only two requests, so the client sets no rate budget.
 */
const cldrClient = new APIClient({ displayName: "cldr", retry: true })

interface LanguagePopulation {
	_officialStatus?: string
}

async function loadCLDR(file: string, cldrDir: PathBuilderLike | undefined, cldrVersion: string): Promise<unknown> {
	if (cldrDir) {
		return await readLocalJSONFile(PathBuilder.from(cldrDir)(`cldr-${file}.json`))
	}

	const url = `https://cdn.jsdelivr.net/npm/cldr-core@${cldrVersion}/supplemental/${file}.json`

	return cldrClient.fetch<unknown>({ url }).then(pluckResponseData)
}

/**
 * Regenerates the committed `OFFICIAL_LANGUAGES` table from CLDR supplemental data.
 *
 * Gazetteer builders read the table to decide whether a name row is in an official language of its country.
 * Each language appears under every ISO 639 spelling that CLDR aliases to it, such as `fi`
 * and `fin`, so WOF, Overture and GeoNames codes all match without a mapping step.
 */
export async function generateOfficialLanguages(
	options: GenerateOfficialLanguagesOptions = {},
	report?: (line: string) => void
): Promise<GenerateOfficialLanguagesSummary> {
	const cldrVersion = options.cldrVersion ?? "47.0.0"
	const outPath = options.out ?? DEFAULT_OUT

	const territoryInfo = (
		(await loadCLDR("territoryInfo", options.cldrDir, cldrVersion)) as Record<
			string,
			Record<string, Record<string, unknown>>
		>
	).supplemental!.territoryInfo as Record<string, { languagePopulation?: Record<string, LanguagePopulation> }>

	const aliasesDoc = (await loadCLDR("aliases", options.cldrDir, cldrVersion)) as {
		supplemental: { metadata: { alias: { languageAlias: Record<string, { _replacement?: string }> } } }
	}

	const languageAlias = aliasesDoc.supplemental.metadata.alias.languageAlias

	// This maps each canonical code to its two- and three-letter alias spellings.
	const spellingsOf = new Map<string, Set<string>>()

	for (const [alias, entry] of Object.entries(languageAlias)) {
		const canon = entry._replacement

		if (!canon || !/^[a-z]{2,3}$/.test(alias)) continue
		let set = spellingsOf.get(canon)

		if (!set) {
			spellingsOf.set(canon, (set = new Set()))
		}

		set.add(alias)
	}

	const table: Record<string, { official: string[]; regional?: string[] }> = {}

	for (const territory of Object.keys(territoryInfo).toSorted()) {
		if (!isAlpha2CodeShape(territory)) continue
		const pops = territoryInfo[territory]!.languagePopulation

		if (!pops) continue
		const official = new Set<string>()
		const regional = new Set<string>()

		for (const [lang, data] of Object.entries(pops)) {
			const status = data._officialStatus

			if (!status) continue
			// CLDR keys can have script subtags such as `zh_Hant`, but name tags use the base language.
			const base = lang.split("_")[0]!
			const spellings = [base, ...(spellingsOf.get(base) ?? [])].toSorted()

			if (status === "official" || status === "de_facto_official") {
				for (const s of spellings) {
					official.add(s)
				}
			} else if (status === "official_regional") {
				for (const s of spellings) {
					regional.add(s)
				}
			}
		}

		if (!official.size && !regional.size) continue
		table[territory] = { official: [...official].toSorted() }

		if (regional.size) {
			table[territory]!.regional = [...regional].toSorted()
		}
	}

	const entries = Object.entries(table)
		.map(([cc, v]) => {
			const reg = v.regional ? `, regional: [${v.regional.map((l) => `"${l}"`).join(", ")}]` : ""

			return `\t${cc}: { official: [${v.official.map((l) => `"${l}"`).join(", ")}]${reg} },`
		})
		.join("\n")

	const header = `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   generated — do not edit by hand. Official languages per ISO 3166-1 territory, derived from
 *   Unicode CLDR ${cldrVersion} supplemental territoryInfo (\`_officialStatus\`). \`official\` merges
 *   CLDR's \`official\` + \`de_facto_official\`; \`regional\` is \`official_regional\` (kept separate —
 *   the #936 probe showed it pulls in cross-border quirks like Korean-in-CN, so consumers opt in).
 *   Every language appears under each ISO-639 spelling CLDR aliases to it (fi and fin) so WOF
 *   639-3 tags, Overture BCP-47 keys, and GeoNames codes all match without mapping.
 *   Regenerate with: mailwoman dev generate official-languages
 */

/** Official-language spellings for one territory. */
export interface OfficialLanguageEntry {
	/** CLDR \`official\` + \`de_facto_official\`, in every ISO-639 spelling. */
	official: readonly string[]
	/** CLDR \`official_regional\` (e.g. Catalan in ES) — opt-in for consumers. */
	regional?: readonly string[]
}

/** ISO 3166-1 alpha-2 → official languages. */
export const OFFICIAL_LANGUAGES: Record<string, OfficialLanguageEntry> = {
${entries}
}

/**
 * Is \`language\` (any ISO-639 spelling: "sv", "swe", …) an official language of \`country\` (ISO
 * 3166-1 alpha-2)? Regional-official languages count only with \`includeRegional\`.
 */
export function isOfficialLanguage(country: string, language: string, includeRegional = false): boolean {
	const entry = OFFICIAL_LANGUAGES[country.toUpperCase()]

	if (!entry) return false
	const lang = language.toLowerCase()

	return entry.official.includes(lang) || (includeRegional && (entry.regional?.includes(lang) ?? false))
}
`

	await writeLocalFile(header, outPath)
	report?.(`Wrote ${outPath}: ${Object.keys(table).length} territories (CLDR ${cldrVersion})`)

	return { territories: Object.keys(table).length, cldrVersion, outPath }
}
