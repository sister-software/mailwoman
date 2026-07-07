/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regenerates `codex/country/official-languages.ts` from Unicode CLDR supplemental data
 *   (territoryInfo `_officialStatus` + languageAlias). The emitted table is the #936 ingest bit's
 *   authority for "is this name row in an official language of its country?" — consumed by the
 *   gazetteer builders (`scripts/build-unified-wof.ts`, `@mailwoman/resolver-wof-sqlite`'s GeoNames
 *   fold), never at query time.
 *
 *   Each language is emitted under EVERY ISO-639 spelling CLDR aliases to it (fi + fin, sv + swe)
 *   so consumers can test WOF's 639-3 tags, Overture's BCP-47 keys, and GeoNames' mixed 2/3-letter
 *   codes without a mapping step.
 *
 *   Usage: node scripts/generate-official-languages.ts [--cldr-dir <dir>] [--cldr-version 47.0.0]
 *
 *   With --cldr-dir, reads cldr-territoryInfo.json + cldr-aliases.json from disk; otherwise fetches
 *   the pinned cldr-core release from jsdelivr.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

const { values: cliValues } = parseArgs({
	options: { "cldr-version": { type: "string" }, "cldr-dir": { type: "string" } },
})
const CLDR_VERSION = cliValues["cldr-version"] ?? "47.0.0"
const cldrDir = cliValues["cldr-dir"]
const OUT_PATH = join(import.meta.dirname, "..", "codex", "country", "official-languages.ts")

async function loadCLDR(file: string): Promise<unknown> {
	if (cldrDir) return JSON.parse(readFileSync(join(cldrDir, `cldr-${file}.json`), "utf8"))
	const url = `https://cdn.jsdelivr.net/npm/cldr-core@${CLDR_VERSION}/supplemental/${file}.json`
	const res = await fetch(url)

	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)

	return res.json()
}

interface LanguagePopulation {
	_officialStatus?: string
}

const territoryInfo = ((await loadCLDR("territoryInfo")) as Record<string, Record<string, Record<string, unknown>>>)
	.supplemental!.territoryInfo as Record<string, { languagePopulation?: Record<string, LanguagePopulation> }>
const aliasesDoc = (await loadCLDR("aliases")) as {
	supplemental: { metadata: { alias: { languageAlias: Record<string, { _replacement?: string }> } } }
}
const languageAlias = aliasesDoc.supplemental.metadata.alias.languageAlias

// canonical code → every plain 2-3 letter alias spelling that maps to it (fi gains "fin")
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

for (const territory of Object.keys(territoryInfo).sort()) {
	if (!/^[A-Z]{2}$/.test(territory)) continue
	const pops = territoryInfo[territory]!.languagePopulation

	if (!pops) continue
	const official = new Set<string>()
	const regional = new Set<string>()

	for (const [lang, data] of Object.entries(pops)) {
		const status = data._officialStatus

		if (!status) continue
		// CLDR keys can carry script subtags ("zh_Hant") — name tags use the base language.
		const base = lang.split("_")[0]!
		const spellings = [base, ...(spellingsOf.get(base) ?? [])].sort()

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

	if (official.size === 0 && regional.size === 0) continue
	table[territory] = { official: [...official].sort() }

	if (regional.size > 0) {
		table[territory]!.regional = [...regional].sort()
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
 *   GENERATED — do not edit by hand. Official languages per ISO 3166-1 territory, derived from
 *   Unicode CLDR ${CLDR_VERSION} supplemental territoryInfo (\`_officialStatus\`). \`official\` merges
 *   CLDR's \`official\` + \`de_facto_official\`; \`regional\` is \`official_regional\` (kept separate —
 *   the #936 probe showed it pulls in cross-border quirks like Korean-in-CN, so consumers opt in).
 *   Every language appears under each ISO-639 spelling CLDR aliases to it (fi AND fin) so WOF
 *   639-3 tags, Overture BCP-47 keys, and GeoNames codes all match without mapping.
 *   Regenerate with scripts/generate-official-languages.ts.
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

writeFileSync(OUT_PATH, header)
console.log(`Wrote ${OUT_PATH}: ${Object.keys(table).length} territories (CLDR ${CLDR_VERSION})`)
