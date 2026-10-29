/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads one OpenStreetMap address extract (`osm-<cc>-<yymmdd>.corpus.jsonl`, written by
 *   `@mailwoman/osm`'s `emit-corpus-jsonl`) into evaluation rows, and reads the lineage its build left beside
 *   it: the stats sidecar and the PBF receipt it names.
 *
 *   Each row is rendered exactly as the `osm` corpus adapter renders a training row: the adapter's own
 *   `componentsForOSMRow`, the codex formatter, and the adapter's `stableSourceID` over the rendered
 *   components. A suite row therefore holds the `source_id` a training row of the same address holds.
 *   The overlap audit matches on that identity. The mapped OpenStreetMap tags stay on the row under `mapped`, apart
 *   from the components derived from them.
 *
 *   The extract is parsed with one sequential `JSONSpliterator.fromAsync` per file, the primitive the parse
 *   cost calls for, and its lines are counted with the raw `AsyncSpliterator.count` scan.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { sha256File } from "@mailwoman/core/hash"
import { componentsForOSMRow, OSM_ADAPTER_ID } from "@mailwoman/corpus/adapters/osm/adapter"
import { stableSourceID } from "@mailwoman/corpus/adapters/source-id"
import { alignRow } from "@mailwoman/corpus/utils/align"
import { basename } from "path-ts"
import { AsyncSpliterator, JSONSpliterator } from "spliterator"

import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"

/**
 * The tags `emit-corpus-jsonl` writes per address, as mapped from OpenStreetMap.
 */
export interface OSMExtractRecord {
	street?: string | null
	number?: string | null
	postcode?: string | null
	suburb?: string | null
	city?: string | null
	unit?: string | null
	place?: string | null
	subdistrict?: string | null
	district?: string | null
	province?: string | null
	country?: string | null
	boundary_locality?: string | null
	boundary_dependent_locality?: string | null
	lat?: number
	lon?: number
}

/**
 * One evaluation row: the held-out row a grader parses, and the OpenStreetMap tags it was rendered from.
 */
export interface OSMSuiteRow extends HeldoutRow {
	/**
	 * The mapped tags, unchanged from the extract.
	 */
	mapped: Omit<OSMExtractRecord, "lat" | "lon">
}

/**
 * Why a record yields no row, counted per reason.
 */
export type OSMExtractTally = Record<string, number>

/**
 * The country an extract file holds, from its `osm-<cc>-<yymmdd>.corpus.jsonl` name, or `null`.
 *
 * The name is the only place `emit-corpus-jsonl` records the country, and its rows omit it.
 */
export function extractCountryOf(path: string): string | null {
	return /^osm-([a-z]{2})-\d{6}\.corpus\.jsonl$/u.exec(basename(path))?.[1]?.toUpperCase() ?? null
}

/**
 * Render one extract record as the `osm` adapter renders it, or return `null` with the reason counted.
 */
export function renderOSMExtractRecord(
	record: OSMExtractRecord,
	country: string,
	tally: OSMExtractTally
): OSMSuiteRow | null {
	const count = (reason: string) => {
		tally[reason] = (tally[reason] ?? 0) + 1
	}

	const tagged = record.country?.trim().toUpperCase()

	// The adapter refuses a record whose own `addr:country` names another country.
	if (tagged && tagged !== country) {
		count("row:country-tag-mismatch")

		return null
	}

	const dropped = new Map<string, number>()
	const components = componentsForOSMRow(record, country, { dropped })

	if (!components) {
		for (const [reason, n] of dropped) {
			tally[reason] = (tally[reason] ?? 0) + n
		}

		return null
	}

	const rendered = formatAddressRow(components, country, { singleLine: true })

	if (!rendered) {
		count("row:render-failed")

		return null
	}

	const sourceID = stableSourceID(OSM_ADAPTER_ID, rendered.components)

	const aligned = alignRow({
		raw: rendered.raw,
		components: rendered.components,
		country,
		source: OSM_ADAPTER_ID,
		source_id: sourceID,
		license: "ODbL-1.0",
	})

	if (aligned.kind !== "labeled") {
		count(`row:align-${aligned.row.reason}`)

		return null
	}

	const { lat: _lat, lon: _lon, ...mapped } = record
	const { span_starts: starts, span_ends: ends, span_tags: tags } = aligned.row

	// A labeled row always holds its span triple.
	// A row without one is a fault of the aligner.
	if (!starts || !ends || !tags) throw new Error(`the aligner labeled ${sourceID} without its span triple`)

	return {
		raw: aligned.row.raw,
		span_starts: [...starts],
		span_ends: [...ends],
		span_tags: [...tags],
		country,
		source: OSM_ADAPTER_ID,
		source_id: sourceID,
		// The adapter's ids hold no `#`, so a row is its own record and group.
		group: sourceID,
		mapped,
	}
}

/**
 * Every row of one extract file, rendered, in file order.
 *
 * @throws When the file name states no country.
 */
export async function* readOSMExtractRows(path: string, tally: OSMExtractTally): AsyncGenerator<OSMSuiteRow> {
	const country = extractCountryOf(path)

	if (!country) throw new Error(`${path} is not named osm-<cc>-<yymmdd>.corpus.jsonl, so its country is unknown`)

	for await (const record of JSONSpliterator.fromAsync<OSMExtractRecord>(path)) {
		tally["read"] = (tally["read"] ?? 0) + 1

		const row = renderOSMExtractRecord(record, country, tally)

		if (row) {
			yield row
		}
	}
}

/**
 * The number of lines in an extract, by the raw delimiter scan, without parsing a row.
 */
export function countExtractLines(path: string): Promise<number> {
	return AsyncSpliterator.count(path, { delimiter: "\n" })
}

/**
 * The lineage an extract's build recorded: its own digest, the PBF it read
 * and that PBF's digest, and the extraction parameters its stats sidecar states.
 */
export interface OSMExtractLineage {
	extract: { path: string; sha256: string; lines: number }
	/**
	 * The PBF the stats sidecar names and the digest its receipt records, or `null`
	 * when the sidecar names none.
	 */
	pbf: { path: string; sourceURL: string; sha256: string; lastModified: string | null } | null
	/**
	 * The sidecar's extraction parameters: outline, excluded outlines, locality levels.
	 */
	extraction: {
		statsPath: string
		statsSHA256: string
		outline: string | null
		outlineSHA256: string | null
		excludedOutlines: readonly string[]
		localityLevels: readonly unknown[]
		dependentLocalityLevels: readonly unknown[]
	}
}

interface ExtractStats {
	pbf?: string
	receipt?: string
	outline?: string | null
	outline_receipt?: string | null
	excluded_outlines?: string[]
	locality_levels?: unknown[]
	dependent_locality_levels?: unknown[]
}

/**
 * Read an extract's lineage from its `.stats.json` sidecar and the receipts the sidecar names.
 *
 * Reads only.
 * A sidecar or receipt the build listed and that cannot be read throws with its path,
 * because a suite without its source's digest records no lineage.
 *
 * @throws When the sidecar is missing, or lists a receipt that is missing or records no SHA-256.
 */
export async function readExtractLineage(path: string): Promise<OSMExtractLineage> {
	const statsPath = `${path}.stats.json`

	if (!(await pathExists(statsPath))) throw new Error(`${path} has no stats sidecar at ${statsPath}`)

	const stats = await readLocalJSONFile<ExtractStats>(statsPath)
	let pbf: OSMExtractLineage["pbf"] = null

	if (stats.pbf) {
		if (!stats.receipt) throw new Error(`${statsPath} names the PBF ${stats.pbf} and no receipt for it`)

		const receipt = await readLocalJSONFile<{ source_url?: string; sha256?: string; last_modified?: string | null }>(
			stats.receipt
		)

		if (!receipt.sha256 || !receipt.source_url) {
			throw new Error(`${stats.receipt} records no sha256 or source_url for ${stats.pbf}`)
		}

		pbf = {
			path: stats.pbf,
			sourceURL: receipt.source_url,
			sha256: receipt.sha256,
			lastModified: receipt.last_modified ?? null,
		}
	}

	let outlineSHA256: string | null = null

	if (stats.outline_receipt) {
		outlineSHA256 = (await readLocalJSONFile<{ sha256?: string }>(stats.outline_receipt)).sha256 ?? null
	}

	return {
		extract: { path, sha256: await sha256File(path), lines: await countExtractLines(path) },
		pbf,
		extraction: {
			statsPath,
			statsSHA256: await sha256File(statsPath),
			outline: stats.outline ?? null,
			outlineSHA256,
			excludedOutlines: stats.excluded_outlines ?? [],
			localityLevels: stats.locality_levels ?? [],
			dependentLocalityLevels: stats.dependent_locality_levels ?? [],
		},
	}
}
