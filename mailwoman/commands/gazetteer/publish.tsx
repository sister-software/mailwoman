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

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Box, Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import { DEFAULT_CANDIDATE_OUT } from "mailwoman/gazetteer-pipeline/defaults"
import zod from "zod"

const ArgumentsSchema = zod.array(
	zod.string().describe(`Candidate DB to publish. Default <data-root>/wof/${DEFAULT_CANDIDATE_OUT}`)
)

const OptionsSchema = zod.object({
	gazetteerVersion: zod
		.string()
		.optional()
		.describe("Immutable gazetteer version. Default today's date + 'a' (e.g. 2026-06-27a)"),
	bucket: zod.string().optional().describe("R2 bucket (default nexus-public, per the upload script)"),
	prefix: zod.string().default("mailwoman").describe("R2 key prefix"),
	dryRun: zod.boolean().default(false).describe("Show what would upload; don't push or bump the demo"),
	bumpDemo: zod.boolean().default(true).describe("Bump ADMIN_GAZETTEER_VERSION in the demo resources (default on)"),
})

export { ArgumentsSchema as args, OptionsSchema as options }

const GazetteerPublish: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const { mailwomanDataRoot, repoRootPathBuilder } = await import("@mailwoman/core/utils")
		const { defaultGazetteerVersion, publishGazetteer, wofDir } = await import("mailwoman/gazetteer-pipeline")

		const root = mailwomanDataRoot()
		const candidateDb = args[0] ?? join(wofDir(root), DEFAULT_CANDIDATE_OUT)
		const version = options.gazetteerVersion ?? defaultGazetteerVersion(new Date())
		const uploadScript = String(repoRootPathBuilder("scripts", "publish-demo-assets-to-r2.py"))

		const resourcesFile = options.bumpDemo
			? String(repoRootPathBuilder("docs", "src", "shared", "resources", "index.ts"))
			: undefined

		const stageDir = mkdtempSync(join(tmpdir(), "mailwoman-gazetteer-"))

		console.error(
			`▸ publish ${candidateDb} → R2 gazetteer/${version}/candidate.db${options.dryRun ? " (dry-run)" : ""}`
		)

		const r = publishGazetteer({
			candidateDb,
			version,
			uploadScript,
			resourcesFile,
			stageDir,
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
