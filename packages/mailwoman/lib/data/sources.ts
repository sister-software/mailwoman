/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Census a downloaded bundle's own publisher stamps, so the terms recorded in `data/bundles.ts` can be checked
 *   against the bytes an operator holds.
 *
 *   The `us` bundle's record named the Census Bureau and OpenAddresses, and a census of its 52 shipped databases found
 *   68.2% of 125,276,536 rows stamped `overture:NAD`, the National Address Database, which the record named nowhere.
 *   Its open question asked which OpenAddresses source supplied each state's rows and said a per-state answer needed a
 *   list the bundle did not carry. Every row carried it.
 *
 *   That is the failure this reader exists for. Prose about publishers is written once and the artifacts are rebuilt,
 *   so the two drift with nothing to notice. Running this against a downloaded copy reports what the rows say rather
 *   than what the record says about them, and the difference is the finding.
 *
 *   A bundle whose artifacts carry no publisher column reports `none-recorded-in-the-artifacts` rather than an empty
 *   census. An artifact that is not on disk is reported as absent rather than contributing zero rows, because a
 *   partial download that counted as zero would read as a publisher with no rows.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { bundleArtifactPath, type BundleSourceCensus, type DataBundle, resolveBundleArtifacts } from "#data/bundles"
import { readReleaseManifest } from "#data/release"

/**
 * The two shapes a bundle's artifacts carry a publisher stamp in, as one schema.
 *
 * It names both tables `BundleSourceCensus.table` can hold rather than describing
 * one artifact, so the table a record names is a member of `keyof CensusSchema`
 * and Kysely checks the query without a cast.
 * Only the stamp column is declared on each: this reader selects that column and a count,
 * and a column it never reads would be a claim about a schema nobody checks.
 *
 * An artifact shape added to the union in `BundleSourceCensus` is a compile error here
 * until it is added here too, which is the point of the union.
 */
interface CensusSchema {
	address_point: { source: string }
	layer_manifest: { source: string }
}

/**
 * One publisher stamp and how many rows carry it.
 */
interface SourceTally {
	source: string
	rows: number
}

/**
 * What a census of one bundle found.
 */
export interface BundleSourceCensusResult {
	bundle: string
	/**
	 * Absent when the bundle declares no {@link BundleSourceCensus}, which says its
	 * artifacts carry no publisher column rather than that a census found nothing.
	 */
	status: "censused" | "none-recorded-in-the-artifacts" | "nothing-on-disk"
	/**
	 * Artifacts read, and artifacts the data root does not hold.
	 *
	 * A census over part of a bundle is reported as partial rather than presented as the bundle's composition.
	 */
	artifactsRead: number
	artifactsAbsent: number
	/**
	 * Artifacts the census's declared family excludes.
	 *
	 * They are outside what this census covers rather than missing from it,
	 * so they neither reduce the share denominator nor read as a failure.
	 */
	artifactsOutOfScope: number
	tallies: SourceTally[]
	totalRows: number
	/**
	 * What could not be read, one message per artifact.
	 *
	 * An artifact present but unreadable is named here rather than being counted as absent,
	 * since the two mean different things to somebody checking a download.
	 */
	problems: string[]
}

/**
 * The stamps in one artifact, or a message saying why it could not be read.
 *
 * A `layer_manifest` carries one row, so its `count(*)` is 1 and the tally reports one manifest row
 * rather than a row count. {@link BundleSourceCensus.shape} is what tells a caller which it is holding.
 */
async function tallyArtifact(
	path: string,
	census: BundleSourceCensus
): Promise<{ tallies: SourceTally[] } | { problem: string }> {
	try {
		using database = new DatabaseClient<CensusSchema>(path, { readOnly: true })

		const rows = await database
			.selectFrom(census.table)
			.select(({ fn }) => [census.column, fn.countAll<number>().as("rows")])
			.groupBy(census.column)
			.execute()

		return {
			tallies: rows.map((row) => ({ source: row.source ?? "unstamped", rows: Number(row.rows) })),
		}
	} catch (error) {
		return { problem: `${path}: ${error instanceof Error ? error.message : String(error)}` }
	}
}

