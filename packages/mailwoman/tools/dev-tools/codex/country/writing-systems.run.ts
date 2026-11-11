/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regenerates the committed `codex/country/writing-systems.ts` table: the written scripts of each territory's official
 *   languages, from Unicode CLDR supplemental `territoryInfo` and `likelySubtags`.
 *
 *   A `territoryInfo` key with a script subtag (`sr_Latn`, `zh_Hant`) takes that script. A bare language key
 *   takes the script of `likelySubtags` for the language in that territory (`sr-ME` → Latn), then for the bare
 *   language (`sr` → Cyrl). The ISO 15924 codes for a combination of scripts expand to the Unicode Script property
 *   values a text is written in, so `Jpan` gives Hani, Hira and Kana. Only `official` and `de_facto_official`
 *   languages count, as in `OFFICIAL_LANGUAGES`, and the tool refuses a territory the two tables disagree on.
 *
 *   Run: node packages/mailwoman/tools/dev-tools/codex/country/writing-systems.run.ts [--cldr-dir <dir>] [--out <file>]
 */

import { isAlpha2CodeShape } from "@mailwoman/codex/country"
import { OFFICIAL_LANGUAGES } from "@mailwoman/codex/country/official-languages"
import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { countInto } from "@mailwoman/core/stats"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * Resolves the committed table from the `@mailwoman/codex` package root.
 */
const DEFAULT_OUT = resolvePackagePath("@mailwoman/codex", "lib", "country", "writing-systems.ts")

const DEFAULT_CLDR_VERSION = "47.0.0"

/**
 * The ISO 15924 codes that name a combination of scripts, and the Unicode
 * Script property values each covers.
 *
 * ISO 15924 defines `Jpan` as Han with Hiragana and Katakana, `Kore` as Hangul with Han
 * and `Hanb` as Han with Bopomofo.
 * `Hans` and `Hant` are variants of Han.
 * The Unicode Script property writes Han as `Hani`.
 */
const SCRIPT_COMBINATIONS: Readonly<Record<string, readonly string[]>> = {
	Jpan: ["Hani", "Hira", "Kana"],
	Kore: ["Hang", "Hani"],
	Hanb: ["Hani", "Bopo"],
	Hans: ["Hani"],
	Hant: ["Hani"],
}

const OFFICIAL_STATUSES = new Set(["official", "de_facto_official"])

interface LanguagePopulation {
	_officialStatus?: string
}

type TerritoryInfo = Record<string, { languagePopulation?: Record<string, LanguagePopulation> }>

/**
 * Configures {@linkcode generateCountryScripts}.
 */
export interface GenerateCountryScriptsOptions {
	/**
	 * Reads `cldr-territoryInfo.json` and `cldr-likelySubtags.json` from this directory
	 * instead of fetching them.
	 */
	cldrDir?: PathBuilderLike
	/**
	 * Sets the cldr-core release to fetch from jsdelivr when `cldrDir` is absent.
	 */
	cldrVersion?: string
	/**
	 * Overrides the output path.
	 */
	out?: PathBuilderLike
}

/**
 * Summarizes a {@linkcode generateCountryScripts} run.
 */
export interface GenerateCountryScriptsSummary {
	outPath: string
	cldrVersion: string
	/**
	 * The script codes of each territory.
	 */
	table: Readonly<Record<string, readonly string[]>>
	/**
	 * Territories by script count: `{ 1: 201, 2: 30, … }`.
	 */
	distribution: ReadonlyMap<number, number>
}

const cldrClient = new APIClient({ displayName: "cldr", retry: true })

async function loadCLDR(file: string, cldrDir: PathBuilderLike | null, cldrVersion: string): Promise<unknown> {
	if (cldrDir) {
		return readLocalJSONFile(PathBuilder.from(cldrDir)(`cldr-${file}.json`))
	}

	const url = `https://cdn.jsdelivr.net/npm/cldr-core@${cldrVersion}/supplemental/${file}.json`

	return cldrClient.fetch<unknown>({ url }).then(pluckResponseData)
}

/**
 * Returns the script subtag of a `likelySubtags` value such as `sr-Cyrl-RS`.
 */
function subtagScript(tag: string | undefined): string | null {
	return tag?.split("-").find((part) => /^[A-Z][a-z]{3}$/u.test(part)) ?? null
}

/**
 * Returns the script codes of each territory's official languages.
 *
 * @throws When an official language resolves to no script, or a territory's
 * official-language presence disagrees with `OFFICIAL_LANGUAGES`.
 */
export function countryScriptTable(
	territoryInfo: TerritoryInfo,
	likelySubtags: Readonly<Record<string, string>>
): Record<string, string[]> {
	const table: Record<string, string[]> = {}

	for (const territory of Object.keys(territoryInfo).toSorted()) {
		if (!isAlpha2CodeShape(territory)) continue

		const scripts = new Set<string>()

		for (const [key, data] of Object.entries(territoryInfo[territory]!.languagePopulation ?? {})) {
			if (!data._officialStatus || !OFFICIAL_STATUSES.has(data._officialStatus)) continue

			const [language, subtag] = key.split("_")

			const script =
				subtag && /^[A-Z][a-z]{3}$/u.test(subtag)
					? subtag
					: (subtagScript(likelySubtags[`${language}-${territory}`]) ?? subtagScript(likelySubtags[language!]))

			if (!script) {
				throw new Error(`CLDR likelySubtags gives no script for official language ${key} of ${territory}`)
			}

			for (const value of SCRIPT_COMBINATIONS[script] ?? [script]) {
				scripts.add(value)
			}
		}

		const hasOfficial = (OFFICIAL_LANGUAGES[territory]?.official.length ?? 0) > 0

		if (hasOfficial !== scripts.size > 0) {
			throw new Error(
				`${territory}: OFFICIAL_LANGUAGES ${hasOfficial ? "lists" : "lacks"} an official language, ` +
					`but this CLDR release ${scripts.size ? "lists" : "lacks"} one. Regenerate official-languages first.`
			)
		}

		if (scripts.size) {
			table[territory] = [...scripts].toSorted()
		}
	}

	return table
}

/**
 * Renders the committed module from a table and its distribution.
 */
function renderModule(table: Readonly<Record<string, readonly string[]>>, cldrVersion: string): string {
	const distribution = scriptCountDistribution(table)
	const scripts = [...new Set(Object.values(table).flat())].toSorted()
	const multi = Object.entries(table).filter(([, values]) => values.length > 1)

	const distributionLines = [...distribution]
		.map(([count, territories]) => ` *   - ${count} script${count === 1 ? "" : "s"}: ${territories} territories`)
		.join("\n")

	const multiLines = multi.map(([cc, values]) => ` *   - ${cc}: ${values.join(", ")}`).join("\n")

	const rows = Object.entries(table)
		.map(([cc, values]) => `\t${cc}: [${values.map((s) => `"${s}"`).join(", ")}],`)
		.join("\n")

	return `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generated, so do not edit by hand. The written scripts of each ISO 3166-1 territory's official languages,
 *   derived from Unicode CLDR ${cldrVersion} supplemental territoryInfo and likelySubtags. A combined ISO 15924
 *   code expands to the Unicode Script property values it covers, so Japanese gives Hani, Hira and Kana.
 *   Regenerate with: node packages/mailwoman/tools/dev-tools/codex/country/writing-systems.run.ts
 *
 *   ${Object.keys(table).length} territories by script count:
 *
${distributionLines}
 *
 *   Territories with more than one script:
 *
${multiLines}
 */

/**
 * A Unicode Script property value that some territory's official language is written in.
 */
export type ScriptCode =
${scripts.map((s) => `\t| "${s}"`).join("\n")}

/**
 * Every {@linkcode ScriptCode}, sorted.
 */
export const SCRIPT_CODES: readonly ScriptCode[] = [
${scripts.map((s) => `\t"${s}",`).join("\n")}
]

/**
 * ISO 3166-1 alpha-2 → the scripts its official languages are written in, sorted.
 *
 * A territory without an official language in CLDR has no row.
 */
export const COUNTRY_SCRIPTS: Readonly<Record<string, readonly ScriptCode[]>> = {
${rows}
}
`
}

/**
 * Counts territories by their number of scripts.
 */
export function scriptCountDistribution(table: Readonly<Record<string, readonly string[]>>): Map<number, number> {
	const counts = new Map<number, number>()

	for (const values of Object.values(table)) {
		countInto(counts, values.length)
	}

	return new Map([...counts].toSorted(([a], [b]) => a - b))
}

/**
 * Regenerates the committed `COUNTRY_SCRIPTS` table.
 */
export async function generateCountryScripts(
	options: GenerateCountryScriptsOptions = {},
	report?: (line: string) => void
): Promise<GenerateCountryScriptsSummary> {
	const cldrVersion = options.cldrVersion ?? DEFAULT_CLDR_VERSION
	const cldrDir = options.cldrDir ?? null
	const outPath = PathBuilder.from(options.out ?? DEFAULT_OUT).toString()

	const territoryInfo = (
		(await loadCLDR("territoryInfo", cldrDir, cldrVersion)) as { supplemental: { territoryInfo: TerritoryInfo } }
	).supplemental.territoryInfo

	const likelySubtags = (
		(await loadCLDR("likelySubtags", cldrDir, cldrVersion)) as {
			supplemental: { likelySubtags: Record<string, string> }
		}
	).supplemental.likelySubtags

	const table = countryScriptTable(territoryInfo, likelySubtags)
	const distribution = scriptCountDistribution(table)

	await writeLocalTextFile(renderModule(table, cldrVersion), outPath)

	report?.(`Wrote ${outPath}: ${Object.keys(table).length} territories (CLDR ${cldrVersion})`)

	for (const [count, territories] of distribution) {
		report?.(`  ${count} script${count === 1 ? "" : "s"}: ${territories} territories`)
	}

	return { outPath, cldrVersion, table, distribution }
}

runIfScript(import.meta, async () => {
	const { values } = parseArguments({
		options: {
			"cldr-dir": { type: "string" },
			"cldr-version": { type: "string" },
			out: { type: "string" },
		},
	})

	await generateCountryScripts(
		{ cldrDir: values["cldr-dir"], cldrVersion: values["cldr-version"], out: values.out },
		console.log
	)
})
