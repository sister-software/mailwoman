/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Write `docs/engineering/reference/jurisdiction-coverage.mdx` — one row per jurisdiction, stating
 *   what this repository has for it.
 *
 *   The question "which jurisdictions do we have" has been answered in conversation repeatedly and
 *   committed nowhere, so each answer was derived again and then lost. This generator exists so the
 *   answer is a file a reader opens.
 *
 *   The denominator is every ISO 3166-1 alpha-2 code in `@mailwoman/codex/country` plus the non-ISO
 *   operational codes `@mailwoman/codex/postal-regimes` carries, which is the 250 the source register
 *   enumerates. A jurisdiction with no presence in any layer still gets a row: an absent row and a
 *   zero row are different findings, and leaving one out reports the wrong one.
 *
 *   Every number comes from `censusCoverage`, the same reader `mwdev_coverage` calls, so this page and
 *   that tool cannot disagree. Corpus counts are the cached census unless `--refresh` is passed, and
 *   the page states which corpus version they were taken over.
 *
 *   This writes markdown tables with single-space padding and the repository's formatter aligns their
 *   columns, so a regeneration shows every table row as changed until the formatter runs. Run it and the
 *   diff empties when the content has not moved.
 *
 *   Run:
 *
 *       node packages/mailwoman/lib/dev-tools/corpus/jurisdiction-coverage.run.ts
 *       node packages/mailwoman/lib/dev-tools/corpus/jurisdiction-coverage.run.ts --refresh --config <path>
 */

import { ISO2_TO_NAME, CountryISO2 } from "@mailwoman/codex/country"
import { POSTAL_REGIMES } from "@mailwoman/codex/postal-regimes"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { readScopeConfig } from "@mailwoman/core/scope-config"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { join, relative } from "path-ts"

import {
	admittedByShippedGraphs,
	censusCoverage,
	type CountryCoverage,
	newestManifest,
	readAdmittedCountries,
	resolveTrainingConfig,
} from "#coverage"

const { values } = parseArguments({
	options: {
		config: { type: "string" },
		"next-config": { type: "string" },
		out: { type: "string" },
		refresh: { type: "boolean", default: false },
	},
})

/**
 * A repo-relative path, so a generated page carries no reader's home directory.
 */
const relativeToRepo = (path: string): string => relative(String(repoRootPath()), path)

const scope = await readScopeConfig()
const configPath = resolveTrainingConfig(scope, { requested: values.config }).path
const manifestPath = await newestManifest()
/**
 * Which shipped graph's training config admits each jurisdiction.
 *
 * Admission is per graph and the two shipped graphs partition the world between them,
 * so one config's list understates what ships.
 * `censusCoverage` reads one config.
 * This reads the union of both.
 */
const shippedFamilies = await admittedByShippedGraphs(scope)

const report = await censusCoverage({
	configPath,
	manifestPath,
	refresh: values.refresh,
	casesRoot: String(join(repoRootPath(), "packages/mailwoman/lib/eval-harness/gauntlet/cases")),
})

/**
 * Every jurisdiction the page reports on, whether or not any layer holds it.
 *
 * The census covers the union of the corpus, the admission list, the board and the gazetteer.
 * A code present in none of those is absent from the census and still belongs in the table,
 * so the ISO list and the postal regimes' own codes are unioned in.
 */
const jurisdictions = new Set<string>([
	...Object.values(CountryISO2),
	...POSTAL_REGIMES.flatMap((regime) => regime.iso2),
	...report.countries.map((country) => country.country),
])

const measured = new Map<string, CountryCoverage>(report.countries.map((country) => [country.country, country]))

/**
 * The state of one jurisdiction's parse capability, in the four readings that differ.
 *
 * `absent` and `declined` are separate readings.
 * `absent` says every layer lacks the code, and `declined` says the admission list
 * omits a code the gazetteer or the board does hold.
 */
function parseState(coverage: CountryCoverage | undefined): string {
	if (!coverage) return "absent"

	if (!coverage.admitted) {
		return coverage.corpusRows > 0 ? `${coverage.corpusRows.toLocaleString()} rows, declined` : "declined"
	}

	if (coverage.corpusRows === 0) return "admitted, 0 rows"

	return coverage.corpusStreetRows > 0
		? `${coverage.corpusRows.toLocaleString()} rows`
		: `${coverage.corpusRows.toLocaleString()} rows, 0 street`
}

function geocodeState(coverage: CountryCoverage | undefined): string {
	if (!coverage) return "absent"

	if (coverage.geocodeTier === "rooftop-published") return "rooftop"

	return coverage.gazetteerPlaces > 0 ? coverage.gazetteerPlaces.toLocaleString() : "0"
}

function boardState(coverage: CountryCoverage | undefined): string {
	if (!coverage?.boardRows) return "—"

	return `${coverage.boardPassedRows}/${coverage.boardRows}`
}

const sorted = [...jurisdictions].toSorted((a, b) => {
	const rows = (measured.get(b)?.corpusRows ?? 0) - (measured.get(a)?.corpusRows ?? 0)

	return rows === 0 ? a.localeCompare(b) : rows
})

const withRows = sorted.filter((code) => (measured.get(code)?.corpusRows ?? 0) > 0)
const withStreetRows = withRows.filter((code) => (measured.get(code)?.corpusStreetRows ?? 0) > 0)
const admitted = sorted.filter((code) => shippedFamilies.has(code))
const admittedEmpty = admitted.filter((code) => !measured.get(code)?.corpusRows)
const notAdmitted = sorted.filter((code) => measured.has(code) && !shippedFamilies.has(code))
/**
 * Jurisdictions the corpus holds rows for that no shipped graph's config admits.
 *
 * Those rows train nothing that ships.
 * A reader comparing the corpus against the model needs this separated from a jurisdiction
 * the corpus holds no row for, because closing this one takes a `country_weights` entry
 * while closing the other takes acquiring data.
 */
const droppedWithRows = withRows.filter((code) => !shippedFamilies.has(code))
const absent = sorted.filter((code) => !measured.has(code))
const rooftop = withRows.filter((code) => measured.get(code)?.geocodeTier === "rooftop-published")
const packaged = sorted.filter((code) => measured.get(code)?.weightsPackage)

/**
 * The admission list of a second config, when one is named.
 *
 * The default config is the one the register says produced the shipped graph,
 * so the table describes what ships.
 * A config in flight commonly admits a wider set, and reading its count beside the shipped
 * one is what distinguishes what the next run would admit from what today's model was taught.
 */
const nextConfig = values["next-config"]
const nextAdmitted = nextConfig ? await readAdmittedCountries(nextConfig) : null
const newlyAdmitted = nextAdmitted ? sorted.filter((code) => nextAdmitted.has(code) && !shippedFamilies.has(code)) : []
/**
 * Jurisdictions a shipped graph admits that the second config does not.
 *
 * Empty is the expected reading.
 * A code here trains today and would stop training under that config, which is a
 * regression the config's author has to have intended.
 */
const nextDrops = nextAdmitted ? admitted.filter((code) => !nextAdmitted.has(code)) : []

const rows = sorted.map((code) => {
	const coverage = measured.get(code)
	const name = ISO2_TO_NAME.get(code) ?? "—"
	const street = coverage?.corpusStreetRows ? coverage.corpusStreetRows.toLocaleString() : "0"

	const families = shippedFamilies.get(code)

	return `| \`${code}\` | ${name} | ${parseState(coverage)} | ${street} | ${families ? families.join(", ") : "—"} | ${geocodeState(coverage)} | ${coverage?.weightsPackage ?? "—"} | ${boardState(coverage)} |`
})

const regimeRows = POSTAL_REGIMES.map(
	(regime) =>
		`| ${regime.name} | ${regime.kind} | ${regime.iso2.map((code) => `\`${code}\``).join(", ")} | ${regime.coverage} |`
)

const page = `---
title: What this repository has, per jurisdiction
role: reference
audience: maintainer
owner: operations
---

{/* Generated by packages/mailwoman/lib/dev-tools/corpus/jurisdiction-coverage.run.ts. Edit that file. */}

# What this repository has, per jurisdiction

One row per jurisdiction, over ${sorted.length} of them: every ISO 3166-1 alpha-2 code in
\`@mailwoman/codex/country\` plus the non-ISO operational codes \`@mailwoman/codex/postal-regimes\`
carries. Regenerate with:

\`\`\`sh
node packages/mailwoman/lib/dev-tools/corpus/jurisdiction-coverage.run.ts --refresh
\`\`\`

Corpus counts were taken over \`${report.corpusVersion}\`${report.corpusCensusTakenAt ? `, cached ${report.corpusCensusTakenAt}` : ", counted in this run"}, ${report.corpusRowsTotal.toLocaleString()} rows.
**Admitted by** names the shipped graph whose training config admits the jurisdiction. Admission is per
graph and the two shipped graphs partition the world between them, so the column reads the union of
\`scope.config.json\`'s registered configs rather than any one of them. \`${relativeToRepo(report.configPath)}\`
is the one \`censusCoverage\` read for its own mismatch findings.${
	report.corpusMismatch
		? `\n\nThat config declares a different corpus version from the one the census counted, so a row count
