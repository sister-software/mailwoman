/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Write `docs/engineering/reference/jurisdiction-coverage.mdx` — one row per jurisdiction, over the denominator
 *   of every ISO 3166-1 alpha-2 code plus the non-ISO operational codes, so a jurisdiction with no presence in any
 *   layer still gets a row: an absent row and a zero row are different findings.
 *
 *   Every number comes from `censusCoverage`, the same reader `mwdev_coverage` calls, so this page and that tool
 *   cannot disagree.
 *
 *   This writes markdown tables with single-space padding, so a regeneration shows every table row as changed until
 *   the repository's formatter runs.
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
import { type PathBuilderLike, relative } from "path-ts"

import {
	admittedByShippedGraphs,
	censusCoverage,
	type CountryCoverage,
	GeocodeReading,
	geocodeReading,
	newestManifest,
	ParseReading,
	parseReading,
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
const relativeToRepo = (path: PathBuilderLike): string => relative(repoRootPath(), path)

const scope = await readScopeConfig()
const configPath = resolveTrainingConfig(scope, { requested: values.config }).path
const manifestPath = await newestManifest()
/**
 * Which shipped graph's training config admits each jurisdiction, read as the union
 * of both graphs because `censusCoverage` reads only one config.
 */
const shippedFamilies = await admittedByShippedGraphs(scope)

const report = await censusCoverage({
	configPath,
	manifestPath,
	refresh: values.refresh,
	casesRoot: repoRootPath("packages", "mailwoman", "lib", "eval-harness", "gauntlet", "cases"),
})

/**
 * Every jurisdiction the page reports on, whether or not any layer holds it: the ISO list
 * and the postal regimes' own codes are unioned in so a code absent from the census still belongs.
 */
const jurisdictions = new Set<string>([
	...Object.values(CountryISO2),
	...POSTAL_REGIMES.flatMap((regime) => regime.iso2),
	...report.countries.map((country) => country.country),
])

const measured = new Map<string, CountryCoverage>(report.countries.map((country) => [country.country, country]))

/**
 * The state of one jurisdiction's parse capability, keeping `absent` and `declined` separate readings.
 */
function parseState(coverage: CountryCoverage | undefined): string {
	const rows = coverage ? coverage.corpusRows.toLocaleString() : "0"

	// The street count sits in its own column, so the phrase omits what `mwdev_coverage`'s one-line form names.
	return {
		[ParseReading.Absent]: "absent",
		[ParseReading.Declined]: "declined",
		[ParseReading.DeclinedWithRows]: `${rows} rows, declined`,
		[ParseReading.AdmittedEmpty]: "admitted, 0 rows",
		[ParseReading.RowsWithStreet]: `${rows} rows`,
		[ParseReading.RowsWithoutStreet]: `${rows} rows, 0 street`,
	}[parseReading(coverage)]
}

function geocodeState(coverage: CountryCoverage | undefined): string {
	return {
		[GeocodeReading.Absent]: "absent",
		[GeocodeReading.Rooftop]: "rooftop",
		[GeocodeReading.Locality]: coverage ? coverage.gazetteerPlaces.toLocaleString() : "0",
		[GeocodeReading.None]: "0",
	}[geocodeReading(coverage)]
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
 * Jurisdictions the corpus holds rows for that no shipped graph admits, which closing
 * takes a `country_weights` entry while a jurisdiction with no data takes acquiring data.
 */
const droppedWithRows = withRows.filter((code) => !shippedFamilies.has(code))
const absent = sorted.filter((code) => !measured.has(code))
const rooftop = withRows.filter((code) => measured.get(code)?.geocodeTier === "rooftop-published")
const packaged = sorted.filter((code) => measured.get(code)?.weightsPackage)

/**
 * The admission list of a second config, when one is named: reading its count beside the
 * shipped one distinguishes what the next run would admit from what today's model was taught.
 */
const nextConfig = values["next-config"]
const nextAdmitted = nextConfig ? await readAdmittedCountries(nextConfig) : null
const newlyAdmitted = nextAdmitted ? sorted.filter((code) => nextAdmitted.has(code) && !shippedFamilies.has(code)) : []
/**
 * Jurisdictions a shipped graph admits that the second config does not; a code here
 * is a regression the config's author has to have intended.
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
**Admitted by** shows the shipped graph whose training config admits the jurisdiction. Admission is per
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
trains on no rows whatever the corpus holds. A code present in it with no corpus row trains on
no rows either, by the other route.

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
rows train no shipped model. This is the mechanism that left Norway untaught while its rows sat in
the corpus. A jurisdiction here that also carries a weights package is served by a data-only overlay
over a graph that was never taught it.

`
		: ""
}${
	nextConfig
		? `## Jurisdictions the second config would newly admit

${newlyAdmitted.length ? newlyAdmitted.map((code) => `\`${code}\``).join(" ") : "None."}

Admission is not teaching. Each of these trains on no rows until the corpus holds a row for it.

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

const out = values.out ?? repoRootPath("docs", "engineering", "reference", "jurisdiction-coverage.mdx")

await writeLocalTextFile(page, out)

console.log(`wrote ${out}`)
console.log(
	`  ${sorted.length} jurisdictions, ${withRows.length} with corpus rows, ${withStreetRows.length} with street rows`
)
console.log(
	`  ${admittedEmpty.length} admitted with no rows, ${notAdmitted.length} not admitted, ${absent.length} absent everywhere`
)
