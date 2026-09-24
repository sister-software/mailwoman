/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Carry an overlay parquet onto the current row schema, without its recipe output.
 *
 *   A corpus is a base build plus overlay parquets. `v0.32.0-locality-shape` carries 723 slices: 690 from the
 *   `v0.5.0` base and 33 overlays accreted across 21 later builds. Some of those 33 have a recipe output on disk that
 *   can be regenerated, which is the first choice because a regenerated one carries the register its recipe declares.
 *   Several do not: `part-cz-pcfirst-v21.parquet` holds 51,037 rows and `part-fr-bare-street-v22.parquet` holds
 *   64,122, and neither generation's jsonl is anywhere on this machine. The parquet is the only copy.
 *
 *   This reads such a parquet and writes it back with `recipe`, `register`, `surface` and `base_source_id` in place
 *   of `synth_method` and `synth_base_id`, preserving every row. What it claims is bounded the same way
 *   `migrate-recipe-output.ts` bounds it: the two renames assert nothing new, the surface comes from the recipe that
 *   wrote the row, and the register is whatever {@linkcode OVERLAY_REGISTERS} records for that source — which is
 *   `mailwoman-derived-tuples` wherever the upstream was not recorded.
 */

import { openWriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { stringifyJSON } from "@mailwoman/core/json"
import { once } from "@mailwoman/core/utils/events"
import { join, type PathBuilderLike } from "path-ts"

import { openParquetRowStream } from "#parquet/streams"
import { SourceRegister } from "#registers"
import { jsonlToParquet } from "#tools/jsonl-to-parquet"
import { surfaceForSource } from "#tools/migrate/recipe-output"

/**
 * The register each overlay source's rows came from.
 *
 * A source whose recipe names its publication gets that publication.
 * A source whose rows came from a tuple extraction nobody recorded gets `mailwoman-derived-tuples`,
 * which says so rather than naming a publisher by inference.
 *
 * A source absent from this map refuses, for the same reason {@linkcode surfaceForSource} refuses.
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
	// `recipes/anchor-absorption.ts` declares `register: null, surface: invented`,
	// and this map recorded a register for it.
	// A row that names no published record cannot also name the publication it came from,
	// and the two tables disagreeing is what caught it.
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
 * The overlays written by the PyArrow original declared the span triple as `pa.list_(pa.int64())`,
 * and DuckDB returns an INT64 as a BigInt, which `stringifyJSON` refuses.
 * The current schema declares them INT32 (#519) because `raw` is a short address string,
 * so every value in one of these columns is inside the safe-integer range and `Number` is lossless.
 *
 * A value outside it would be a corrupt offset rather than a large one,
 * so this raises instead of truncating.
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
 * Rewrite one overlay parquet onto the current row schema.
 *
 * Staged through a temporary jsonl and {@linkcode jsonlToParquet}, so the output is written
 * by the same converter every other overlay goes through and carries the same column list.
 */
export async function migrateOverlayParquet(
	input: PathBuilderLike,
	output: PathBuilderLike
): Promise<OverlayMigrationSummary> {
	const summary: OverlayMigrationSummary = { rows: 0, bySource: {} }

	await using staging = await temporaryDirectory("mw-migrate-overlay-")
	const stagePath = join(staging.path, "rows.jsonl")
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