here describes the counted corpus rather than the one that config trains on. A zero therefore states
what the counted corpus holds rather than establishing that the source has none.`
		: ""
}${
	nextConfig
		? `\n\n\`${relativeToRepo(nextConfig)}\` is a second config read for comparison. It admits
${nextAdmitted!.size} jurisdictions against the ${admitted.length} the shipped graphs admit between them, and the
${newlyAdmitted.length} it adds are listed below the table.`
		: ""
}

## What the columns separate

**Corpus rows** counts rows in the training corpus. **Street rows** counts those carrying a \`street\`
or \`house_number\` label, which are the rows that teach an address rather than a name: a jurisdiction
can hold millions of rows while its street-row count reads 0. CN reads 11,357,947 and 0.

**Admission** is \`country_weights\` in the training config, a hard filter. A code absent from it
trains on nothing whatever the corpus holds. A code present in it with no corpus row trains on
nothing either, by the other route.

**Gazetteer** counts admin places available to resolve, and \`rooftop\` marks the two jurisdictions
whose rooftop database a consumer can obtain. Every other rooftop database is build-local.

**Weights package** existing is not training. One model graph serves every locale; the other packages
are data-only overlays over it.

**Board** counts rows that check rather than merely track, over rows present. A jurisdiction reading
\`—\` has no board row, which is unmeasured rather than failing.

## Counts

| reading | jurisdictions |
| --- | ---: |
| declared in this table | ${sorted.length} |
| corpus holds at least one row | ${withRows.length} |
| of those, at least one street row | ${withStreetRows.length} |
| admitted by \`country_weights\` | ${admitted.length} |
| admitted, zero corpus rows | ${admittedEmpty.length} |
| corpus rows no shipped graph admits | ${droppedWithRows.length} |
| declined by every shipped config | ${notAdmitted.length} |
| absent from every layer | ${absent.length} |
| rooftop geocoding a consumer can obtain | ${rooftop.length} |
| carries a weights package | ${packaged.length} |

## Every jurisdiction

| code | name | corpus rows | street rows | admitted by | gazetteer | weights | board |
| --- | --- | --- | ---: | --- | ---: | --- | ---: |
${rows.join("\n")}

${
	droppedWithRows.length
		? `## Corpus rows no shipped graph admits

${droppedWithRows.map((code) => `\`${code}\` (${measured.get(code)!.corpusRows.toLocaleString()})`).join(", ")}

Each of these holds corpus rows and appears in neither shipped graph's \`country_weights\`, so those
rows train nothing that ships. This is the mechanism that left Norway untaught while its rows sat in
the corpus. A jurisdiction here that also carries a weights package is served by a data-only overlay
over a graph that was never taught it.

`
		: ""
}${
	nextConfig
		? `## Jurisdictions the second config would newly admit

${newlyAdmitted.length ? newlyAdmitted.map((code) => `\`${code}\``).join(" ") : "None."}

Admission is not teaching. Each of these trains on nothing until the corpus holds a row for it.

It stops admitting ${nextDrops.length} of the jurisdictions a shipped graph admits${nextDrops.length ? `: ${nextDrops.map((code) => `\`${code}\``).join(" ")}` : "."}

`
		: ""
}## Separately modelled postal jurisdictions

A postal regime is a way of writing an address that does not follow its ISO code's own hierarchy.
Each row states what the repository models rather than what the regime is.

| regime | kind | codes | coverage |
| --- | --- | --- | --- |
${regimeRows.join("\n")}
`

const out = values.out ?? String(join(repoRootPath(), "docs/engineering/reference/jurisdiction-coverage.mdx"))

await writeLocalTextFile(page, out)

console.log(`wrote ${out}`)
console.log(
	`  ${sorted.length} jurisdictions, ${withRows.length} with corpus rows, ${withStreetRows.length} with street rows`
)
console.log(
	`  ${admittedEmpty.length} admitted with no rows, ${notAdmitted.length} not admitted, ${absent.length} absent everywhere`
)
