/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman tiles publish` — upload a PMTiles archive to the Cloudflare R2 bucket the tile worker
 *   serves from (nexus-assets → https://tiles.sister.software/...). The worker (`tile-worker`)
 *   reads the key `<prefix>/<tileset>.pmtiles` (prefix "tiles" per its wrangler config) and
 *   exposes:
 *
 *   - https://tiles.sister.software/<tileset>.json (TileJSON)
 *   - https://tiles.sister.software/<tileset>/{z}/{x}/{y}.{ext} (vector tiles) So `--tileset coverage`
 *       lights up the demo's coverage source with zero further wiring.
 *
 *   Uploads via `rclone` (the RCLONE_S3_* env vars ARE its s3-backend config — source the repo .env
 *   first: `set -a; . ./.env; set +a`). rclone handles multipart for large archives (no 300 MiB
 *   cap, unlike `wrangler r2 object put`); the documented anti-501 flags skip the post-PUT
 *   HEAD/checksum ops R2 rejects. The worker reads the object via its R2 binding, so
 *   Content-Type/Cache-Control don't matter.
 *
 *   CREDS for the `nexus-assets` bucket: the `RCLONE_S3_*` keys are scoped to `mailwoman-assets` (403
 *   on nexus-assets); the `RCLONE_S3_PUBLIC_*` keys write nexus-assets. Map them onto the
 *   on-the-fly `:s3:` remote: `RCLONE_S3_ACCESS_KEY_ID=$RCLONE_S3_PUBLIC_ACCESS_KEY_ID` (+
 *   SECRET/ENDPOINT) before running.
 */

import { existsSync, statSync } from "node:fs"
import { setImmediate } from "node:timers/promises"

import { Spinner } from "@inkjs/ui"
import { $private } from "@mailwoman/core/env"
import { Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"
import { $ } from "zx"

import type { CommandComponent } from "../../sdk/cli.js"

const OptionsSchema = zod.object({
	file: zod.string().describe("Path to the .pmtiles archive to upload"),
	tileset: zod.string().describe("Tile-set name (R2 key = <prefix>/<tileset>.pmtiles; e.g. 'coverage')"),
	bucket: zod.string().optional().default("nexus-assets").describe("R2 bucket the tile worker binds"),
	prefix: zod.string().optional().default("tiles").describe("R2 key prefix (matches the worker's PMTILES_PATH)"),
	dryRun: zod.coerce.boolean().optional().default(false).describe("Print the target without uploading"),
})

export { OptionsSchema as options }

const REQUIRED_ENV = ["RCLONE_S3_ENDPOINT", "RCLONE_S3_ACCESS_KEY_ID", "RCLONE_S3_SECRET_ACCESS_KEY"] as const

async function publishTiles(options: zod.infer<typeof OptionsSchema>): Promise<string> {
	if (!existsSync(options.file)) throw new Error(`--file not found: ${options.file}`)

	if (!options.file.endsWith(".pmtiles")) throw new Error(`--file must be a .pmtiles archive: ${options.file}`)

	const key = `${options.prefix}/${options.tileset}.pmtiles`
	const sizeMb = statSync(options.file).size / 1024 / 1024
	const servedAt = `https://tiles.sister.software/${options.tileset}.json`

	if (options.dryRun) {
		return `[dry-run] ${options.file} (${sizeMb.toFixed(1)} MB) → ${options.bucket}/${key}\n[dry-run] would serve at ${servedAt}`
	}

	const missing = REQUIRED_ENV.filter((v) => !$private[v])

	if (missing.length) {
		throw new Error(`missing env: ${missing.join(", ")} — source the repo .env first (set -a; . ./.env; set +a)`)
	}

	// rclone reads RCLONE_S3_* from the inherited env for the on-the-fly `:s3:` remote. The flags skip the
	// post-PUT HEAD + checksum ops that 501 against R2 (see scripts/publish-demo-assets-to-r2.py rationale).
	const remote = `:s3:${options.bucket}/${key}`
	const flags = ["--s3-no-head", "--s3-disable-checksum", "--no-update-modtime"]
	const result = await $({ nothrow: true, quiet: true })`rclone copyto ${options.file} ${remote} ${flags}`

	if (result.exitCode !== 0) {
		throw new Error(`rclone exited ${result.exitCode}: ${result.stderr.slice(-400)}`)
	}

	return `✓ ${options.bucket}/${key} (${sizeMb.toFixed(1)} MB)\n  served at ${servedAt}`
}

const TilesPublish: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [output, setOutput] = useState<string>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		if (error) setImmediate().then(() => process.exit(1))
	}, [error])

	useEffect(() => {
		publishTiles(options)
			.then(setOutput)
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
	}, [options])

	if (error) return <Text color="red">{error}</Text>

	if (!output) return <Spinner label={`publishing ${options.tileset}.pmtiles to R2…`} />

	return <Text>{output}</Text>
}

export default TilesPublish
