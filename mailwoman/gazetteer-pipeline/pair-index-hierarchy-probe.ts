/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PROBE builder — WOF-hierarchy generalization of the PIX1 placetype-pair index (static-index
 *   survey candidate #3; design: `docs/superpowers/plans/2026-07-26-pair-index-hierarchy-design.md`).
 *   Extracts per-country (locality, region) pairs from the WOF admin DB's `ancestors` table and
 *   writes one PIX1 binary per country to `$MAILWOMAN_DATA_ROOT/wof/pair-index-hierarchy-probe/`.
 *
 *   Lives in the gazetteer pipeline (the sanctioned home for builders — scripts/AGENTS.md's closed
 *   drawer) but is NOT yet behind a `mailwoman gazetteer` command: it's a probe, runnable directly
 *   (`node mailwoman/gazetteer-pipeline/pair-index-hierarchy-probe.ts`) via `runIfScript` so plain
 *   import stays side-effect-free. Graduation path (design doc): fold into `gazetteer pair-index`
 *   behind an `--edge` mode once either consumer is green-lit.
 *
 *   NOT a shipped-artifact build. Three deliberate safety properties keep an accidental wire-up
 *   inert:
 *
 *   1. `delta: 0` — the soft-prior bias magnitude is zero, so even a loaded probe artifact biases
 *      nothing (the calibration task owns any real value).
 *   2. The filename (`pair-index-locality-region-<cc>.bin`) does NOT match the loader's auto-wire
 *      pattern (`pair-index-<cc>.bin` as a weights-package sibling).
 *   3. The output lives under the data root, not in any `neural-weights-*` workspace.
 *
 *   Format: PIX1 verbatim (`serializePairIndex` / `PairIndexResolver` — zero changes to `neural/`).
 *   The header rides the absence-tolerant JSON extension precedent set by `transitionBeta`
 *   (`schemaVersion` stays 1): extra keys `edge`, `source`, and `probeArtifact` describe the
 *   hierarchy edge in ComponentTag space, the WOF extraction provenance, and the uncalibrated-probe
 *   status. Old readers parse the header and never consult the extra keys.
 *
 *   Extraction policy (measured in the design doc):
 *
 *   - Child places: `spr` rows, `placetype = 'locality'`, `is_current = 1 AND is_deprecated = 0`.
 *   - Edges: the `ancestors` table, `ancestor_placetype` in the per-country parent set — US `region`;
 *     FR `region` + `macroregion` (both the département and the région are `region`-tagged surfaces in
 *     FR addresses; WOF splits them across two placetypes).
 *   - Surfaces (name policy `spr-name+official-names-v1`): `spr.name` ∪ `names` rows with
 *     `official = 1`, for child and parent alike. The official-name union is what makes the FR
 *     artifact carry "Bretagne" (official fra) alongside the spr default "Brittany" — the #936
 *     precedent (official-language names are name-exact evidence).
 *   - Fold: `normalizeFSTToken` (NFKC, lowercase, strip punctuation/symbols) on both sides — the
 *     same single-sourced fold the GB/NZ register artifacts and the decode-side probe use
 *     (`foldVersion: 1`).
 *
 *   Self-verifying (the sealed-artifact spirit): after the temp-write + rename, the bytes are
 *   re-read through a fresh `PairIndexResolver` and known per-country pairs are probed, printing
 *   `PROBE OK`/`PROBE MISS` receipts. The independent ground-truth sweep lives in
 *   `pair-index-hierarchy-verify.ts` — run it after this.
 *
 *   Run: `node mailwoman/gazetteer-pipeline/pair-index-hierarchy-probe.ts [--countries us,fr] [--db <path>] [--out <dir>] [--skip-source-md5]`
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { runIfScript } from "@mailwoman/core/scripting"
import { dataRootPath, md5File } from "@mailwoman/core/utils"
import { normalizeFSTToken } from "@mailwoman/neural/fst-prior"
import {
	PairIndexResolver,
	serializePairIndex,
	type PairIndexEntry,
	type PairIndexHeader,
} from "@mailwoman/neural/pair-index-resolver"

/**
 * The (locality, region) edge spec per country — ComponentTag space on the artifact side, WOF placetype space on the
 * extraction side. FR's `region` ComponentTag covers BOTH WOF `region` (départements: "Ille-et-Vilaine") and WOF
 * `macroregion` (régions: "Bretagne") — either surface is a region-tagged parent in a French address.
 */
export const EDGE_SPEC_BY_COUNTRY: Readonly<
	Record<string, { childWOFPlacetypes: string[]; parentWOFPlacetypes: string[] }>
> = {
	us: { childWOFPlacetypes: ["locality"], parentWOFPlacetypes: ["region"] },
	fr: { childWOFPlacetypes: ["locality"], parentWOFPlacetypes: ["region", "macroregion"] },
}

/**
 * Post-write self-check probes, PER COUNTRY (the pair-index.tsx lesson: probing another country's names against a fresh
 * index prints reassuring `PROBE MISS` lines that verify nothing). Raw surfaces — folded through `normalizeFSTToken` at
 * probe time, exactly like a decode-time caller would.
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

/** The PIX1 header this probe writes: the shipped shape plus the absence-tolerant hierarchy extension keys. */
export interface HierarchyPairIndexHeader extends PairIndexHeader {
	/** The hierarchy edge in ComponentTag space (child resolves to `edge.child` on a hit; parent is context). */
	edge: { child: "locality"; parent: "region" }
	/** WOF extraction provenance — enough to re-derive the artifact from the named DB. */
	source: {
		kind: "wof-ancestors"
		db: string
		childWOFPlacetypes: string[]
		parentWOFPlacetypes: string[]
		namePolicy: "spr-name+official-names-v1"
	}
	/** TRUE on every artifact this module writes: uncalibrated (delta 0), never for shipping as-is. */
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

/** Collect `id → Set<surface>` from spr names + official names for the given country/placetype set. */
function collectSurfaces(db: DatabaseSync, country: string, placetypes: string[]): Map<number, Set<string>> {
	const placeholder = placetypes.map(() => "?").join(",")
	const surfaces = new Map<number, Set<string>>()

	const sprRows = db
		.prepare(
			`SELECT id, name FROM spr
			 WHERE country = ? AND placetype IN (${placeholder}) AND is_current = 1 AND is_deprecated = 0`
		)
		.all(country, ...placetypes) as unknown as SurfaceRow[]

	for (const row of sprRows) {
		surfaces.set(row.id, new Set([row.name]))
	}

	const officialRows = db
		.prepare(
			`SELECT n.id, n.name FROM names n
			 JOIN spr s ON s.id = n.id
			 WHERE s.country = ? AND s.placetype IN (${placeholder})
			   AND s.is_current = 1 AND s.is_deprecated = 0 AND n.official = 1`
		)
		.all(country, ...placetypes) as unknown as SurfaceRow[]

	for (const row of officialRows) {
		surfaces.get(row.id)?.add(row.name)
	}

	return surfaces
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			countries: { type: "string", default: "us,fr" },
			db: { type: "string" },
			out: { type: "string" },
			"skip-source-md5": { type: "boolean", default: false },
		},
	})

	const countries = values.countries!.split(",").map((c) => c.trim().toLowerCase())
	const dbPath = values.db ?? dataRootPath("wof", "admin-global-priority.db")
	const outDir = values.out ?? dataRootPath("wof", "pair-index-hierarchy-probe")

	if (!existsSync(dbPath)) {
		throw new Error(`pair-index-hierarchy-probe: WOF admin DB not found: ${dbPath}`)
	}

	mkdirSync(outDir, { recursive: true })

	// READ-ONLY on the admin DB — this module must never write to it.
	const db = new DatabaseSync(dbPath, { readOnly: true })

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

		// Phase 1: id-level edges — child place under parent place, self-edges excluded, both endpoints
		// current + non-deprecated.
		const edgeRows = db
			.prepare(
				`SELECT DISTINCT s.id AS child_id, a.ancestor_id AS parent_id
				 FROM spr s
				 JOIN ancestors a ON a.id = s.id AND a.ancestor_placetype IN (${parentPlaceholder}) AND a.ancestor_id != s.id
				 JOIN spr r ON r.id = a.ancestor_id AND r.is_current = 1 AND r.is_deprecated = 0
				 WHERE s.country = ? AND s.placetype IN (${childPlaceholder})
				   AND s.is_current = 1 AND s.is_deprecated = 0`
			)
			.all(...spec.parentWOFPlacetypes, wofCountry, ...spec.childWOFPlacetypes) as unknown as EdgeRow[]

		// Phase 2: surfaces. Country-scoping the parent side is sound — every ancestor of a US locality
		// is itself US; a parent outside the scope would simply have no surfaces and the edge is skipped.
		const childSurfaces = collectSurfaces(db, wofCountry, spec.childWOFPlacetypes)
		const parentSurfaces = collectSurfaces(db, wofCountry, spec.parentWOFPlacetypes)

		// Phase 3: fold + dedupe into PIX1 entries. Tag = the CHILD's ComponentTag — what a decode hit
		// resolves the child span to (mirrors the GB register build, where every entry is the child tag).
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

					// Length-prefixed key (mirrors pair-index-resolver.ts's pairKey): folded names can
					// contain spaces, so a plain delimiter could collide two distinct splits.
					const key = `${child.length}:${child}:${parent}`

					if (!seen.has(key)) {
						seen.set(key, { child, parent, tag: "locality" })
					}
				}
			}
		}

		const entries = [...seen.values()]

		const header: HierarchyPairIndexHeader = {
			country,
			// Uncalibrated PROBE — zero on purpose: even an accidentally-wired probe artifact biases
			// nothing. The calibration task owns any real value (the pair-index.tsx `--delta` discipline).
			delta: 0,
			schemaVersion: 1,
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
		const outPath = join(outDir, outName)
		const tmpPath = join(outDir, `.tmp-${outName}`)

		// Temp-write + rename: the artifact is never observable half-written (AGENTS.md sealed-artifact
		// discipline, applied to a flat binary).
		writeFileSync(tmpPath, bytes)
		renameSync(tmpPath, outPath)

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
			const tag = resolver.probe(normalizeFSTToken(child), normalizeFSTToken(parent))

			console.log(
				tag ? `  PROBE OK: ("${child}", "${parent}") → ${tag}` : `  PROBE MISS: ("${child}", "${parent}") → (no entry)`
			)
		}
	}

	db.close()
}

await runIfScript(import.meta, main)
