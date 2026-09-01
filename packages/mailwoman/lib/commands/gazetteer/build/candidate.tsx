/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build` — the durable GeoNames-alias upstream fold + the byte-range candidate
 *   build (FTS5-trigram fuzzy index baked in), in one command. Every decision the 2026-06-27 manual
 *   rebuild needed (which countries fold, which postcode databases, FTS) is a default here. Progress
 *   streams to stderr; the final summary is on stdout. See RELEASING.md Step 5.
 */

import { Box, Text } from "ink"
import { join } from "path-ts"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	phaseReporter,
	splitUpperList,
	useCommandTask,
} from "#cli-kit"
import { DEFAULT_CANDIDATE_OUT, DEFAULT_FOLD_COUNTRIES, DEFAULT_IMPORTANCE_DB } from "#gazetteer-pipeline/defaults"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "candidate",
	description: "Build the byte-range gazetteer candidate database",
	options: {
		admin: { type: "string", description: "Admin source DB. Default <data-root>/wof/admin-global-priority.db" },
		out: { type: "string", description: "Candidate DB output. Default <data-root>/wof/candidate-global.db" },
		fold: { type: "boolean", default: false, description: "Re-run the GeoNames alias fold before building" },
		countries: {
			type: "string",
			description: `Comma-separated ISO codes. Default: ${DEFAULT_FOLD_COUNTRIES.length}-country recipe`,
		},
		"fold-out": { type: "string", description: "Folded admin DB path. Default <admin>-geonames.db" },
		importance: { type: "string", description: `Importance source. Default <data-root>/wof/${DEFAULT_IMPORTANCE_DB}` },
		"skip-importance": { type: "boolean", default: false, description: "Build with an empty importance column" },
	},
} as const satisfies CommandSpec

interface Options {
	admin?: string
	out?: string
	fold: boolean
	countries?: string
	foldOut?: string
	importance?: string
	skipImportance: boolean
}

const GazetteerBuildCandidate: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { mailwomanDataRoot } = await import("@mailwoman/core/utils")

		const {
			buildCandidate,
			DEFAULT_ADMIN_DB,
			foldGeonamesIntoAdmin,
			resolveImportanceDB,
			resolvePostcodeDatabases,
			wofDir,
		} = await import("#gazetteer-pipeline")

		const root = mailwomanDataRoot()
		const adminIn = options.admin ?? join(wofDir(root), DEFAULT_ADMIN_DB)
		const out = options.out ?? join(wofDir(root), DEFAULT_CANDIDATE_OUT)

		const countries = options.countries ? splitUpperList(options.countries) : DEFAULT_FOLD_COUNTRIES

		let adminDB = adminIn

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
				onPhase: phaseReporter(),
			})

			console.error(
				`  folded ${f.ingested.toLocaleString()} places; place_search ${f.placeSearchRows.toLocaleString()} rows`
			)

			adminDB = foldOut
		}

		const databases = await resolvePostcodeDatabases(undefined, root)

		const importanceDB = options.skipImportance
			? false
			: (options.importance ?? (await resolveImportanceDB(undefined, root)))

		console.error(`▸ candidate build ← ${adminDB} (${databases.length} postcode databases; FTS baked in)`)

		if (importanceDB) {
			console.error(`  importance ← ${importanceDB}`)
		} else {
			// Say which of the two absences this is. "No importance column" from a missing artifact and
			// from `--skip-importance` produce the same DB and want different follow-ups.
			console.error(
				options.skipImportance
					? "  importance: SKIPPED by --skip-importance — the column will be empty"
					: `  importance: no ${DEFAULT_IMPORTANCE_DB} under ${wofDir(root)} — the column will be empty`
			)
		}

		const r = await buildCandidate({
			adminDB,
			out,
			postcodeDatabases: databases,
			importanceDB,
			onProgress: (phase, msg) => console.error(`  [${phase}] ${msg}`),
		})

		return [
			`gazetteer: ${out}`,
			`${r.rows.toLocaleString()} rows — ${r.primaries.toLocaleString()} primary, ${r.aliases.toLocaleString()} alias, ${r.postcodes.toLocaleString()} postcode + ${r.postcodeAliases.toLocaleString()} postcode-alias (from ${r.places.toLocaleString()} places)`,
			`ancestors: ${r.ancestorRows.toLocaleString()} closure rows across ${r.ancestorPlaces.toLocaleString()} places; ${r.intervalPlaces.toLocaleString()} interval labels`,
			r.importanceScored === undefined
				? "importance: not joined (no score source) — the column is empty"
				: `importance: ${r.importanceScored.toLocaleString()} places scored, ${r.importanceGated?.toLocaleString() ?? 0} refused as a different same-name place`,
			`next: mailwoman gazetteer promote   (then publish, or run gazetteer release for all of it)`,
		]
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

	return null // progress streams to stderr until the summary lands
}

export default GazetteerBuildCandidate
