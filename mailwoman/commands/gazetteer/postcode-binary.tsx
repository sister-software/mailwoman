/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer postcode-binary` — build per-country browser postcode binaries (#240) from
 *   the SQLite shards. Emits one `postcode-<cc>.bin` per locale into the `--out` dir (default
 *   `docs/static/mailwoman/`, alongside `fst-en-US.bin`), each loadable by `@mailwoman/neural`'s
 *   `PostcodeBinaryResolver` in the WASM/browser parser. Per-country so the browser fetches only
 *   the locale it needs (the tiered-loading story in the design doc).
 *
 *   The shard `name` is already the normalized postcode key (DE/FR `68161`/`75008`, NL space-less
 *   `1012LM`, US `94105`), which is exactly what the anchor queries, so it serializes verbatim.
 *
 *   **GB is special**, and it is where this command shipped two defects (#1509 — the derivation and
 *   the refusal both live in `gazetteer-pipeline/postcode/binary.ts`, with the reproduction). The
 *   outward district is now derived by SHAPE (the inward code is the trailing three characters of the
 *   space-stripped form), so the same rule reads the spaced GeoNames-lineage shard and the
 *   space-stripped Code-Point Open one. `--gb-granularity` picks the key set:
 *
 *   - `unit` (DEFAULT) — every unit PLUS its outward district: 1,749,839 keys / 20.0 MB from
 *       `postalcode-gb-codepoint.db`. This is the TRAIN-FAITHFUL set. A model trained against
 *       `pilot-anchor-lookup-v2` was painted from UNIT centroids, so serving it anything coarser feeds
 *       the anchor channel a different distribution than training saw.
 *   - `outward` — districts only: 2,863 keys / 0.03 MB. The only GB set that fits a browser bundle, and
 *       the command's original behaviour.
 *
 *   Every locale's key count is checked against a documented floor before anything is written; a build
 *   below it exits NONZERO with a named reason rather than shipping a valid, empty binary.
 *
 *   Defaults to US + NL/FR/DE/ES/IT (postalcode-intl.db) + GB (postalcode-gb-codepoint.db, the
 *   licence-clean OGL v3.0 source). Each `.bin` is written DIRECTLY to `--out` (the original
 *   `scripts/build-postcode-binary.ts` behavior). Per-locale progress streams to stderr; the roll-up
 *   lands on stdout.
 */

import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { Box, Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

import type { GBGranularity, PostcodeShardRow } from "../../gazetteer-pipeline/postcode/binary.ts"

interface LocaleSource {
	country: string
	db: string
}

/**
 * Size past which a `.bin` written into the browser asset dir is worth a word. Not a limit and not enforced — the
 * command's default `--out` is `docs/static/mailwoman`, and a GB unit build lands 20 MB there, so the number exists to
 * make the reader notice rather than to decide for them.
 */
const BROWSER_BUDGET_BYTES = 4 * 1024 * 1024

const OptionsSchema = zod.object({
	out: zod
		.string()
		.default("docs/static/mailwoman")
		.describe("Output dir for the postcode-<cc>.bin files. Default docs/static/mailwoman"),
	locale: zod
		.array(zod.string())
		.optional()
		.describe(
			"`<CC>:<db>` source override, repeatable (db relative to <data-root>/wof or absolute). " +
				"Default: US + NL/FR/DE/ES/IT (postalcode-intl.db) + GB (postalcode-gb-codepoint.db)."
		),
	// Pastel binds the kebab flag to this lowercase-acronym prop by derivation — see AGENTS.md.
	gbGranularity: zod
		.enum(["unit", "outward"])
		.default("unit")
		.describe(
			"GB key set: `unit` (units + outward districts, 1,749,839 keys / 20.0 MB — train-faithful, " +
				"the anchor-v2 default) or `outward` (districts only, 2,863 keys / 0.03 MB — browser budget)."
		),
})

export { OptionsSchema as options }

const GazetteerPostcodeBinary: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath } = await import("@mailwoman/core/utils")
		// `@mailwoman/neural/postcode-binary-resolver` is a self-contained serializer whose only imports are
		// type-only, so this load costs a file read rather than the ONNX runtime the package name suggests.
		const { serializePostcodeBinary } = await import("@mailwoman/neural/postcode-binary-resolver")

		const { buildPostcodeBinaryEntries, keyFloorViolation } =
			await import("../../gazetteer-pipeline/postcode/binary.ts")

		const wof = dataRootPath("wof")
		const outDir = options.out

		const locales: LocaleSource[] = []

		for (const spec of options.locale ?? []) {
			const [country, db] = spec.split(":")

			if (country && db) {
				locales.push({ country, db: db.startsWith("/") ? db : join(wof, db) })
			}
		}

		if (!locales.length) {
			locales.push(
				{ country: "US", db: join(wof, "postalcode-us.db") },
				{ country: "NL", db: join(wof, "postalcode-intl.db") },
				{ country: "FR", db: join(wof, "postalcode-intl.db") },
				{ country: "DE", db: join(wof, "postalcode-intl.db") },
				{ country: "ES", db: join(wof, "postalcode-intl.db") },
				{ country: "IT", db: join(wof, "postalcode-intl.db") },
				{ country: "GB", db: join(wof, "postalcode-gb-codepoint.db") }
			)
		}

		const granularity: GBGranularity = options.gbGranularity
		let written = 0

		for (const { country, db } of locales) {
			if (!existsSync(db)) {
				console.error(`skip ${country}: missing ${db}`)

				continue
			}

			const conn = new DatabaseSync(db, { readOnly: true })

			const rows = conn
				.prepare(
					`SELECT name, latitude AS lat, longitude AS lon FROM spr
					 WHERE placetype='postalcode' AND is_current!=0 AND country=?`
				)
				.all(country) as unknown as PostcodeShardRow[]

			conn.close()

			const { entries, skipped, outwardKeys } = buildPostcodeBinaryEntries(country, rows, {
				gbGranularity: granularity,
			})

			// REFUSE BEFORE WRITING (#1509). A magnitude never carries its own absence: a zero-key binary
			// is structurally valid, so the only place the failure can surface is here.
			const violation = keyFloorViolation(country, entries.length, granularity)

			if (violation) {
				throw new Error(
					`${violation} Read ${rows.length.toLocaleString()} rows from ${db}` +
						(skipped ? `, dropped ${skipped.toLocaleString()} as non-${country}-shaped.` : ".")
				)
			}

			const bytes = serializePostcodeBinary(entries)
			const outPath = join(outDir, `postcode-${country.toLowerCase()}.bin`)
			writeFileSync(outPath, bytes)

			written++
			const placed = entries.filter((e) => e.lat !== 0 || e.lon !== 0).length

			console.error(
				`${country}: ${entries.length.toLocaleString()} codes (${placed.toLocaleString()} placed` +
					(outwardKeys ? `, ${outwardKeys.toLocaleString()} outward districts` : "") +
					(skipped ? `, ${skipped.toLocaleString()} rows skipped as non-unit-shaped` : "") +
					`) → ${outPath} (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`
			)

			// The GB default is `unit` because that is what the anchor-v2 model was TRAINED against, and a
			// serving bundle shipping anything coarser feeds the channel a different distribution than
			// training painted. But this command's default `--out` is the BROWSER asset dir, where 20 MB is
			// not a postcode binary, it is the whole page budget. The size is printed either way; this names
			// the lever rather than deciding for the operator.
			if (country.toUpperCase() === "GB" && granularity === "unit" && bytes.length > BROWSER_BUDGET_BYTES) {
				console.error(
					`  NOTE: that is the TRAIN-FAITHFUL unit key set, sized for a serving weights package. ` +
						`For a browser bundle pass --gb-granularity outward (2,863 keys, 0.02 MB).`
				)
			}
		}

		return [`postcode binaries → ${outDir}`, `wrote ${written} of ${locales.length} locale binary(ies)`]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

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

	return null // per-locale progress streams to stderr until the roll-up lands
}

export default GazetteerPostcodeBinary
