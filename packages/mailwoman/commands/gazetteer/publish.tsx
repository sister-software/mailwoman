import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer publish [<candidate-db>]` — upload the candidate gazetteer to R2 (the demo's
 *   byte-range source) and bump the demo's `ADMIN_GAZETTEER_VERSION`. Shells out to the proven
 *   `scripts/publish-demo-assets-to-r2.py` (boto3 + the R2 cache-control gotchas). The version
 *   defaults to today's date + `a` (e.g. `2026-06-27a`), the immutable convention.
 *
 *   Creds: `RCLONE_S3_PUBLIC_*` must be in the process env — `set -a; . ./.env; set +a` first. This
 *   is an in-repo operator command (it needs the upload script + the demo's resources file).
 */
import { join } from "@mailwoman/platform/path"
import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"
import { DEFAULT_CANDIDATE_OUT } from "#gazetteer-pipeline/defaults"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "publish",
	description: "Publish a candidate gazetteer to R2.",
	positionals: [
		{ name: "candidate-db", description: `Candidate DB. Default <data-root>/wof/${DEFAULT_CANDIDATE_OUT}` },
	],
	options: {
		"gazetteer-version": { type: "string", description: "Immutable gazetteer version" },
		bucket: { type: "string", description: "R2 bucket" },
		prefix: { type: "string", default: "mailwoman", description: "R2 key prefix" },
		"dry-run": { type: "boolean", default: false, description: "Show without uploading" },
		"bump-demo": { type: "boolean", default: true, description: "Bump the demo gazetteer version" },
	},
} as const satisfies CommandSpec

interface Options {
	gazetteerVersion?: string
	bucket?: string
	prefix: string
	dryRun: boolean
	bumpDemo: boolean
}

const GazetteerPublish: ParsedCommandComponent<Options> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const { mailwomanDataRoot, repoRootPathBuilder } = await import("@mailwoman/core/utils")
		const { defaultGazetteerVersion, publishGazetteer, wofDir } = await import("#gazetteer-pipeline")

		const root = mailwomanDataRoot()
		const candidateDB = args[0] ?? join(wofDir(root), DEFAULT_CANDIDATE_OUT)
		const version = options.gazetteerVersion ?? defaultGazetteerVersion(new Date())
		const uploadScript = String(repoRootPathBuilder("scripts", "publish-demo-assets-to-r2.py"))

		const resourcesFile = options.bumpDemo
			? String(repoRootPathBuilder("docs", "src", "shared", "resources", "index.ts"))
			: undefined

		await using stage = await temporaryDirectory("mailwoman-gazetteer-")

		console.error(
			`▸ publish ${candidateDB} → R2 gazetteer/${version}/candidate.db${options.dryRun ? " (dry-run)" : ""}`
		)

		const r = await publishGazetteer({
			candidateDB,
			version,
			uploadScript,
			resourcesFile,
			stageDir: stage.path,
			bucket: options.bucket,
			prefix: options.prefix,
			dryRun: options.dryRun,
			onPhase: (p, d) => console.error(`  [${p}]${d ? ` ${d}` : ""}`),
		})

		return [
			`R2: ${r.key}`,
			r.bumped
				? `demo: ADMIN_GAZETTEER_VERSION → ${version} (commit docs/src/shared/resources/index.ts)`
				: "demo: not bumped",
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				<Text color="green">✓ published</Text>
				{state.result.map((line, i) => (
					<Text key={i}> {line}</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerPublish
