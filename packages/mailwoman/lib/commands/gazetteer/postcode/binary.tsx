/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Implements `mailwoman gazetteer postcode-binary`, which writes one `postcode-<cc>.bin` per country
 *   from the SQLite postcode databases. `PostcodeBinaryResolver` in `@mailwoman/neural` reads these
 *   files, and per-country files let the browser fetch only the locale it needs.
 *
 *   The database `name` column already holds the normalized postcode key that the anchor queries, so
 *   the command serializes it unchanged.
 *
 *   `--gb-granularity` selects the GB key set. `unit`, the default, holds every unit plus its outward
 *   district and matches the anchor model's training data. `outward` holds only districts and is small
 *   enough for a browser bundle. `gazetteer-pipeline/postcode/binary.ts` derives the outward district
 *   from the postcode's shape, so it handles both spaced and space-stripped sources.
 *
 *   The command checks each locale's key count against a floor before writing and throws when the count
 *   is too low. Without `--locale`, the sources come from `POSTCODE_BINARY_SOURCES`. Per-locale progress
 *   goes to stderr.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { allRows } from "@mailwoman/core/utils"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { Box, Text } from "ink"
import { type PathBuilder, resolvePathBuilder } from "path-ts"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"
import type { GBGranularity, PostcodeDatabaseRow } from "#gazetteer-pipeline/postcode/binary"

interface LocaleSource {
	country: string
	db: PathBuilder
}

/**
 * Binary size above which the command prints a note suggesting the browser granularity.
 * The command does not enforce it.
 */
const BROWSER_BUDGET_BYTES = 4 * 1024 * 1024

/**
 * The command specification for `mailwoman gazetteer postcode-binary`.
 */
export const spec = {
	name: "postcode-binary",
	description: "Build postcode binary indexes",
	options: {
		out: { type: "string", default: "docs/static/mailwoman", description: "Output directory" },
		locale: { type: "string", multiple: true, description: "Repeatable <CC>:<db> source override" },
		"gb-granularity": {
			type: "string",
			choices: ["unit", "outward"],
			default: "unit",
			description: "GB key granularity",
		},
	},
} as const satisfies CommandSpec

/**
 * Writes the postcode binaries and renders a summary.
 */
const GazetteerPostcodeBinary: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")
		const { serializePostcodeBinary } = await import("@mailwoman/neural/postcode")

		const { browserGranularityFor, buildPostcodeBinaryEntries, keyFloorViolation, POSTCODE_BINARY_SOURCES } =
			await import("#gazetteer-pipeline/postcode/binary")

		const outDir = resolvePathBuilder(options.out)

		const locales: LocaleSource[] = []

		for (const localeSpec of options.locale ?? []) {
			const [country, db] = localeSpec.split(":")

			if (country && db) {
				// A relative `db` resolves under the WOF directory, and an absolute one is used as is.
				locales.push({ country, db: wofDatabasePath(db) })
			}
		}

		if (!locales.length) {
			locales.push(
				...POSTCODE_BINARY_SOURCES.map(({ country, database }) => ({ country, db: wofDatabasePath(database) }))
			)
		}

		const granularity: GBGranularity = options.gbGranularity
		let written = 0

		for (const { country, db } of locales) {
			if (!(await pathExists(db))) {
				console.error(`skip ${country}: missing ${db}`)

				continue
			}

			using conn = new DatabaseClient<WOFDatabase>(db, { readOnly: true })

			const rows = allRows<PostcodeDatabaseRow>(
				conn.prepare(
					`SELECT name, latitude AS lat, longitude AS lon FROM spr
					 WHERE placetype='postalcode' AND is_current!=0 AND country=?`
				),
				country
			)

			const { entries, skipped, outwardKeys } = buildPostcodeBinaryEntries(country, rows, {
				gbGranularity: granularity,
			})

			// An empty binary is structurally valid, so the key-count floor is the only check that catches it.
			const violation = keyFloorViolation(country, entries.length, granularity)

			if (violation) {
				throw new Error(
					`${violation} Read ${rows.length.toLocaleString()} rows from ${db}` +
						(skipped ? `, dropped ${skipped.toLocaleString()} as non-${country}-shaped.` : ".")
				)
			}

			const bytes = serializePostcodeBinary(entries)
			const outPath = outDir(`postcode-${country.toLowerCase()}.bin`)
			await writeLocalFile(bytes, outPath)

			written++
			const placed = entries.filter((e) => e.lat !== 0 || e.lon !== 0).length

			console.error(
				`${country}: ${entries.length.toLocaleString()} codes (${placed.toLocaleString()} placed` +
					(outwardKeys ? `, ${outwardKeys.toLocaleString()} outward districts` : "") +
					(skipped ? `, ${skipped.toLocaleString()} rows skipped as non-unit-shaped` : "") +
					`) → ${outPath} (${ByteFormatter.formatIEC(bytes.length)})`
			)

			// The default output directory holds browser assets, so an oversized binary
			// gets a note that suggests the browser granularity.
			// The source table defines which countries have one.
			const browserGranularity = browserGranularityFor(country)

			if (browserGranularity && granularity !== browserGranularity && bytes.length > BROWSER_BUDGET_BYTES) {
				console.error(
					`  NOTE: that is the TRAIN-FAITHFUL ${granularity} key set, sized for a serving weights package. ` +
						`For a browser bundle pass --gb-granularity ${browserGranularity} (2,863 keys, 0.02 MB).`
				)
			}
		}

		return [`postcode binaries → ${outDir}`, `wrote ${written} of ${locales.length} locale binary(ies)`]
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerPostcodeBinary
