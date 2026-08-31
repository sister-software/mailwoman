/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What is in the data root, and for each artifact whether it can say how it was built.
 *
 *   Phase 1 of the lab-reproducibility sequence (`docs/superpowers/specs/2026-08-17-lab-reproducibility-
 *   strategy.md`). The contract it reports against already exists — `layer_manifest` / `layer_coverage`,
 *   specified in `docs/engineering/reference/layer-contract.mdx` — and the finding that prompted this is
 *   that it is implemented on a minority of the built databases. The gap is an unfinished rollout, not a
 *   missing design, which is why the answer is a scoreboard rather than a new mechanism.
 *
 *   DATABASES ARE THE UNIT, because `layer_manifest` is a table: provenance lives inside SQLite artifacts
 *   and nowhere else, so a walk that reported every file would count parquet shards and tiles it could
 *   never classify. The report says what it did not look at rather than implying coverage it lacks.
 *
 *   IT DOES NOT SIZE THE ROOT. `du` over ~744 GB takes minutes and answers a different question — disk
 *   pressure, not reproducibility. Sizes here come from `stat` on each database, which is free.
 *
 *   A SYMLINK IS A DECISION. `candidate.db` is a symlink to one of about ten candidate builds, and which
 *   one is live is expressed in that link and nowhere else. Reporting the target makes a real choice
 *   visible instead of leaving it as a filesystem detail.
 */

import {
	pathExists,
	readDirectoryEntries,
	readLink,
	isSymbolicLink,
	statPath,
	type Dirent,
} from "@mailwoman/core/fs/readers"
import type { LayerContractDatabase } from "@mailwoman/core/layers/schema"
import { getRow } from "@mailwoman/core/utils"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { basename, join, relative } from "path-ts"

/**
 * Whether an artifact can say how it was made.
 */
export const Provenance = {
	/**
	 * Carries a `layer_manifest` row — source, vintage, build command, build sha.
	 */
	Manifested: "manifested",
	/**
	 * A built artifact with no manifest. Rebuilding it means knowing which command made it, which is knowledge held by a
	 * person rather than by the file.
	 */
	Unprovenanced: "unprovenanced",
	/**
	 * Not ours to reproduce — a third party's artifact we keep for comparison. Counting these as debt would make the
	 * number unimprovable and therefore useless.
	 */
	Foreign: "foreign",
	/**
	 * The file could not be opened as a database (locked, truncated, or not SQLite). Reported as its own state because
	 * "we could not look" is not "it has no manifest".
	 */
	Unreadable: "unreadable",
} as const

export type Provenance = (typeof Provenance)[keyof typeof Provenance]

/**
 * Directories whose contents belong to someone else, with the reason.
 *
 * Keyed on the first path segment under the data root. A list rather than a heuristic: "is this ours" is a fact about
 * intent, and guessing it from the filename is how a real gap gets excused as foreign.
 */
export const FOREIGN_ROOTS: Record<string, string> = {
	"pelias-rig": "a Pelias comparison rig — a third party's build, kept to measure against",
	"geocoder-tester": "the upstream geocoder-tester fixtures, not a mailwoman artifact",
}

/**
 * The `layer_manifest` columns worth reporting. `build_cmd` is the one that matters: it is the difference between an
 * artifact that documents its own reproduction and one that does not.
 */
export interface LayerManifest {
	name: string
	version: string
	tier: string
	source: string
	source_vintage: string
	build_cmd: string
	build_sha: string
	created_at: string
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
	 * Where a symlink points, relative to the data root when it lands inside it. Absent for a real file.
	 */
	linkTarget?: string
	/**
	 * Why this entry is foreign or unreadable. Absent otherwise.
	 */
	note?: string
}

export interface InventoryReport {
	dataRoot: string
	entries: InventoryEntry[]
	counts: Record<Provenance, number>
	/**
	 * Databases that were found but NOT opened, because they sit under a foreign root. Named so the report's denominator
	 * is auditable rather than implied.
	 */
	skippedForeign: number
	/**
	 * The depth the walk stopped at, and the directories it declined to descend into. A report that silently bounded its
	 * own search would read as coverage.
	 */
	maxDepth: number
}

/**
 * Read a database's `layer_manifest`, or report why not.
 *
 * Opened read-only and closed immediately: every built database in this repo is sealed `0444`, and a reader that opened
 * one read-write would fail on exactly the artifacts it most needs to describe.
 */
