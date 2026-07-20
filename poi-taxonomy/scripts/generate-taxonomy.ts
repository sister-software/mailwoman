/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generator for `data/taxonomy.json` — merges the FULL Overture Places category taxonomy snapshot
 *   with mailwoman's hand-maintained curated overlay. Two committed inputs, one committed output;
 *   the merge is a PURE, deterministic function so a regenerate against the same inputs is
 *   byte-identical (the {@link buildTaxonomyTable} → {@link serializeTaxonomyTable} pair is what the
 *   determinism test in `lookup.test.ts` exercises).
 *
 *   ── Provenance (the `overture-categories.csv` snapshot) ──────────────────────────────────────────
 *   Source : https://raw.githubusercontent.com/OvertureMaps/schema/main/docs/schema/concepts/by-theme/places/overture_categories.csv
 *   Schema : OvertureMaps/schema v1.17.0 (latest release 2026-05-19); CSV last-modified commit
 *            ac891b7f22486a6c96c1f6232461e7193263b184
 *   Fetched: 2026-07-20 (row count 2117 category rows, excluding the header)
 *   Format : semicolon-delimited, BOM-prefixed — `<category code>; [<hierarchy,path,leaf>]`, where the
 *            path's LAST element is always the code itself (asserted at parse time).
 *   The old Overture `categories` PROPERTY on the Places feature is retired in Overture's Sept 2026
 *   release; this snapshot is the NEW `taxonomy` property's category vocabulary, pinned as committed
 *   data so the runtime never reaches the network. See `data/PROVENANCE.md`.
 *
 *   ── Merge rules ─────────────────────────────────────────────────────────────────────────────────
 *   • Curated records (the 23 in `curated-overlay.json`) are preserved verbatim and WIN id collisions
 *     with the snapshot (a curated `bank`/`school`/`cafe` keeps its curated hierarchy, `osmTag`, and
 *     `overtureCategories` — the snapshot's same-id row is dropped).
 *   • Overture leaves a curated record already ABSORBS via its `overtureCategories` (e.g. `coffee_shop`
 *     → `cafe`, `grocery_store` → `supermarket`, `hiking_trail` → `trail`) are NOT emitted as
 *     standalone snapshot records. Those leaves belong to their curated canonical id — emitting them
 *     twice would let a snapshot id-phrase (`coffee shop`) shadow the curated synonym (`coffee shop` →
 *     `cafe`) in the phrase index, which the POI board depends on NOT happening. The db still stores
 *     the raw leaves; `resolveOvertureCategories` fans the curated id back out to them.
 *   • Every other snapshot row becomes an identity Overture record (id = code, humanized label,
 *     hierarchy path retained, `basicLabel: null`, no `osmTag`, no `overtureCategories`).
 *   • Deterministic order: categories by id, synonyms by (phrase, categoryID) — `localeCompare`, the
 *     same tie-break discipline as `build-brands.ts`.
 *
 *   Run: `node poi-taxonomy/scripts/generate-taxonomy.ts && npx oxfmt poi-taxonomy/data/taxonomy.json`
 *   (reads the committed CSV; the oxfmt pass is the repo law — committed JSON is oxfmt-clean, which raw
 *   `JSON.stringify` can't reproduce). Pass `--fetch` to refresh the CSV snapshot from the source URL
 *   above first (records nothing new about provenance automatically — update this header +
 *   `PROVENANCE.md` by hand when you do). The generator itself is byte-deterministic; oxfmt is too, so
 *   the committed artifact is reproducible, and the merge's data is content-identical to a fresh run
 *   (asserted by `lookup.test.ts`).
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

import type { CategoryRecord, POICategoryID, POITaxonomyTable, SynonymEntry } from "../types.ts"

/** The Overture schema release the committed `overture-categories.csv` snapshot was taken from. */
export const OVERTURE_RELEASE = "v1.17.0"

/** This taxonomy table's own data version — bump when the snapshot vintage or merge semantics change. */
export const TAXONOMY_VERSION = "0.2.0"

/** Source URL for `--fetch` and provenance. */
export const OVERTURE_CATEGORIES_URL =
	"https://raw.githubusercontent.com/OvertureMaps/schema/main/docs/schema/concepts/by-theme/places/overture_categories.csv"

/** One parsed Overture snapshot row: a category code plus its top-down hierarchy path (ending with the code). */
export interface OvertureSnapshotRow {
	code: string
	path: string[]
}

/** The hand-maintained curated overlay — the shape of `data/curated-overlay.json`. */
export interface CuratedOverlay {
	categories: CategoryRecord[]
	synonyms: SynonymEntry[]
}

/**
 * Parse the Overture categories CSV. Strips a leading BOM, skips the header row, and splits each `code; [a,b,c]` line.
 * A handful of Overture rows (4 as of the v1.17.0 snapshot — `aircraft_repair`, `ev_charging_station`,
 * `custom_t_shirt_store`, `community_services_non_profits`) carry a display path whose LEAF label differs from the
 * category code the db actually stores; for those the code is APPENDED as the true leaf so the invariant `lookup.ts`'s
 * integrity test relies on (`hierarchy.at(-1) === id`) holds while the display ancestry is preserved. Throws only on a
 * structurally broken row (no code / empty path) or a repeated code.
 */
export function parseOvertureCSV(csvText: string): OvertureSnapshotRow[] {
	const lines = csvText.replace(/^﻿/, "").split(/\r?\n/)
	const rows: OvertureSnapshotRow[] = []
	const seen = new Set<string>()

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!.trim()

		if (!line) continue

		const semi = line.indexOf(";")

		if (semi === -1) throw new Error(`generate-taxonomy: malformed CSV row ${i + 1}: ${JSON.stringify(line)}`)

		const code = line.slice(0, semi).trim()
		const pathText = line
			.slice(semi + 1)
			.trim()
			.replace(/^\[|\]$/g, "")
		const path = pathText.split(",").map((p) => p.trim())

		if (!code || path.length === 0 || path.some((p) => !p)) {
			throw new Error(
				`generate-taxonomy: malformed CSV row ${i + 1}: code ${JSON.stringify(code)} path ${JSON.stringify(pathText)}`
			)
		}

		if (seen.has(code)) throw new Error(`generate-taxonomy: duplicate Overture code ${JSON.stringify(code)}`)

		// Normalize the leaf to the category code — the db stores the code, and `hierarchy.at(-1) === id` must hold.
		if (path.at(-1) !== code) {
			path.push(code)
		}

		seen.add(code)
		rows.push({ code, path })
	}

	return rows
}

/** Sentence-case a snake_case code into a display label: `afghan_restaurant` → `Afghan restaurant`. */
export function humanizeCode(code: string): string {
	const spaced = code.replaceAll("_", " ")

	return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Merge the Overture snapshot with the curated overlay into a {@link POITaxonomyTable}. Pure — no I/O — so the
 * determinism test can serialize it twice and the merge is unit-testable against fixtures. See the module header for
 * the merge rules.
 */
export function buildTaxonomyTable(snapshot: OvertureSnapshotRow[], overlay: CuratedOverlay): POITaxonomyTable {
	const curatedIDs = new Set<string>(overlay.categories.map((c) => c.id))
	const absorbedLeaves = new Set<string>(overlay.categories.flatMap((c) => c.overtureCategories ?? []))

	const snapshotRecords: CategoryRecord[] = snapshot
		.filter((row) => !curatedIDs.has(row.code) && !absorbedLeaves.has(row.code))
		.map((row) => ({
			id: row.code as POICategoryID,
			label: humanizeCode(row.code),
			hierarchy: row.path as POICategoryID[],
			basicLabel: null,
			source: "overture",
		}))

	const categories = [...overlay.categories, ...snapshotRecords].sort((a, b) => a.id.localeCompare(b.id))
	const synonyms = [...overlay.synonyms].sort(
		(a, b) => a.phrase.localeCompare(b.phrase) || a.categoryID.localeCompare(b.categoryID)
	)

	return { version: TAXONOMY_VERSION, overtureRelease: OVERTURE_RELEASE, categories, synonyms }
}

/** Stable serialization — tab-indented, trailing newline. Matches `build-brands.ts`'s `serializeBrandTable`. */
export function serializeTaxonomyTable(table: POITaxonomyTable): string {
	return `${JSON.stringify(table, null, "\t")}\n`
}

/**
 * Committed input/output paths, resolved off this module's own directory. This is a DEV generator — run from source
 * (`node poi-taxonomy/scripts/generate-taxonomy.ts`) and imported from source by the tests — so `import.meta.dirname`
 * is always `poi-taxonomy/scripts/` and `../data` is the package's data directory. It is never run from `out/`, so the
 * source-vs-compiled path skew `build-brands.ts` guards against with `repoRootPath` doesn't apply here (and pulling in
 * `@mailwoman/core` would add an undeclared dependency to this zero-runtime-dep package).
 */
export function taxonomyPaths() {
	const dataDir = resolve(import.meta.dirname, "../data")

	return {
		csv: resolve(dataDir, "overture-categories.csv"),
		overlay: resolve(dataDir, "curated-overlay.json"),
		out: resolve(dataDir, "taxonomy.json"),
	}
}

/** Read the committed CSV + overlay, merge, and return the table (no write). */
export function generateTaxonomyTable(): POITaxonomyTable {
	const paths = taxonomyPaths()
	const snapshot = parseOvertureCSV(readFileSync(paths.csv, "utf8"))
	const overlay = JSON.parse(readFileSync(paths.overlay, "utf8")) as CuratedOverlay

	return buildTaxonomyTable(snapshot, overlay)
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { fetch: { type: "boolean", default: false } } })
	const paths = taxonomyPaths()

	if (values.fetch) {
		const res = await fetch(OVERTURE_CATEGORIES_URL)

		if (!res.ok) throw new Error(`generate-taxonomy: fetch ${OVERTURE_CATEGORIES_URL} → HTTP ${res.status}`)

		writeFileSync(paths.csv, await res.text())
		console.log(`fetched snapshot → ${paths.csv}`)
	}

	const table = generateTaxonomyTable()

	writeFileSync(paths.out, serializeTaxonomyTable(table))
	console.log(
		`wrote ${paths.out}: ${table.categories.length} categories (${table.synonyms.length} synonyms), Overture ${table.overtureRelease}`
	)
}

// Run only as the entry script — importing this module (tests) stays side-effect-free.
if (import.meta.main) {
	await main()
}
