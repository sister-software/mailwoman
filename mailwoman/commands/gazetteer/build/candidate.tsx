/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build` — the durable GeoNames-alias upstream fold + the byte-range candidate
 *   build (FTS5-trigram fuzzy index baked in), in one command. Every decision the 2026-06-27 manual
 *   rebuild needed (which countries fold, which postcode shards, FTS) is a default here. Progress
 *   streams to stderr; the final summary is on stdout. See RELEASING.md Step 5.
 */

import { join } from "node:path"

import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"
import {
	buildCandidate,
	DEFAULT_ADMIN_DB,
	DEFAULT_CANDIDATE_OUT,
	DEFAULT_FOLD_COUNTRIES,
	foldGeonamesIntoAdmin,
	resolvePostcodeShards,
	wofDir,
} from "../../../gazetteer-pipeline/index.ts"

const OptionsSchema = zod.object({
	admin: zod
		.string()
		.optional()
		.describe("Admin (unified-WOF) source DB. Default <data-root>/wof/admin-global-priority.db"),
	out: zod.string().optional().describe("Candidate-DB output path. Default <data-root>/wof/candidate-global.db"),
	fold: zod
		.boolean()
		.default(true)
		.describe("Run the durable GeoNames-alias upstream fold before building (default on)"),
	countries: zod
		.string()
		.optional()
		.describe(`Comma-separated ISO codes for the fold. Default: ${DEFAULT_FOLD_COUNTRIES.join(",")}`),
	foldOut: zod.string().optional().describe("Folded admin-DB path. Default <admin>-geonames.db"),
})

export { OptionsSchema as options }

const GazetteerBuildCandidate: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const root = mailwomanDataRoot()
		const adminIn = options.admin ?? join(wofDir(root), DEFAULT_ADMIN_DB)
		const out = options.out ?? join(wofDir(root), DEFAULT_CANDIDATE_OUT)
		const countries = options.countries
			? options.countries
					.split(",")
					.map((s) => s.trim().toUpperCase())
					.filter(Boolean)
			: DEFAULT_FOLD_COUNTRIES

		let adminDb = adminIn

		if (options.fold) {
			const foldOut = options.foldOut ?? adminIn.replace(/\.db$/, "-geonames.db")
			console.error(`▸ GeoNames upstream fold (${countries.join(",")}) → ${foldOut}`)
			const f = await foldGeonamesIntoAdmin({
				adminIn,
				adminOut: foldOut,
				countries,
				onCountry: (e) =>
					console.error(
						`  ${e.country}: ${e.skipped ? "(dump missing — skipped)" : `${e.places.toLocaleString()} places`}`
					),
				onPhase: (p, d) => console.error(`  [${p}]${d ? ` ${d}` : ""}`),
			})
			console.error(
				`  folded ${f.ingested.toLocaleString()} places; place_search ${f.placeSearchRows.toLocaleString()} rows`
			)
			adminDb = foldOut
		}

		const shards = resolvePostcodeShards(undefined, root)
		console.error(`▸ candidate build ← ${adminDb} (${shards.length} postcode shards; FTS baked in)`)
		const r = await buildCandidate({
			adminDb,
			out,
			postcodeShards: shards,
			onProgress: (phase, msg) => console.error(`  [${phase}] ${msg}`),
		})

		return [
			`gazetteer: ${out}`,
			`${r.rows.toLocaleString()} rows — ${r.primaries.toLocaleString()} primary, ${r.aliases.toLocaleString()} alias, ${r.postcodes.toLocaleString()} postcode (from ${r.places.toLocaleString()} places)`,
			`next: mailwoman gazetteer promote   (then publish, or run gazetteer release for all of it)`,
		]
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

	return null // progress streams to stderr until the summary lands
}

export default GazetteerBuildCandidate
