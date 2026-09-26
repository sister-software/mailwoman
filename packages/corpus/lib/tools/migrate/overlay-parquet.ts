/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Carry an overlay parquet onto the current row schema, without its recipe output.
 *   `mailwoman-derived-tuples` wherever the upstream was not recorded.
 */

import { openWriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { stringifyJSON } from "@mailwoman/core/json"
import { once } from "@mailwoman/core/utils/events"
import type { PathBuilderLike } from "path-ts"

import { openParquetRowStream } from "#parquet/streams"
import { SourceRegister } from "#registers"
import { jsonlToParquet } from "#tools/jsonl-to-parquet"
import { surfaceForSource } from "#tools/migrate/recipe-output"

/**
 * The register each overlay source's rows came from, or `mailwoman-derived-tuples`
 * when the upstream was not recorded.
 */
export const OVERLAY_REGISTERS: Record<string, string | null> = {
	// The recipe names its publication.
	"synth-gb": SourceRegister.LandRegistryPricePaid,
	"synth-german": SourceRegister.OpenAddresses,
	"synth-nz": SourceRegister.OpenAddresses,
	"synth-es": SourceRegister.OpenAddresses,
	"synth-unit": SourceRegister.OpenAddresses,
	"synth-unit-v30": SourceRegister.OpenAddresses,
	"synth-country": SourceRegister.OpenAddresses,
	"synth-fr-order": SourceRegister.BaseAdresseNationale,
	"synth-fr-admin-split": SourceRegister.BaseAdresseNationale,
	"synth-fr-bare-street": SourceRegister.BaseAdresseNationale,
	"synth-fr-fragment": SourceRegister.BaseAdresseNationale,
	"synth-fr-lieudit": SourceRegister.BaseAdresseNationale,
	overture: SourceRegister.Overture,
	"overture-latam": SourceRegister.Overture,
	"synth-sg-register": SourceRegister.Overture,
	gnaf: SourceRegister.GNAF,
	osm: SourceRegister.OpenStreetMap,
	"synth-pk-register": SourceRegister.OpenStreetMap,
	"synth-bd-register": SourceRegister.OpenStreetMap,
	"synth-bare-country": SourceRegister.Codex,
	"synth-bare-postcode": SourceRegister.Codex,
	"synth-reviewed-postcode-tail": SourceRegister.ReviewedByHand,
	// The row names no published record at all.
	"synth-po-box-cedex": null,
	"synth-po-box-military": null,
	"synth-intersection": null,
	"synth-house-venue": null,
	"deepseek-kryptonite": null,
	"synth-anchor-absorption": null,
	// The tuple extraction behind these was not recorded.
	"synth-affix": SourceRegister.DerivedTuples,
	"synth-suffix-boundary": SourceRegister.DerivedTuples,
	"synth-cz-pcfirst-preposition": SourceRegister.DerivedTuples,
	"synth-cz-pcfirst-preposition-v21": SourceRegister.DerivedTuples,
	"synth-fr-bare-street-v22": SourceRegister.DerivedTuples,
	"synth-si-bare-village": SourceRegister.DerivedTuples,
	"synth-no-street-led": SourceRegister.DerivedTuples,
	"synth-no-fragment": SourceRegister.DerivedTuples,
	"synth-fragment": SourceRegister.DerivedTuples,
	"synth-nl-postcode": SourceRegister.DerivedTuples,
	"synth-sub-venue": SourceRegister.DerivedTuples,
	"synth-trailing-region": SourceRegister.DerivedTuples,
	"synth-trailing-region-us": SourceRegister.DerivedTuples,
	"synth-trailing-region-ca-bare": SourceRegister.DerivedTuples,
	"synth-trailing-region-structured": SourceRegister.DerivedTuples,
	"synth-trailing-region-es-v28": SourceRegister.DerivedTuples,
}

/**
 * Read an INT64 span offset back as a plain number.
 *
 * DuckDB returns an INT64 as a BigInt, which `stringifyJSON` refuses; the current schema declares the
 * span triple INT32 because `raw` is a short address string, so every in-range value is lossless.
 * A value outside the safe-integer range is a corrupt offset, so this raises instead of truncating.
 */
function narrowBigInts(row: Record<string, unknown>): Record<string, unknown> {
	const narrow = (value: unknown): unknown => {
		if (typeof value === "bigint") {
			if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
				throw new Error(`span offset ${value} is outside the safe-integer range, so it is a corrupt offset`)
			}

			return Number(value)
		}

		if (Array.isArray(value)) return value.map(narrow)

		return value
	}

	return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, narrow(value)]))
}

/**
 * What a parquet migration observed.
 */
export interface OverlayMigrationSummary {
	rows: number
	bySource: Record<string, number>
}

/**
 * The register for one overlay source, refusing a source this map does not name.
 */
export function registerForSource(source: string): string | null {
	if (!(source in OVERLAY_REGISTERS)) {
		throw new Error(
			`No register recorded for overlay source ${stringifyJSON(source)}. Read the recipe that writes it and ` +
				`add it to OVERLAY_REGISTERS: the publication it renders, or null when the row names no record, or ` +
				`mailwoman-derived-tuples when its tuple extraction was not recorded.`
		)
	}

	return OVERLAY_REGISTERS[source] ?? null
}

/**
 * Rewrite one overlay parquet onto the current row schema, staged through
 * {@linkcode jsonlToParquet} so it carries the same column list as every other overlay.
 */
export async function migrateOverlayParquet(
	input: PathBuilderLike,
	output: PathBuilderLike
): Promise<OverlayMigrationSummary> {
	const summary: OverlayMigrationSummary = { rows: 0, bySource: {} }

	await using staging = await temporaryDirectory("mw-migrate-overlay-")
	const stagePath = staging.path("rows.jsonl")
	const sink = staging.use(openWriteStream(stagePath, { encoding: "utf8" }))

	for await (const row of openParquetRowStream<Record<string, unknown>>(input)) {
		const { synth_method: recipe, synth_base_id: baseSourceID, ...rest } = narrowBigInts(row)
		const source = String(row["source"] ?? "")

		summary.rows++
		summary.bySource[source] = (summary.bySource[source] ?? 0) + 1

		const migrated = {
			...rest,
			recipe: recipe ?? null,
			base_source_id: baseSourceID ?? null,
			register: registerForSource(source),
			surface: surfaceForSource(source),
		}

		if (!sink.write(`${stringifyJSON(migrated)}\n`)) {
			await once(sink, "drain")
		}
	}

	sink.end()
	await once(sink, "finish")

	await jsonlToParquet({ input: stagePath, output })

	return summary
}
