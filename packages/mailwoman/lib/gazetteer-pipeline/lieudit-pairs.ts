/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Hierarchy campaign R6 — FR (lieu-dit, commune) pairs from the raw BAN dump, emitted in the
 *   pair-index entry shape. The French instance of the dependent-locality prior.
 *
 *   Why BAN and not WOF, when the US instance (R5) took WOF: the source has to be whatever the
 *   POSTAL FORMAT carries. WOF's French neighbourhood records are Paris quartiers ("Des Halles",
 *   "Palais Royal") — cartographic subdivisions that never appear in a French postal address, since
 *   the arrondissement is encoded in the postcode (75001 = 1er). The line that DOES appear is the
 *   lieu-dit, written alone between the street and the commune (La Poste's line 5). Indexing
 *   quartiers would be technically valid and practically wrong: a prior pushing toward spans real
 *   addresses never contain.
 *
 *   Filtering is NOT reimplemented here. `@mailwoman/ban/sdk`'s `cleanLieuDit` already owns it
 *   (header leaks, placeholders, `ancienne commune` prefixes, and rows whose lieu-dit merely repeats
 *   the commune — 5.0% of filled values), and it is the same filter the `synth-fr-lieudit` training
 *   database reads through, so the index and the database agree on what a lieu-dit IS by construction.
 */

import { extractBANAddrPoints } from "@mailwoman/ban/sdk"
import { join } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * One lieu-dit pair in the pair-index entry shape. Raw surfaces — the caller applies the same `normalizeFSTToken` fold
 * as every other source, keeping one normalization owner.
 */
export interface LieuDitPair {
	child: string
	parent: string
	tag: "dependent_locality"
	/**
	 * Always `locality` (PIX2 / schema 3). The parent surface is BAN's `nom_commune` (`record.city` below) — the commune,
	 * which is the French postal locality line and the slot every FR address writes after the postcode. There is no
	 * per-row variation to read here: BAN carries exactly one commune column and every row's parent comes from it.
	 */
	parentTag: "locality"
}

/**
 * The commune column BAN gives as a pair's parent projects onto exactly one tag — see {@link LieuDitPair.parentTag}.
 */
const LIEU_DIT_PARENT_TAG = "locality" as const

export interface LieuDitExtractResult {
	pairs: LieuDitPair[]
	/**
	 * BAN rows carrying a lieu-dit that survived `cleanLieuDit` — the row mass behind the distinct pairs.
	 */
	rowsWithLieuDit: number
	/**
	 * Département files read.
	 */
	filesRead: number
}

/**
 * Enumerate `adresses-<dept>.csv[.gz]` files, one per département.
 *
 * Excludes the `merged`/`france` aggregates (they duplicate the per-département rows, so counting them would inflate
 * every frequency) and prefers an uncompressed `.csv` when both forms exist for the same département — a stale-refetch
 * artifact observed on disk for 13/2A/48/69/75. Mirrors `corpus/src/database-recipes/fr-lieudit.ts`'s enumeration; the
 * two must agree or the index and the training database would read different populations.
 */
export async function enumerateBANDeptFiles(banDir: string): Promise<string[]> {
	const byDept = new Map<string, string>()

	for await (const name of Globerator.from("*", { cwd: banDir, absolute: false })) {
		const match = /^adresses-(.+?)\.csv(\.gz)?$/.exec(name)

		if (!match) continue

		const dept = match[1]!

		if (dept === "merged" || dept === "france") continue

		const existing = byDept.get(dept)

		// Prefer the uncompressed form when both are present.
		if (!existing || (existing.endsWith(".gz") && !name.endsWith(".gz"))) {
			byDept.set(dept, name)
		}
	}

	return [...byDept.values()].toSorted().map((name) => join(banDir, name))
}

/**
 * Stream every département file and collect distinct (lieu-dit, commune) pairs.
 *
 * Reads the full national dump (~26M rows), so this is minutes, not seconds — the caller is a build command, never a
 * request path.
 */
export async function extractLieuDitPairs(banDir: string): Promise<LieuDitExtractResult> {
	const files = await enumerateBANDeptFiles(banDir)

	if (!files.length) {
		throw new Error(`extractLieuDitPairs: no adresses-<dept>.csv files under ${banDir} — fetch BAN first.`)
	}

	const seen = new Set<string>()
	const pairs: LieuDitPair[] = []
	let rowsWithLieuDit = 0

	for (const file of files) {
		for await (const record of extractBANAddrPoints(file)) {
			const child = record.lieuDit
			const parent = record.city

			if (!child || !parent) continue

			rowsWithLieuDit++

			const key = `${child}\0${parent}`

			if (seen.has(key)) continue

			seen.add(key)
			pairs.push({ child, parent, tag: "dependent_locality", parentTag: LIEU_DIT_PARENT_TAG })
		}
	}

	return { pairs, rowsWithLieuDit, filesRead: files.length }
}