/**
 * Census one bundle against the copy in `dataRoot`.
 *
 * The artifact paths come from {@link resolveBundleArtifacts} with the release manifest
 * applied, so a versioned per-state database is read where `resolveDatabasePath`
 * would find it rather than at its unversioned fallback.
 */
export async function censusBundleSources(bundle: DataBundle, dataRoot: string): Promise<BundleSourceCensusResult> {
	const census = bundle.sourceCensus

	if (!census) {
		return {
			bundle: bundle.name,
			status: "none-recorded-in-the-artifacts",
			artifactsRead: 0,
			artifactsAbsent: 0,
			artifactsOutOfScope: 0,
			tallies: [],
			totalRows: 0,
			problems: [],
		}
	}

	const manifest = await readReleaseManifest(dataRoot)
	const totals = new Map<string, number>()
	const problems: string[] = []
	let artifactsRead = 0
	let artifactsAbsent = 0
	let artifactsOutOfScope = 0

	for (const artifact of resolveBundleArtifacts(bundle, manifest)) {
		if (census.family && artifact.family !== census.family) {
			artifactsOutOfScope += 1

			continue
		}

		const path = bundleArtifactPath(dataRoot, artifact)

		if (!(await pathExists(path))) {
			artifactsAbsent += 1

			continue
		}

		const result = await tallyArtifact(path, census)

		if ("problem" in result) {
			problems.push(result.problem)

			continue
		}

		artifactsRead += 1

		for (const tally of result.tallies) {
			totals.set(tally.source, (totals.get(tally.source) ?? 0) + tally.rows)
		}
	}

	const tallies = [...totals.entries()]
		.map(([source, rows]) => ({ source, rows }))
		.toSorted((left, right) => right.rows - left.rows || left.source.localeCompare(right.source))

	return {
		bundle: bundle.name,
		status: artifactsRead ? "censused" : "nothing-on-disk",
		artifactsRead,
		artifactsAbsent,
		artifactsOutOfScope,
		tallies,
		totalRows: tallies.reduce((total, tally) => total + tally.rows, 0),
		problems,
	}
}

/**
 * One census as lines for a terminal.
 *
 * A share is printed only beside a census that read every artifact of its bundle.
 * A percentage over part of a bundle describes the part rather than the bundle,
 * and the two are easy to confuse once the number is on the page.
 */
export function renderSourceCensus(result: BundleSourceCensusResult, recordedPublishers: readonly string[]): string[] {
	const lines: string[] = [`${result.bundle}:`]

	if (result.status === "none-recorded-in-the-artifacts") {
		lines.push(
			"  This bundle's artifacts carry no publisher column, so there is nothing here to check the record against.",
			`  The record names: ${recordedPublishers.join("; ")}`
		)

		return lines
	}

	if (result.status === "nothing-on-disk") {
		lines.push(
			`  None of this bundle's ${result.artifactsAbsent} artifacts is in the data root, so nothing was read.`,
			"  Run `mailwoman data pull` first. This reports on your copy rather than on the published one."
		)

		return lines
	}

	const complete = result.artifactsAbsent === 0

	const scope = complete
		? `${result.artifactsRead} artifacts, ${result.totalRows.toLocaleString()} rows`
		: `${result.artifactsRead} of ${result.artifactsRead + result.artifactsAbsent} artifacts, ${result.totalRows.toLocaleString()} rows — a partial copy, so the shares below are withheld`

	lines.push(`  ${scope}`)

	if (result.artifactsOutOfScope) {
		lines.push(
			`  ${result.artifactsOutOfScope} artifacts of this bundle carry no publisher column and are outside this census.`
		)
	}

	for (const tally of result.tallies) {
		const share = complete ? ` ${((tally.rows / result.totalRows) * 100).toFixed(1)}%` : ""

		lines.push(`    ${tally.rows.toLocaleString().padStart(13)}${share.padStart(7)}  ${tally.source}`)
	}

	lines.push(`  The record names: ${recordedPublishers.join("; ")}`)

	for (const problem of result.problems) {
		lines.push(`  Could not read ${problem}`)
	}

	return lines
}
