/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer release` — the whole gazetteer pipeline, turnkey: durable GeoNames fold →
 *   candidate build (FTS baked in) → promote the convention path → publish to R2 + bump the demo.
 *   The codified 2026-06-27 rebuild, no questions. `--no-publish` stops after promote (build local
 *   only); `--dry-run` previews the R2 upload. Creds: `RCLONE_S3_PUBLIC_*` in the env (source
 *   `.env`) for the publish step.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { formatGeonamesIngestProgress } from "@mailwoman/resolver-wof-sqlite/geonames"
import { Box, Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	phaseReporter,
	splitCountryCodes,
	useCommandTask,
} from "#cli-kit"
import { DEFAULT_FOLD_COUNTRIES } from "#gazetteer-pipeline/defaults"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "release",
	description: "Build, promote, and publish a gazetteer release",
	options: {
		admin: { type: "string", description: "Admin source DB. Default <data-root>/db/wof/admin-global-priority.db" },
		out: { type: "string", description: "Candidate-DB output. Default <data-root>/db/wof/candidate-global.db" },
		countries: {
			type: "string",
			description: `Fold countries (comma-separated). Default: the ${DEFAULT_FOLD_COUNTRIES.length}-country recipe`,
		},
		fold: { type: "boolean", default: false, description: "Re-run the GeoNames fold (default off)" },
		promote: { type: "boolean", default: true, description: "Promote the convention path after building" },
		publish: { type: "boolean", default: true, description: "Publish to R2 and bump the demo after promoting" },
		"gazetteer-version": { type: "string", description: "Gazetteer version. Default today's date + 'a'" },
		"dry-run": { type: "boolean", default: false, description: "Preview the R2 upload; don't push or bump the demo" },
	},
} as const satisfies CommandSpec

const GazetteerRelease: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath } = await import("@mailwoman/core/data-root")
		const { repoRootPathBuilder } = await import("@mailwoman/core/paths")

		const {
			buildCandidate,
			DEFAULT_ADMIN_DB,
			DEFAULT_CANDIDATE_OUT,
			defaultGazetteerVersion,
			foldGeonamesIntoAdmin,
			promoteCandidate,
			publishGazetteer,
			resolvePostcodeDatabases,
		} = await import("#gazetteer-pipeline")

		const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")

		const root = dataRootPath()
		const adminIn = options.admin ?? wofDatabasePath(DEFAULT_ADMIN_DB)
		const out = options.out ?? wofDatabasePath(DEFAULT_CANDIDATE_OUT)

		const countries = options.countries ? splitCountryCodes(options.countries) : DEFAULT_FOLD_COUNTRIES

		const lines: string[] = []

		let adminDB = adminIn

		if (options.fold) {
			const foldOut = adminIn.replace(/\.db$/, "-geonames.db")

			console.error(`▸ fold (${countries.join(",")}) → ${foldOut}`)

			const f = await foldGeonamesIntoAdmin({
				adminIn,
				adminOut: foldOut,
				countries,
				onCountry: (e) => console.error(`  ${formatGeonamesIngestProgress(e)}`),
				onPhase: phaseReporter(),
			})

			lines.push(`folded ${f.ingested.toLocaleString()} GeoNames places`)
			adminDB = foldOut
		}

		const databases = await resolvePostcodeDatabases(undefined, root)

		console.error(`▸ build ← ${adminDB} (${databases.length} postcode databases; FTS baked in)`)

		const r = await buildCandidate({
			adminDB,
			out,
			postcodeDatabases: databases,
			onProgress: (phase, msg) => console.error(`  [${phase}] ${msg}`),
		})

		lines.push(`built ${out} — ${r.rows.toLocaleString()} rows, ${r.postcodes.toLocaleString()} postcodes`)

		if (options.promote) {
			const linkPath = await promoteCandidate(out, root)
			lines.push(`promoted ${linkPath} → ${out}`)
		}

		if (options.publish) {
			const version = options.gazetteerVersion ?? defaultGazetteerVersion(new Date())
			await using stage = await temporaryDirectory("mailwoman-gazetteer-")

			console.error(`▸ publish → R2 gazetteer/${version}/candidate.db${options.dryRun ? " (dry-run)" : ""}`)

			const p = await publishGazetteer({
				candidateDB: out,
				version,
				uploadScript: repoRootPathBuilder("docs", "scripts", "publish-demo-assets-to-r2.py"),
				resourcesFile: repoRootPathBuilder("docs", "src", "shared", "resources.tsx"),
				stageDir: stage.path,
				prefix: "mailwoman",
				dryRun: options.dryRun,
				onPhase: phaseReporter(),
			})

			lines.push(`published R2 ${p.key}${p.bumped ? ` + demo → ${version} (commit resources.tsx)` : ""}`)
		}

		return lines
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				<Text color="green">✓ gazetteer release complete</Text>
				{state.result.map((line, i) => (
					<Text key={i}> • {line}</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerRelease
