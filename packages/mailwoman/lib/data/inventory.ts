/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Inventories databases in the data root and reports their provenance and symlink targets.
 */

import { pathExists, readLink, isSymbolicLink, statPath, type Dirent } from "@mailwoman/core/fs/readers"
import { tryParsingJSON } from "@mailwoman/core/json"
import type { layerschemadatabase } from "@mailwoman/core/layers/schema"
import { getRow } from "@mailwoman/core/utils"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"
import { basename, PathBuilder, type PathBuilderLike, relative, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * Whether an artifact can say how it was made.
 */
export const Provenance = {
	/**
	 * Carries a `layer_manifest` row — source, vintage, build command, build sha.
	 */
	Manifested: "manifested",
	/**
	 * A built artifact with no manifest.
	 *
	 * Rebuilding it requires knowing which command made it.
	 * A person may know that command even when the file does not record it.
	 */
	Unprovenanced: "unprovenanced",
	/**
	 * Not ours to reproduce — a third party's artifact we keep for comparison.
	 *
	 * Counting these as debt would make the number unimprovable and therefore useless.
	 */
	Foreign: "foreign",
	/**
	 * The file could not be opened as a database (locked, truncated, or not SQLite).
	 *
	 * Reported as its own state because "we could not look" is not "it has no manifest".
	 */
	Unreadable: "unreadable",
} as const

export type Provenance = (typeof Provenance)[keyof typeof Provenance]

/**
 * Directories whose contents belong to someone else, with the reason.
 *
 * Keyed on the first path segment under the data root.
 * Use a list instead of a heuristic.
 *
 * "Is this ours" is a fact about intent.
 * Guessing it from the filename is how a real gap gets excused as foreign.
 */
export const FOREIGN_ROOTS: Record<string, string> = {
	"pelias-rig": "a Pelias comparison rig — a third party's build, kept to measure against",
	"geocoder-tester": "the upstream geocoder-tester fixtures, not a mailwoman artifact",
}

/**
 * The `layer_manifest` columns worth reporting.
 *
 * `build_cmd` is the one that matters: it is the difference between an artifact
 * that documents its own reproduction and one that does not.
 */
export interface LayerManifest {
	name: string
	version: string
	tier: string
	/**
	 * The SPDX expression the build admitted.
	 * `refusalsForPublication` reads it beside `tier`.
	 *
	 * A row written before the column existed leaves it undefined.
	 * An absent expression is an unstated one rather than a permissive one.
	 */
	license?: string
	attribution?: string
	source: string
	source_vintage: string
	build_cmd: string
	build_sha: string
	created_at: string
	/**
	 * JSON object of publisher name to the record count that publisher supplied to the build.
	 *
	 * A row written before the column existed leaves it undefined.
	 * A build that recorded no count also leaves it undefined.
	 *
	 * The count is of the build's input rather than the rows the artifact kept.
	 * It cannot be recovered afterwards because Overture removes a release from
	 * its bucket once a newer one lands.
	 */
	source_records?: string
}

export interface InventoryEntry {
	/**
	 * Path relative to the data root, so a report is comparable across machines.
	 */
	path: string
	bytes: number
	provenance: Provenance
	/**
	 * Present only for {@link Provenance.Manifested}.
	 */
	manifest?: LayerManifest
	/**
	 * Where a symlink points, relative to the data root when it lands inside it.
	 *
	 * Absent for a real file.
	 */
	linkTarget?: string
	/**
	 * Why this entry is foreign or unreadable.
	 *
	 * Absent otherwise.
	 */
	note?: string
}

export interface InventoryReport {
	dataRoot: string
	entries: InventoryEntry[]
	counts: Record<Provenance, number>
	/**
	 * Databases that were found but not opened, because they sit under a foreign root.
	 *
	 * The name lets readers audit the report's denominator.
	 */
	skippedForeign: number
	/**
	 * The depth where the walk stopped and the directories it declined to enter.
	 *
	 * A report that silently bounded its own search would read as coverage.
	 */
	maxDepth: number
}

/**
 * Read a database's `layer_manifest`, or report why not.
 *
 * Opened read-only and closed immediately: every built database in this repo is sealed `0444`,
 * and a reader that opened one read-write would fail on exactly the artifacts it most needs to describe.
 */
export function probeManifest(path: PathBuilderLike): { manifest?: LayerManifest; error?: string } {
	let db: DatabaseClient<layerschemadatabase> | undefined

	try {
		db = new DatabaseClient<layerschemadatabase>(path, { readOnly: true })

		if (!tableExists(db, "layer_manifest")) return {}

		const row = getRow<LayerManifest>(db.prepare("SELECT * FROM layer_manifest LIMIT 1"))

		return row ? { manifest: row } : {}
	} catch (error) {
		return { error: (error as Error).message }
	} finally {
		db?.destroy()
	}
}

/**
 * Every `*.db` under `dataRoot`, to `maxDepth` path segments.
 *
 * Bounded because the data root holds source trees with millions of files (a WOF checkout is ~1.2 M GeoJSON),
 * and an unbounded walk would spend minutes in directories that contain no databases.
 * Foreign roots are not descended into at all.
 *
 * Counting each row and preserving its name costs less while recording the same fact.
 */
async function findDatabases(
	dataRoot: PathBuilder,
	maxDepth: number
): Promise<{ paths: string[]; skippedForeign: number }> {
	const paths: string[] = []
	let skippedForeign = 0

	const walk = async (dir: PathBuilder, depth: number): Promise<void> => {
		if (depth > maxDepth) return

		let entries: Dirent[]

		try {
			entries = await Globerator.from("*", { cwd: dir, withFileTypes: true, onlyFiles: false }).toArray()
		} catch {
			// An unreadable directory is not a finding about provenance.
			// Skip it rather than fail the report.
			return
		}

		for (const entry of entries) {
			const full = dir(entry.name)

			if (entry.isDirectory()) {
				if (depth === 0 && FOREIGN_ROOTS[entry.name]) {
					skippedForeign++

					continue
				}

				await walk(full, depth + 1)

				continue
			}

			if (entry.name.endsWith(".db")) {
				paths.push(full.toString())
			}
		}
	}

	await walk(dataRoot, 0)

	return { paths: paths.toSorted(), skippedForeign }
}

/**
 * Classify one database.
 *
 * Run `lstat` before `stat` for a symlinked artifact.
 * The report must include the link and the size of its target.
 *
 * `stat` alone answers only for the target; `lstat` alone answers only for the link.
 */
async function inventoryEntry(dataRoot: string, path: string): Promise<InventoryEntry> {
	const rel = relative(dataRoot, path)
	const segment = rel.split("/")[0] ?? ""

	const link = (await isSymbolicLink(path)) ? await readLink(path) : null
	const bytes = (await pathExists(path)) ? (await statPath(path)).size : 0

	const base: InventoryEntry = {
		path: rel,
		bytes,
		provenance: Provenance.Unprovenanced,
		...(link ? { linkTarget: relative(dataRoot, resolvePath(dataRoot, segment, link)) } : {}),
	}

	if (FOREIGN_ROOTS[segment]) {
		return { ...base, provenance: Provenance.Foreign, note: FOREIGN_ROOTS[segment] }
	}

	const { manifest, error } = probeManifest(path)

	if (error) return { ...base, provenance: Provenance.Unreadable, note: error }

	return manifest ? { ...base, provenance: Provenance.Manifested, manifest } : base
}

/**
 * Walk the data root and classify every database in it.
 */
export async function takeInventory(options: {
	dataRoot: PathBuilderLike
	maxDepth?: number
}): Promise<InventoryReport> {
	const root = PathBuilder.from(options.dataRoot)
	// The report records the root and each entry's path as strings.
	const dataRoot = root.toString()
	// A database sits three segments down, at `db/<layer>/<file>.db`, since the `db/` group added a level.
	// A bound of two stops the walk at `db/<layer>/`.
	// The report then describes a data root holding zero databases.
	const maxDepth = options.maxDepth ?? 3
	const { paths, skippedForeign } = await findDatabases(root, maxDepth)
	const entries = await Promise.all(paths.map((path) => inventoryEntry(dataRoot, path)))

	const counts: Record<Provenance, number> = {
		[Provenance.Manifested]: 0,
		[Provenance.Unprovenanced]: 0,
		[Provenance.Foreign]: 0,
		[Provenance.Unreadable]: 0,
	}

	for (const entry of entries) {
		counts[entry.provenance]++
	}

	return { dataRoot, entries, counts, skippedForeign, maxDepth }
}

/**
 * The one sentence a caller relays.
 *
 * The denominator excludes foreign and unreadable artifacts deliberately:
 * the number is meant to be improvable.
 * A rate that counts artifacts outside our provenance scope to provenance can
 * never reach 100% no matter what is fixed.
 */
export function inventorySentence(report: InventoryReport): string {
	const ours = report.counts.manifested + report.counts.unprovenanced
	const pct = ours === 0 ? 0 : Math.round((report.counts.manifested / ours) * 1000) / 10

	return (
		`${report.counts.manifested} of ${ours} mailwoman-built databases carry a layer_manifest (${pct}%)` +
		`${report.counts.foreign ? `; ${report.counts.foreign} foreign, not ours to reproduce` : ""}` +
		`${report.counts.unreadable ? `; ${report.counts.unreadable} could not be opened` : ""}` +
		`. Walked ${report.maxDepth} level(s) under the data root` +
		`${report.skippedForeign ? `, skipping ${report.skippedForeign} foreign root(s)` : ""}.`
	)
}

/**
 * Whether a recorded `build_cmd` names something that still exists in this repo.
 *
 * A manifest is only as useful as its build command.
 * Shipped artifacts showed two ways of being worthless were measured on the shipped artifacts.
 *
 * `osm/address-points-{de,gb,nz}-*.db` record `node osm/out/scripts/build-rooftop-database.js`,
 * a path the workspace regroup moved to `packages/osm/...`
 *
 * The literal survived the move inside a built database, where no lint can reach it.
 *
 * And `osm/address-points-au-au.db` records `node scratchpad/build-gnaf-rooftop-database.ts`,
 * which exists on the machine that built it and nowhere else, because `scratchpad/` is gitignored.
 *
 * Both artifacts pass every "has a manifest" check and neither can be rebuilt from what it says.
 * So presence of a manifest is not the property worth counting on its own.
 *
 * The check is deliberately shallow: any token that looks like a path
 * (contains `/` and no shell metacharacter) must resolve under the repo root.
 * A command with no such token — `mailwoman gazetteer build poi` — is treated as runnable,
 * because verifying a CLI verb means running the CLI.
 */
export async function buildCommandGaps(buildCmd: string, repoRoot: PathBuilderLike): Promise<string[]> {
	const root = PathBuilder.from(repoRoot)
	const gaps: string[] = []

	for (const token of buildCmd
		.split(/\s+/)
		.filter((candidate) => candidate.includes("/") && !/[$`|><*]/.test(candidate))) {
		if (!(await pathExists(root(token)))) {
			gaps.push(token)
		}
	}

	return gaps
}

/**
 * The command that would rebuild an artifact, or the reason none is known.
 */
/**
 * The terms a manifested artifact records, as one line for the text report.
 *
 * A manifest row written before the `license` column existed leaves it undefined.
 * This reports that state as unrecorded rather than as an absence of obligations.
 *
 * An artifact whose provenance is anything other than `Manifested` carries no `layer_manifest` row to read.
 * It returns `null` so the caller omits the line.
 */
export function licenseHint(entry: InventoryEntry): string | null {
	if (entry.provenance !== Provenance.Manifested) return null

	const manifest = entry.manifest!
	const license = manifest.license ?? "license unrecorded in layer_manifest"
	const attribution = manifest.attribution ? ` — attribution: ${manifest.attribution}` : ""

	return `${license}${attribution}`
}

/**
 * The input record counts a manifested artifact records, as one line for the text report.
 *
 * Returns `null` when the artifact records no count at all, so the caller omits
 * the line rather than printing a zero.
 * An artifact built before the `source_records` column exists is in that state.
 * So is an artifact whose build did not count its inputs.
 */
export function sourceRecordsHint(entry: InventoryEntry): string | null {
	if (entry.provenance !== Provenance.Manifested) return null

	const recorded = entry.manifest!.source_records

	if (!recorded) return null

	const counts = tryParsingJSON<Record<string, number>>(recorded)

	if (!counts) return `source_records is present and unreadable: ${recorded}`

	const entries = Object.entries(counts)

	if (!entries.length) return "the build counted its inputs and recorded no publisher"

	return entries
		.toSorted((left, right) => right[1] - left[1])
		.map(([publisher, rows]) => `${publisher} ${rows.toLocaleString()}`)
		.join(", ")
}

export function rebuildHint(entry: InventoryEntry): string {
	if (entry.provenance === Provenance.Manifested) return entry.manifest!.build_cmd

	if (entry.provenance === Provenance.Foreign) return `not ours — ${entry.note ?? "third-party artifact"}`

	if (entry.provenance === Provenance.Unreadable) return `could not open: ${entry.note ?? "unknown"}`

	return `no provenance — unreproducible from the artifact alone (${basename(entry.path)})`
}