export function probeManifest(path: string): { manifest?: LayerManifest; error?: string } {
	let db: DatabaseClient<LayerContractDatabase> | undefined

	try {
		db = new DatabaseClient<LayerContractDatabase>(path, { readOnly: true })

		const present = db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'layer_manifest' LIMIT 1")
			.get()

		if (!present) return {}

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
 * Bounded because the data root holds source trees with millions of files (a WOF checkout is ~1.2 M GeoJSON), and an
 * unbounded walk would spend minutes in directories that contain no databases. Foreign roots are not descended into at
 * all — they are counted and named, which is cheaper and states the same fact.
 */
async function findDatabases(dataRoot: string, maxDepth: number): Promise<{ paths: string[]; skippedForeign: number }> {
	const paths: string[] = []
	let skippedForeign = 0

	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > maxDepth) return

		let entries: Dirent[]

		try {
			entries = await readDirectoryEntries(dir)
		} catch {
			// An unreadable directory is not a finding about provenance; skip it rather than fail the report.
			return
		}

		for (const entry of entries) {
			const full = join(dir, entry.name)

			if (entry.isDirectory()) {
				if (depth === 0 && FOREIGN_ROOTS[entry.name]) {
					skippedForeign++

					continue
				}

				await walk(full, depth + 1)

				continue
			}

			if (entry.name.endsWith(".db")) {
				paths.push(full)
			}
		}
	}

	await walk(dataRoot, 0)

	return { paths: paths.toSorted(), skippedForeign }
}

/**
 * Classify one database.
 *
 * `lstat` before `stat`: a symlinked artifact must report BOTH the link and the size of what it points at, and `stat`
 * alone silently answers for the target while `lstat` alone silently answers for the link.
 */
async function inventoryEntry(dataRoot: string, path: string): Promise<InventoryEntry> {
	const rel = relative(dataRoot, path)
	const segment = rel.split("/")[0] ?? ""
	const link = (await isSymbolicLink(path)) ? await readLink(path) : undefined
	const bytes = (await pathExists(path)) ? (await statPath(path)).size : 0

	const base: InventoryEntry = {
		path: rel,
		bytes,
		provenance: Provenance.Unprovenanced,
		...(link ? { linkTarget: relative(dataRoot, link.startsWith("/") ? link : join(dataRoot, segment, link)) } : {}),
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
export async function takeInventory(options: { dataRoot: string; maxDepth?: number }): Promise<InventoryReport> {
	const maxDepth = options.maxDepth ?? 2
	const { paths, skippedForeign } = await findDatabases(options.dataRoot, maxDepth)
	const entries = await Promise.all(paths.map((path) => inventoryEntry(options.dataRoot, path)))

	const counts: Record<Provenance, number> = {
		[Provenance.Manifested]: 0,
		[Provenance.Unprovenanced]: 0,
		[Provenance.Foreign]: 0,
		[Provenance.Unreadable]: 0,
	}

	for (const entry of entries) {
		counts[entry.provenance]++
	}

	return { dataRoot: options.dataRoot, entries, counts, skippedForeign, maxDepth }
}

/**
 * The one sentence a caller relays.
 *
 * The denominator excludes foreign and unreadable artifacts deliberately: the number is meant to be improvable, and a
 * rate that counts artifacts nobody intends to provenance can never reach 100% no matter what is fixed.
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
 * Whether a recorded `build_cmd` names something that still exists in THIS repo.
 *
 * A manifest is only worth as much as its build command, and two ways of being worthless were measured on the shipped
 * artifacts. `osm/address-points-{de,gb,nz}-*.db` record `node osm/out/scripts/build-rooftop-shard.js`, a path the
 * workspace regroup moved to `packages/osm/...` — the literal survived the move inside a built database, where no lint
 * can reach it. And `osm/address-points-au-au.db` records `node scratchpad/build-gnaf-rooftop-shard.ts`, which exists
 * on the machine that built it and nowhere else, because `scratchpad/` is gitignored.
 *
 * Both artifacts pass every "has a manifest" check and neither can be rebuilt from what it says. So presence of a
 * manifest is not the property worth counting on its own.
 *
 * The check is deliberately shallow: any token that looks like a path (contains `/` and no shell metacharacter) must
 * resolve under the repo root. A command with no such token — `mailwoman gazetteer build poi` — is treated as runnable,
 * because verifying a CLI verb means running the CLI.
 */
export async function buildCommandGaps(buildCmd: string, repoRoot: string): Promise<string[]> {
	const gaps: string[] = []

	for (const token of buildCmd
		.split(/\s+/)
		.filter((candidate) => candidate.includes("/") && !/[$`|><*]/.test(candidate))) {
		if (!(await pathExists(join(repoRoot, token)))) {
			gaps.push(token)
		}
	}

	return gaps
}

/**
 * The command that would rebuild an artifact, or the reason none is known.
 */
export function rebuildHint(entry: InventoryEntry): string {
	if (entry.provenance === Provenance.Manifested) return entry.manifest!.build_cmd

	if (entry.provenance === Provenance.Foreign) return `not ours — ${entry.note ?? "third-party artifact"}`

	if (entry.provenance === Provenance.Unreadable) return `could not open: ${entry.note ?? "unknown"}`

	return `no provenance — unreproducible from the artifact alone (${basename(entry.path)})`
}
