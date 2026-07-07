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

import { mailwomanDataRoot, repoRootPathBuilder } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import {
	DEFAULT_CANDIDATE_OUT,
	defaultGazetteerVersion,
	publishGazetteer,
	wofDir,
} from "../../gazetteer-pipeline/index.js"
import type { CommandComponent } from "../../sdk/cli.js"

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
	const [error, setError] = useState<string>()
	const [done, setDone] = useState<string[]>()

	useEffect(() => {
		try {
			const root = mailwomanDataRoot()
			const candidateDb = args[0] ?? join(wofDir(root), DEFAULT_CANDIDATE_OUT)
			const version = options.gazetteerVersion ?? defaultGazetteerVersion(new Date())
			const uploadScript = String(repoRootPathBuilder("scripts", "publish-demo-assets-to-r2.py"))
			const resourcesFile = options.bumpDemo
				? String(repoRootPathBuilder("docs", "src", "shared", "resources.tsx"))
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
			setDone([
				`R2: ${r.key}`,
				r.bumped
					? `demo: ADMIN_GAZETTEER_VERSION → ${version} (commit docs/src/shared/resources.tsx)`
					: "demo: not bumped",
			])
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		}
	}, [options, args])

	useEffect(() => {
		if (done || error) {
			setImmediate(() => process.exit(error ? 1 : 0))
		}
	}, [done, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (done) {
		return (
			<Box flexDirection="column">
				<Text color="green">✓ published</Text>
				{done.map((line, i) => (
					<Text key={i}> {line}</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerPublish
