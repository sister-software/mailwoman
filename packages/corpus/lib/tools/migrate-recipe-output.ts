/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Carry a recipe output written before `recipe`/`register`/`surface` onto the current row schema.
 *
 *   Regenerating a recipe output is the first choice, because a regenerated one records its own invocation. This
 *   exists for the outputs that cannot be regenerated: their `--input` tuple extraction is no longer on disk, and
 *   nothing recorded where it came from. `corpus/tuples/` holds the extraction for some of them and not others.
 *
 *   What this writes is what is known, and nothing more.
 *
 *   `recipe` and `base_source_id` are renames of `synth_method` and `synth_base_id`. No new claim.
 *
 *   `surface` is a property of the recipe that wrote the row, stated in that recipe's source and repeated in
 *   {@linkcode RECIPE_SURFACES}. A recipe that assembles a row from template tables writes `invented`, and one that
 *   renders a real record's fields writes `composed`.
 *
 *   `register` is `mailwoman-derived-tuples` for every row this tool writes, which says the rows came from a derived
 *   extract in this repository and that which publication stands behind it has to be re-established. Naming a
 *   publisher here would be inference recorded as a fact, which is what `requireRegister` refuses at generation time.
 *   A migrated output therefore carries a weaker claim than a regenerated one, and it says so on every row.
 */

import { openWriteStream } from "@mailwoman/core/fs/streams"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { once } from "@mailwoman/core/utils/events"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { SourceRegister } from "#registers"
import { SurfaceOrigin } from "#types"

/**
 * How each source id's recipe produced its surface.
 *
 * Keyed on the `source` column, which is what a migrated row carries.
 * Each value is read from the recipe that writes that source, so this table and the recipes state
 * one thing in two places and a source absent from it refuses rather than taking a default.
 */
export const RECIPE_SURFACES: Record<string, SurfaceOrigin> = {
	// Assembled from template tables.
	// No register asserts the address exists.
	"synth-intersection": SurfaceOrigin.Invented,
	"synth-po-box-cedex": SurfaceOrigin.Invented,
	"synth-house-venue": SurfaceOrigin.Invented,
	"deepseek-kryptonite": SurfaceOrigin.Invented,
	// A real record's fields, written in an order the recipe chose.
	"synth-affix": SurfaceOrigin.Composed,
	"synth-fr-order": SurfaceOrigin.Composed,
	"synth-fr-bare-street": SurfaceOrigin.Composed,
	"synth-fr-lieudit": SurfaceOrigin.Composed,
	"synth-suffix-boundary": SurfaceOrigin.Composed,
	"synth-unit": SurfaceOrigin.Composed,
	"synth-unit-v30": SurfaceOrigin.Composed,
	"synth-trailing-region": SurfaceOrigin.Composed,
	"synth-trailing-region-us": SurfaceOrigin.Composed,
	"synth-trailing-region-structured": SurfaceOrigin.Composed,
	"synth-trailing-region-ca-bare": SurfaceOrigin.Composed,
	"synth-trailing-region-es-v28": SurfaceOrigin.Composed,
	"synth-cz-pcfirst-preposition": SurfaceOrigin.Composed,
	"synth-cz-pcfirst-preposition-v21": SurfaceOrigin.Composed,
	"synth-fr-bare-street-v22": SurfaceOrigin.Composed,
	"synth-si-bare-village": SurfaceOrigin.Composed,
	"synth-no-street-led": SurfaceOrigin.Composed,
	"synth-no-fragment": SurfaceOrigin.Composed,
	"synth-fr-fragment": SurfaceOrigin.Composed,
	"synth-fragment": SurfaceOrigin.Composed,
	"synth-fr-admin-split": SurfaceOrigin.Composed,
	"synth-nl-postcode": SurfaceOrigin.Composed,
	"synth-sub-venue": SurfaceOrigin.Composed,
	"synth-german": SurfaceOrigin.Composed,
	"synth-nz": SurfaceOrigin.Composed,
	"synth-es": SurfaceOrigin.Composed,
	"synth-gb": SurfaceOrigin.Composed,
	"synth-sg-register": SurfaceOrigin.Composed,
	"synth-pk-register": SurfaceOrigin.Composed,
	"synth-bd-register": SurfaceOrigin.Composed,
	"synth-reviewed-postcode-tail": SurfaceOrigin.Composed,
	// The publisher's own string, carried through by an adapter rather than a recipe.
	overture: SurfaceOrigin.Attested,
	"overture-latam": SurfaceOrigin.Attested,
	gnaf: SurfaceOrigin.Attested,
	osm: SurfaceOrigin.Attested,
	// Written from this repository's own tables, which publish the string verbatim.
	"synth-bare-country": SurfaceOrigin.Attested,
	"synth-bare-postcode": SurfaceOrigin.Attested,
	// Drawn rather than read: the box number, the anchor and the venue are the recipe's.
	"synth-po-box-military": SurfaceOrigin.Invented,
	"synth-anchor-absorption": SurfaceOrigin.Invented,
}

/**
 * What a migration pass observed.
 */
export interface MigrationSummary {
	rows: number
	bySource: Record<string, number>
	alreadyMigrated: number
}

/**
 * The surface for one source id, refusing a source the table does not name.
 *
 * A default here would write a guess onto every row of an output nobody has classified,
 * which is the failure the three columns replaced.
 */
export function surfaceForSource(source: string): SurfaceOrigin {
	const surface = RECIPE_SURFACES[source]

	if (!surface) {
		throw new Error(
			`No surface recorded for source ${stringifyJSON(source)}. Read the recipe that writes it, ` +
				`add it to RECIPE_SURFACES, and say there whether it renders a real record or assembles one.`
		)
	}

	return surface
}

/**
 * Rewrite one recipe output onto the current row schema.
 *
 * A row that already carries `surface` passes through untouched and is counted,
 * so a half-migrated file converges rather than being rewritten twice.
 */
export async function migrateRecipeOutput(input: PathBuilderLike, output: PathBuilderLike): Promise<MigrationSummary> {
	const summary: MigrationSummary = { rows: 0, bySource: {}, alreadyMigrated: 0 }
	const sink = openWriteStream(output, { encoding: "utf8" })

	for await (const rawLine of TextSpliterator.fromAsync(String(input))) {
		const line = rawLine.trim()

		if (!line) continue

		const row = parseJSONStrict<Record<string, unknown>>(line)

		summary.rows++

		const source = String(row["source"] ?? "")
		summary.bySource[source] = (summary.bySource[source] ?? 0) + 1

		if (row["surface"]) {
			summary.alreadyMigrated++

			if (!sink.write(`${line}\n`)) {
				await once(sink, "drain")
			}

			continue
		}

		const { synth_method: recipe, synth_base_id: baseSourceID, ...rest } = row

		const migrated = {
			...rest,
			recipe: recipe ?? null,
			base_source_id: baseSourceID ?? null,
			register: SourceRegister.DerivedTuples,
			surface: surfaceForSource(source),
		}

		if (!sink.write(`${stringifyJSON(migrated)}\n`)) {
			await once(sink, "drain")
		}
	}

	sink.end()
	await once(sink, "finish")

	return summary
}
