/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Builds the corpus street index from a corpus version's premise-register rows.
 *
 *   The unit splitter (`#adapters/street/unit`) reads it to confirm that what remains of a street after a unit
 *   comes off is a street a register publishes. The index is built from the previous corpus version, so a row
 *   being split never attests itself.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import type { PathBuilderLike } from "path-ts"

import { BUILTIN_ADAPTERS } from "#adapters"
import { escapeSQLString, openDuckDB, type DuckDBLimits } from "#parquet/duckdb"
import { type StreetLine, writeStreetIndex } from "#street-index/write"
import { localManifestFilePath } from "#tools/overlay/manifest"
import { AddressRole, type CorpusAdapter } from "#types"

/**
 * The tags whose spans make up a street line, in the order a line can hold them.
 */
const STREET_LINE_TAGS = ["street_prefix", "street_prefix_particle", "street", "street_suffix"] as const

/**
 * The registers whose adapters publish premises (`AddressRole.Premise`), such as `us-dot-nad` and `fr-ban`.
 *
 * A register of practice, facility or counterparty addresses is left out:
 * its street field is the registrant's typing.
 * The splitter corrects that typing, so it cannot attest a street.
 */
export function premiseRegisters(adapters: readonly CorpusAdapter[] = BUILTIN_ADAPTERS): Set<string> {
	return new Set(
		adapters
			.filter((adapter) => adapter.addressRole === AddressRole.Premise)
			.map((adapter) => adapter.register)
			.filter((register): register is NonNullable<typeof register> => register != null)
	)
}

/**
 * What one build read and wrote.
 */
export interface StreetIndexBuildReport {
	registers: string[]
	files: number
	/**
	 * Distinct (country, street line, locality) triples read before folding.
	 */
	streetLines: number
	/**
	 * Rows written after folding, one per distinct folded triple.
	 */
	rows: number
	byCountry: Record<string, number>
}

export interface BuildStreetIndexOptions {
	/**
	 * The corpus manifest whose premise-register rows the index holds.
	 */
	manifest: PathBuilderLike
	out: PathBuilderLike
	limits?: DuckDBLimits
	registers?: ReadonlySet<string>
}

/**
 * The distinct street lines of the manifest's base rows whose `register` is in `registers`.
 *
 * A row's street line runs from its first street-line span to its last,
 * so `Rue du General Charles de Gaulle` keeps its type word and its spacing.
 */
async function* streetLinesOf(
	paths: readonly string[],
	registers: ReadonlySet<string>,
	limits: DuckDBLimits | undefined
): AsyncGenerator<StreetLine> {
	using db = await openDuckDB(limits)
	const files = paths.map((path) => `'${escapeSQLString(path)}'`).join(", ")
	const registerList = [...registers].map((register) => `'${escapeSQLString(register)}'`).join(", ")
	const tagList = STREET_LINE_TAGS.map((tag) => `'${tag}'`).join(", ")

	const stream = await db.stream(`
		WITH rows AS (
			SELECT country, raw, span_tags, span_starts, span_ends
			FROM read_parquet([${files}], union_by_name = true)
			WHERE coalesce(base_source_id, '') = '' AND register IN (${registerList})),
		spans AS (
			SELECT country, raw,
				list_filter(range(len(span_tags)), lambda i: list_contains([${tagList}], span_tags[i + 1])) AS street_at,
				list_position(span_tags, 'locality') AS locality_at,
				span_starts, span_ends
			FROM rows)
		SELECT DISTINCT country,
			substring(raw, span_starts[street_at[1] + 1] + 1,
				span_ends[street_at[-1] + 1] - span_starts[street_at[1] + 1]) AS street,
			CASE WHEN locality_at IS NULL THEN ''
				ELSE substring(raw, span_starts[locality_at] + 1, span_ends[locality_at] - span_starts[locality_at]) END
				AS locality
		FROM spans WHERE len(street_at) > 0`)

	const columnNames = stream.columnNames()

	for (let chunk = await stream.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await stream.fetchChunk()) {
		for (const row of chunk.getRowObjects(columnNames)) {
			yield { country: String(row.country), street: String(row.street ?? ""), locality: String(row.locality ?? "") }
		}
	}
}

/**
 * Build the street index from one corpus manifest's base rows whose `register` is a premise register.
 */
export async function buildStreetIndex(options: BuildStreetIndexOptions): Promise<StreetIndexBuildReport> {
	const registers = options.registers ?? premiseRegisters()
	const manifest = await readLocalJSONFile<{ files: { path: string }[] }>(options.manifest)
	const paths = manifest.files.map((file) => localManifestFilePath(file.path))
	const count = await writeStreetIndex(streetLinesOf(paths, registers, options.limits), options.out)

	return {
		registers: [...registers].toSorted(),
		files: manifest.files.length,
		streetLines: count.read,
		rows: count.written,
		byCountry: Object.fromEntries([...count.byCountry].toSorted((a, b) => b[1] - a[1])),
	}
}
