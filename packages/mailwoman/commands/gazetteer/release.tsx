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

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"
import { DEFAULT_FOLD_COUNTRIES } from "#gazetteer-pipeline/defaults"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "release",
	description: "Build, promote, and publish a gazetteer release",
	options: {
		admin: { type: "string", description: "Admin source DB. Default <data-root>/wof/admin-global-priority.db" },
		out: { type: "string", description: "Candidate-DB output. Default <data-root>/wof/candidate-global.db" },
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

interface Options {
	admin?: string
	out?: string
	countries?: string
	fold: boolean
	promote: boolean
	publish: boolean
	gazetteerVersion?: string
	dryRun: boolean
}

const GazetteerRelease: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { mailwomanDataRoot, repoRootPathBuilder } = await import("@mailwoman/core/utils")

		const {
			buildCandidate,
			DEFAULT_ADMIN_DB,
			DEFAULT_CANDIDATE_OUT,
			defaultGazetteerVersion,
			foldGeonamesIntoAdmin,
			promoteCandidate,
			publishGazetteer,
			resolvePostcodeShards,
			wofDir,
		} = await import("#gazetteer-pipeline")

		const root = mailwomanDataRoot()
		const adminIn = options.admin ?? join(wofDir(root), DEFAULT_ADMIN_DB)
		const out = options.out ?? join(wofDir(root), DEFAULT_CANDIDATE_OUT)

		const countries = options.countries
			? options.countries
					.split(",")
					.map((s) => s.trim().toUpperCase())
					.filter((cc) => cc.length > 0)
			: DEFAULT_FOLD_COUNTRIES

		const lines: string[] = []

		let adminDB = adminIn

		if (options.fold) {
			const foldOut = adminIn.replace(/\.db$/, "-geonames.db")

			console.error(`▸ fold (${countries.join(",")}) → ${foldOut}`)

			const f = await foldGeonamesIntoAdmin({
				adminIn,
				adminOut: foldOut,
				countries,
				onCountry: (e) =>
					console.error(`  ${e.country}: ${e.skipped ? "(skipped)" : `${e.places.toLocaleString()} places`}`),
				onPhase: (p, d) => console.error(`  [${p}]${d ? ` ${d}` : ""}`),
			})

			lines.push(`folded ${f.ingested.toLocaleString()} GeoNames places`)
			adminDB = foldOut
		}

		const shards = resolvePostcodeShards(undefined, root)

		console.error(`▸ build ← ${adminDB} (${shards.length} postcode shards; FTS baked in)`)

		const r = await buildCandidate({
			adminDB,
			out,
			postcodeShards: shards,
			onProgress: (phase, msg) => console.error(`  [${phase}] ${msg}`),
		})

		lines.push(`built ${out} — ${r.rows.toLocaleString()} rows, ${r.postcodes.toLocaleString()} postcodes`)

		if (options.promote) {
			const linkPath = promoteCandidate(out, root)
			lines.push(`promoted ${linkPath} → ${out}`)
		}

		if (options.publish) {
			const version = options.gazetteerVersion ?? defaultGazetteerVersion(new Date())
			const stageDir = mkdtempSync(join(tmpdir(), "mailwoman-gazetteer-"))

			console.error(`▸ publish → R2 gazetteer/${version}/candidate.db${options.dryRun ? " (dry-run)" : ""}`)

			const p = publishGazetteer({
				candidateDB: out,
				version,
				uploadScript: String(repoRootPathBuilder("scripts", "publish-demo-assets-to-r2.py")),
				resourcesFile: String(repoRootPathBuilder("docs", "src", "shared", "resources.tsx")),
				stageDir,
				prefix: "mailwoman",
				dryRun: options.dryRun,
				onPhase: (ph, d) => console.error(`  [${ph}]${d ? ` ${d}` : ""}`),
			})

			lines.push(`published R2 ${p.key}${p.bumped ? ` + demo → ${version} (commit resources.tsx)` : ""}`)
		}

		return lines
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

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
