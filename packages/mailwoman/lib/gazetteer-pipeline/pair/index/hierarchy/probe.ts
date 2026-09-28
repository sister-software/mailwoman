/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Probe builder — WOF-hierarchy generalization of the PIX1 placetype-pair index. Extracts per-country
 * (locality, region) pairs from the WOF admin DB's `ancestors` table and writes one PIX1 binary per
 * country to `$MAILWOMAN_DATA_ROOT/db/wof/pair-index-hierarchy-probe/`.
 *
 * Not a shipped-artifact build. Three safety properties keep an accidental wire-up inert: `delta: 0`,
 * a filename that does not match the loader's auto-wire pattern, and output under the data root
 * rather than any `neural-weights-*` workspace.
 *
 * Format is PIX1 verbatim, with extra header keys `edge`, `source` and `probeArtifact`; old readers
 * parse the header and never consult them.
 *
 * Extraction: `spr` rows with `placetype = 'locality'`, `is_current = 1` and `is_deprecated = 0`;
 * edges from `ancestors` with `ancestor_placetype` in the per-country parent set (US `region`; FR
 * `region` + `macroregion`); surfaces from `spr.name` ∪ official `names`; folded with
 * `normalizeFSTToken` on both sides under `foldVersion: 1`.
 *
 * Self-verifying: the written bytes are re-read through a fresh `PairIndexResolver` and known
 * per-country pairs are probed. The independent ground-truth sweep is `pair-index-hierarchy-verify.ts`.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { movePath, writeLocalFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { allRows } from "@mailwoman/core/utils"
import { normalizeFSTToken } from "@mailwoman/neural/fst-prior"
import {
	PairIndexResolver,
	serializePairIndex,
	type PairIndexEntry,
	type PairIndexHeaderInput,
} from "@mailwoman/neural/pair"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { basename, PathBuilder, resolvePath } from "path-ts"
import { TextSpliterator } from "spliterator"

/**
 * The argument tail both hierarchy runners share: the country list, lower-cased, and the admin DB they read.
 */
export function resolveHierarchyRunInputs(values: { countries?: string; db?: string }): {
	countries: string[]
	dbPath: string
} {
	return {
		countries: TextSpliterator.from(values.countries ?? "us,fr", { delimiter: "," })
			.map((c) => c.toLowerCase())
			.toArray(),
		dbPath: resolvePath(values.db ?? wofDatabasePath("admin-global-priority.db")),
	}
}

/**
 * The (locality, region) edge spec per country — ComponentTag space on the artifact side,
 * WOF placetype space on the extraction side.
 *
 * FR's `region` ComponentTag covers both WOF `region` (départements: "Ille-et-Vilaine")
 * and WOF `macroregion` (régions: "Bretagne").
 * Either surface is a region-tagged parent in a French address.
 */
export const EDGE_SPEC_BY_COUNTRY: Readonly<
	Record<string, { childWOFPlacetypes: string[]; parentWOFPlacetypes: string[] }>
> = {
	us: { childWOFPlacetypes: ["locality"], parentWOFPlacetypes: ["region"] },
	fr: { childWOFPlacetypes: ["locality"], parentWOFPlacetypes: ["region", "macroregion"] },
}

/**
 * Post-write self-check probes, per country.
 *
 * Raw surfaces folded through `normalizeFSTToken` at probe time, exactly like a decode-time caller would.
 */
const PROBE_PAIRS_BY_COUNTRY: Readonly<Record<string, ReadonlyArray<readonly [child: string, parent: string]>>> = {
	us: [
		["Springfield", "Illinois"],
		["Portland", "Oregon"],
		["Portland", "Maine"],
	],
	fr: [
		["Rennes", "Bretagne"],
		["Rennes", "Ille-et-Vilaine"],
		["Brest", "Finistère"],
	],
}

/**
 * The PIX1 header this probe writes: the shipped shape plus the absence-tolerant hierarchy extension keys.
 */
export interface HierarchyPairIndexHeader extends PairIndexHeaderInput {
	/**
	 * The hierarchy edge in ComponentTag space (child resolves to `edge.child` on a hit. Parent is context).
	 */
	edge: { child: "locality"; parent: "region" }
	/**
	 * WOF extraction provenance — enough to re-derive the artifact from the named DB.
	 */
	source: {
		kind: "wof-ancestors"
		db: string
		childWOFPlacetypes: string[]
		parentWOFPlacetypes: string[]
		namePolicy: "spr-name+official-names-v1"
	}
	/**
	 * True on every artifact this module writes: uncalibrated (delta 0), never for shipping as-is.
	 */
	probeArtifact: true
}

interface EdgeRow {
	child_id: number
	parent_id: number
}

interface SurfaceRow {
	id: number
	name: string
}

/**
 * Collect `id → Set<surface>` from spr names + official names for the given country/placetype set.
 */
function collectSurfaces(
	db: DatabaseClient<WOFDatabase>,
	country: string,
	placetypes: string[]
): Map<number, Set<string>> {
	const placeholder = placetypes.map(() => "?").join(",")
	const surfaces = new Map<number, Set<string>>()

	const sprRows = allRows<SurfaceRow>(
		db.prepare(
			`SELECT id, name FROM spr
			 WHERE country = ? AND placetype IN (${placeholder}) AND is_current = 1 AND is_deprecated = 0`
		),
		country,
		...placetypes
	)

	for (const row of sprRows) {
		surfaces.set(row.id, new Set([row.name]))
	}

	const officialRows = allRows<SurfaceRow>(
		db.prepare(
			`SELECT n.id, n.name FROM names n
			 JOIN spr s ON s.id = n.id
			 WHERE s.country = ? AND s.placetype IN (${placeholder})
			   AND s.is_current = 1 AND s.is_deprecated = 0 AND n.official = 1`
		),
		country,
		...placetypes
	)

	for (const row of officialRows) {
		surfaces.get(row.id)?.add(row.name)
	}

	return surfaces
}

async function main(): Promise<void> {
	const { values } = parseArguments({
		options: {
			countries: { type: "string", default: "us,fr" },
			db: { type: "string" },
			out: { type: "string" },
			"skip-source-md5": { type: "boolean", default: false },
		},
	})

	const { countries, dbPath } = resolveHierarchyRunInputs(values)
	const outDir = PathBuilder.from(values.out ?? wofDatabasePath("pair-index-hierarchy-probe"))

	if (!(await pathExists(dbPath))) {
		throw new Error(`pair-index-hierarchy-probe: WOF admin DB not found: ${dbPath}`)
	}

	await makeDirectories(outDir)

	// read-only on the admin DB.
	// This module must never write to it.
	using db = new DatabaseClient<WOFDatabase>(dbPath, { readOnly: true })

	const sourceMD5 = values["skip-source-md5"] ? "(skipped)" : await md5File(dbPath)

	for (const country of countries) {
		const spec = EDGE_SPEC_BY_COUNTRY[country]

		if (!spec) {
			throw new Error(
				`pair-index-hierarchy-probe: no edge spec for country "${country}" — add it to EDGE_SPEC_BY_COUNTRY`
			)
		}

		const wofCountry = country.toUpperCase()
		const childPlaceholder = spec.childWOFPlacetypes.map(() => "?").join(",")
		const parentPlaceholder = spec.parentWOFPlacetypes.map(() => "?").join(",")

		const edgeRows = allRows<EdgeRow>(
			db.prepare(
				`SELECT DISTINCT s.id AS child_id, a.ancestor_id AS parent_id
				 FROM spr s
				 JOIN ancestors a ON a.id = s.id AND a.ancestor_placetype IN (${parentPlaceholder}) AND a.ancestor_id != s.id
				 JOIN spr r ON r.id = a.ancestor_id AND r.is_current = 1 AND r.is_deprecated = 0
				 WHERE s.country = ? AND s.placetype IN (${childPlaceholder})
				   AND s.is_current = 1 AND s.is_deprecated = 0`
			),
			...spec.parentWOFPlacetypes,
			wofCountry,
			...spec.childWOFPlacetypes
		)

		// Phase 2: country-scoping the parent side is sound because every ancestor
		// of a US locality is itself US.
		// A parent outside the scope has no surfaces and its edge is skipped.
		const childSurfaces = collectSurfaces(db, wofCountry, spec.childWOFPlacetypes)
		const parentSurfaces = collectSurfaces(db, wofCountry, spec.parentWOFPlacetypes)

		// Phase 3: fold + dedupe into PIX1 entries; `tag` is the child's ComponentTag and
		// `parentTag` (PIX2 / schema 3) is the parent's, known from this spec rather than the row.
		const seen = new Map<string, PairIndexEntry>()
		let surfacePairs = 0
		let emptyChildFolds = 0

		for (const { child_id, parent_id } of edgeRows) {
			const childSet = childSurfaces.get(child_id)
			const parentSet = parentSurfaces.get(parent_id)

			if (!childSet || !parentSet) continue

			for (const childSurface of childSet) {
				for (const parentSurface of parentSet) {
					surfacePairs++

					const child = normalizeFSTToken(childSurface)
					const parent = normalizeFSTToken(parentSurface)

					if (!child) {
						emptyChildFolds++

						continue
					}

					// Length-prefixed key (mirrors pair-index-resolver.ts's pairKey): folded names
					// can contain spaces, so a plain delimiter could collide two distinct splits.
					const key = `${child.length}:${child}:${parent}`

					if (!seen.has(key)) {
						seen.set(key, { child, parent, tag: "locality", parentTag: "region" })
					}
				}
			}
		}

		const entries = [...seen.values()]

		const header: HierarchyPairIndexHeader = {
			country,
			// Uncalibrated probe — zero on purpose: even an accidentally-wired probe artifact biases no token.
			delta: 0,
			foldVersion: 1,
			sourceMD5s: [sourceMD5],
			buildDate: new Date().toISOString(),
			edge: { child: "locality", parent: "region" },
			source: {
				kind: "wof-ancestors",
				db: basename(dbPath),
				childWOFPlacetypes: spec.childWOFPlacetypes,
				parentWOFPlacetypes: spec.parentWOFPlacetypes,
				namePolicy: "spr-name+official-names-v1",
			},
			probeArtifact: true,
		}

		const bytes = serializePairIndex(header, entries)
		const outName = `pair-index-locality-region-${country}.bin`
		const outPath = outDir(outName)
		const tmpPath = outDir(`.tmp-${outName}`)

		// Temp-write + rename: the artifact is never observable half-written
		// (agents.md sealed-artifact discipline, applied to a flat binary).
		await writeLocalFile(bytes, tmpPath)
		await movePath(tmpPath, outPath)

		// Self-verifying readback over the written bytes (not the in-memory entries).
		const resolver = new PairIndexResolver(bytes)
		const probePairs = PROBE_PAIRS_BY_COUNTRY[country]

		if (!probePairs) {
			throw new Error(
				`pair-index-hierarchy-probe: no self-check probes for "${country}" — add a PROBE_PAIRS_BY_COUNTRY entry`
			)
		}

		console.log(`\n${outName} → ${outPath} (${bytes.length.toLocaleString()} bytes)`)
		console.log(
			`  ${country}: ${edgeRows.length.toLocaleString()} id-edges, ${surfacePairs.toLocaleString()} surface pairs, ` +
				`${entries.length.toLocaleString()} distinct folded pairs, ${emptyChildFolds} empty child folds`
		)
		console.log(`  header: delta=0 (probe), edge=locality→region, parents=[${spec.parentWOFPlacetypes.join(", ")}]`)

		for (const [child, parent] of probePairs) {
			const edge = resolver.probe(normalizeFSTToken(child), normalizeFSTToken(parent))

			console.log(
				edge
					? `  PROBE OK: ("${child}", "${parent}") → ${edge.tag} under ${edge.parentTag}`
					: `  PROBE MISS: ("${child}", "${parent}") → (no entry)`
			)
		}
	}
}

await runIfScript(import.meta, main)
