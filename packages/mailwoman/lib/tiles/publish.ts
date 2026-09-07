/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Publishing a PMTiles archive to the Cloudflare R2 bucket the tile worker serves from (`nexus-assets` →
 *   https://tiles.mailwoman.ai/...), as functions the `tiles publish` command and the planetary pipeline both call.
 *   The worker reads the key `<prefix>/<tileset>.pmtiles` (prefix `tiles` per its wrangler config) and exposes
 *   `https://tiles.mailwoman.ai/<tileset>.json` and `/<tileset>/{z}/{x}/{y}.{ext}`.
 *
 *   Uploads go through `rclone`: the `RCLONE_S3_*` variables ARE its s3-backend config (source the repo `.env` first:
 *   `set -a; . ./.env; set +a`). rclone handles multipart for large archives, and the anti-501 flags skip the post-PUT
 *   HEAD and checksum operations R2 refuses. The worker reads the object through its R2 binding, so Content-Type and
 *   Cache-Control do not matter.
 *
 *   CREDENTIALS for the `nexus-assets` bucket: the `RCLONE_S3_*` keys are scoped to `mailwoman-assets` (403 on
 *   nexus-assets); the `RCLONE_S3_PUBLIC_*` keys write nexus-assets. Map them onto the on-the-fly `:s3:` remote
 *   (`RCLONE_S3_ACCESS_KEY_ID=$RCLONE_S3_PUBLIC_ACCESS_KEY_ID`, plus SECRET and ENDPOINT) before running.
 */

import { formatFileSize, pathExists } from "@mailwoman/core/fs/readers"
import { CommandError } from "@mailwoman/core/scripting/command"

export interface UploadToBucketOptions {
	/**
	 * The local file to upload.
	 */
	file: string
	bucket: string
	/**
	 * The object key, including any prefix.
	 */
	key: string
	/**
	 * Print the target without uploading.
	 */
	dryRun: boolean
}

export interface PublishTilesOptions {
	file: string
	tileset: string
	bucket: string
	prefix: string
	dryRun: boolean
}

const REQUIRED_ENV = ["RCLONE_S3_ENDPOINT", "RCLONE_S3_ACCESS_KEY_ID", "RCLONE_S3_SECRET_ACCESS_KEY"] as const

/**
 * Copy one local file to `bucket/key` through rclone. Answers a one-line report.
 */
export async function uploadToBucket(options: UploadToBucketOptions): Promise<string> {
	const { $private } = await import("#env")
	const { $ } = await import("zx")

	if (!(await pathExists(options.file))) throw new CommandError(`file not found: ${options.file}`)

	const size = await formatFileSize(options.file)

	if (options.dryRun) {
		return `[dry-run] ${options.file} (${size}) → ${options.bucket}/${options.key}`
	}

	const missing = REQUIRED_ENV.filter((v) => !$private[v])

	if (missing.length) {
		throw new CommandError(`missing env: ${missing.join(", ")} — source the repo .env first (set -a; . ./.env; set +a)`)
	}

	// rclone reads RCLONE_S3_* from the inherited env for the on-the-fly `:s3:` remote. The flags skip the post-PUT
	// HEAD + checksum ops that 501 against R2.
	const remote = `:s3:${options.bucket}/${options.key}`
	const flags = ["--s3-no-head", "--s3-disable-checksum", "--no-update-modtime"]
	const result = await $({ nothrow: true, quiet: true })`rclone copyto ${options.file} ${remote} ${flags}`

	if (result.exitCode !== 0) {
		throw new CommandError(`rclone exited ${result.exitCode}: ${result.stderr.slice(-400)}`)
	}

	return `✓ ${options.bucket}/${options.key} (${size})`
}

/**
 * Publish a PMTiles archive under the tile worker's key layout. Answers the report with the URL it serves at.
 */
export async function publishTiles(options: PublishTilesOptions): Promise<string> {
	if (!options.file.endsWith(".pmtiles")) throw new CommandError(`--file must be a .pmtiles archive: ${options.file}`)

	const key = `${options.prefix}/${options.tileset}.pmtiles`
	const servedAt = `https://tiles.mailwoman.ai/${options.tileset}.json`
	const report = await uploadToBucket({ file: options.file, bucket: options.bucket, key, dryRun: options.dryRun })

	return options.dryRun ? `${report}\n[dry-run] would serve at ${servedAt}` : `${report}\n  served at ${servedAt}`
}
