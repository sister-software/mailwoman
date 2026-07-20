/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The POI brand lexicon builder — part 1 of 2 (part 2 wires `lookupPOIBrand` into the runtime
 *   pipeline; no pipeline wiring here). Reads a BUILT `poi.db` (Overture Places, the `poi` table
 *   `build-poi.ts` materializes) READ-ONLY via `node:sqlite` and aggregates its `(brand_wikidata,
 *   name)` pairs into a `@mailwoman/poi-taxonomy` brand table: one row per Wikidata QID, its
 *   most-frequently observed name plus alias spellings that clear a noise floor.
 *
 *   The output (`poi-taxonomy/data/brands.json`) is COMMITTED — a rebuild against the same `poi.db`
 *   must be byte-identical. Every ordering decision in {@linkcode aggregateBrands} is an explicit,
 *   deterministic tie-break (rows desc → QID asc for brands; count desc → name asc for the modal
 *   pick; alphabetical for aliases), never left to SQL row order or `Map` iteration order.
 *
 *   Two phases, split the way `build-poi.ts` splits ingest from materialize, so the aggregation
 *   logic is unit-testable WITHOUT touching sqlite:
 *
 *   1. {@linkcode readBrandNameCounts} / {@linkcode readSourceLayer} — `node:sqlite`, read-only,
 *        the exact `GROUP BY brand_wikidata, name` aggregate plus the source layer's manifest
 *        identity.
 *   2. {@linkcode aggregateBrands} — a PURE function over an `Iterable<BrandNameCount>` (real rows
 *        OR an injected test fixture) — mirrors `build-poi.ts`'s injected-`rows` testability seam
 *        (`POISourceRow`) and `chooseCategoryColumn`'s pure-function-over-decoded-rows pattern.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readLayerManifest, type LayerContractDatabase } from "@mailwoman/core/layers"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"
import type { BrandRecord, POIBrandSourceLayer, POIBrandTable } from "@mailwoman/poi-taxonomy"

/** `--min-rows` default — keeps the table to real chains, not one-off name collisions (~low-thousands of entries). */
export const DEFAULT_MIN_ROWS = 25

/**
 * `--dominance` default — a QID's modal name must cover at least this fraction of its total rows to qualify. Below the
 * floor, the QID is systematically mistagged (many unrelated chains sharing one Wikidata QID, e.g. Q4835981's "CVS"
 * over ~20 unrelated chains) rather than one real chain with noisy alias spellings — dropped entirely, not just demoted
 * out of the alias list the way sub-noise-floor variants are.
 */
export const DEFAULT_DOMINANCE = 0.5

/**
 * The brand TABLE's own schema/data version — bump when the shape or matching semantics change. Independent of
 * {@link POIBrandSourceLayer.version}, which tracks the source `poi.db`'s own layer-manifest version.
 */
export const BRAND_TABLE_VERSION = "0.2.0"

/** Default `poi.db` read location — same default `build/poi.tsx`'s command uses for its `--out`. */
export function defaultPOIDatabasePath(): string {
	return dataRootPath("poi", "poi.db")
}

/**
 * Default commit location: `poi-taxonomy/data/brands.json`. Resolved via `repoRootPath` (source-vs-compiled-tree-aware
 * — see `core/utils/repo.ts`) rather than a hand-rolled relative path off `import.meta.dirname`: this module's
 * directory depth relative to the repo root DIFFERS between source (`mailwoman/gazetteer-pipeline/poi/`) and compiled
 * (`mailwoman/out/gazetteer-pipeline/poi/`) trees, so a fixed `../../../` would resolve to the wrong package under
 * `yarn compile`'s output.
 */
export function defaultBrandTableOutPath(): string {
	return repoRootPath("poi-taxonomy", "data", "brands.json")
}

/** One `(brand_wikidata, name)` group from `poi` — the injected-iterator testability seam (mirrors `POISourceRow`). */
export interface BrandNameCount {
	wikidata: string
	name: string
	n: number
}

/**
 * Reads the exact aggregate the design calls for: `SELECT brand_wikidata, name, COUNT(*) n FROM poi WHERE
 * brand_wikidata IS NOT NULL AND name IS NOT NULL GROUP BY brand_wikidata, name`. Opens `dbPath` READ-ONLY — this
 * builder only ever reads a sealed `poi.db`, never writes one.
 */
export function readBrandNameCounts(dbPath: string): BrandNameCount[] {
	const db = new DatabaseSync(dbPath, { readOnly: true })

	try {
		return db
			.prepare(
				`SELECT brand_wikidata AS wikidata, name, COUNT(*) AS n
				 FROM poi
				 WHERE brand_wikidata IS NOT NULL AND name IS NOT NULL
				 GROUP BY brand_wikidata, name`
			)
			.all() as unknown as BrandNameCount[]
	} finally {
		db.close()
	}
}

/** Reads `dbPath`'s layer manifest and narrows it to what {@link POIBrandSourceLayer} needs. */
export async function readSourceLayer(dbPath: string): Promise<POIBrandSourceLayer> {
	const raw = new DatabaseSync(dbPath, { readOnly: true })
	const kdb = new DatabaseClient<LayerContractDatabase>({ database: raw })

	try {
		const manifest = await readLayerManifest(kdb)

		return { name: manifest.name, version: manifest.version, sourceVintage: manifest.sourceVintage }
	} finally {
		await kdb.destroy()
	}
}

/**
 * {@link aggregateBrands}'s pre-branded output — a plain-string `wikidata`, cast to `BrandRecord["wikidata"]` by the
 * caller.
 */
interface RawBrandAggregate {
	wikidata: string
	name: string
	aliases: string[]
	rows: number
}

/**
 * PURE aggregation core — no sqlite in this function, so it's unit-testable directly against a fixture. Per QID: `rows`
 * is the sum of every observed `(wikidata, name)` count; `name` is the MODAL (highest-count) variant, ties broken
 * alphabetically; `aliases` are every OTHER variant clearing the noise floor `max(3, 1% of rows)` (guards against
 * typo/OCR-noise variants swelling the alias list), sorted alphabetically. QIDs whose total falls under `minRows` are
 * dropped entirely. QIDs whose modal name covers LESS than `dominance` of the total (default {@link DEFAULT_DOMINANCE}
 * = 0.5) are ALSO dropped entirely — a modal share under the floor means the QID is systematically mistagged across
 * many unrelated names, not one real chain with noisy spelling variants, so no single name/alias split is trustworthy.
 * The final list is sorted by `rows` descending, ties broken by QID.
 *
 * The two explicit tie-breaks (alphabetical for name/alias ties, QID for brand-total ties) are what make a rebuild
 * against the same db byte-identical — determinism never depends on SQL row order or `Map` iteration order here.
 */
export function aggregateBrands(
	rows: Iterable<BrandNameCount>,
	minRows: number = DEFAULT_MIN_ROWS,
	dominance: number = DEFAULT_DOMINANCE
): RawBrandAggregate[] {
	const byBrand = new Map<string, Map<string, number>>()

	for (const row of rows) {
		let variants = byBrand.get(row.wikidata)

		if (!variants) {
			variants = new Map()
			byBrand.set(row.wikidata, variants)
		}

		variants.set(row.name, (variants.get(row.name) ?? 0) + row.n)
	}

	const brands: RawBrandAggregate[] = []

	for (const [wikidata, variants] of byBrand) {
		const total = [...variants.values()].reduce((sum, n) => sum + n, 0)

		if (total < minRows) continue

		const sortedVariants = [...variants.entries()].sort(
			([nameA, nA], [nameB, nB]) => nB - nA || nameA.localeCompare(nameB)
		)
		const modalName = sortedVariants[0]![0]
		const modalCount = sortedVariants[0]![1]

		if (modalCount / total < dominance) continue

		const noiseFloor = Math.max(3, total * 0.01)
		const aliases = sortedVariants
			.slice(1)
			.filter(([, n]) => n >= noiseFloor)
			.map(([name]) => name)
			.sort((a, b) => a.localeCompare(b))

		brands.push({ wikidata, name: modalName, aliases, rows: total })
	}

	brands.sort((a, b) => b.rows - a.rows || a.wikidata.localeCompare(b.wikidata))

	return brands
}

export interface BuildBrandTableOptions {
	/**
	 * A built `poi.db` to read. Ignored when `rows` is given. Required (along with `sourceLayer`, or it's read from here
	 * too) unless `rows` is given.
	 */
	dbPath?: string
	/** Injected row source — the testability seam. When given, `node:sqlite` is never touched. */
	rows?: Iterable<BrandNameCount>
	/**
	 * Injected source-layer identity — bypasses reading `dbPath`'s layer manifest. Required when `rows` is given without
	 * `dbPath`.
	 */
	sourceLayer?: POIBrandSourceLayer
	minRows?: number
	/** Dominance floor — see {@link aggregateBrands}. Defaults to {@link DEFAULT_DOMINANCE}. */
	dominance?: number
	/** The brand table's own `version` field. Defaults to {@link BRAND_TABLE_VERSION}. */
	version?: string
}

/**
 * Builds a {@link POIBrandTable} in memory: read (or take injected) rows → {@link aggregateBrands} → wrap with the source
 * layer's manifest identity. Does not write anything — see {@link writeBrandTable}.
 */
export async function buildBrandTable(opts: BuildBrandTableOptions = {}): Promise<POIBrandTable> {
	if (!opts.rows && !opts.dbPath) {
		throw new Error("buildBrandTable: pass either `rows` (test/injected source) or `dbPath` (a built poi.db)")
	}

	if (!opts.sourceLayer && !opts.dbPath) {
		throw new Error("buildBrandTable: pass either `sourceLayer` (test/injected source) or `dbPath` (a built poi.db)")
	}

	const rows = opts.rows ?? readBrandNameCounts(opts.dbPath!)
	const sourceLayer = opts.sourceLayer ?? (await readSourceLayer(opts.dbPath!))
	const brands: BrandRecord[] = aggregateBrands(
		rows,
		opts.minRows ?? DEFAULT_MIN_ROWS,
		opts.dominance ?? DEFAULT_DOMINANCE
	).map((b) => ({
		wikidata: b.wikidata as BrandRecord["wikidata"],
		name: b.name,
		aliases: b.aliases,
		rows: b.rows,
	}))

	return { version: opts.version ?? BRAND_TABLE_VERSION, sourceLayer, brands }
}

/** Stable, deterministic serialization — tab-indented (matches `taxonomy.json`), trailing newline. */
export function serializeBrandTable(table: POIBrandTable): string {
	return `${JSON.stringify(table, null, "\t")}\n`
}

/** Writes `table` to `out` (creating parent directories as needed) via {@link serializeBrandTable}. */
export function writeBrandTable(table: POIBrandTable, out: string): void {
	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, serializeBrandTable(table))
}
