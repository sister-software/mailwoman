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

/**
 * A transport that puts one local file at `bucket/key`. The default is rclone over the `RCLONE_S3_*` credentials; a
 * caller with another credential (the planetary pipeline uploads through wrangler and the account's API token) injects
 * its own, and the key layout, the size report and the served-at line stay shared.
 */
export type UploadTransport = (target: { file: string; bucket: string; key: string }) => Promise<void>

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
	/**
	 * How the bytes travel. @default rclone
	 */
	upload?: UploadTransport
}

export interface PublishTilesOptions {
	file: string
	tileset: string
	bucket: string
	prefix: string
	dryRun: boolean
	upload?: UploadTransport
}

const REQUIRED_ENV = ["RCLONE_S3_ENDPOINT", "RCLONE_S3_ACCESS_KEY_ID", "RCLONE_S3_SECRET_ACCESS_KEY"] as const

/**
 * The default transport: rclone over the inherited `RCLONE_S3_*` credentials, on the on-the-fly `:s3:` remote. The
 * flags skip the post-PUT HEAD + checksum ops that 501 against R2.
 */
export const uploadWithRclone: UploadTransport = async ({ file, bucket, key }) => {
	const { $private } = await import("#env")
	const { $ } = await import("zx")

	const missing = REQUIRED_ENV.filter((v) => !$private[v])

	if (missing.length) {
		throw new CommandError(`missing env: ${missing.join(", ")} — source the repo .env first (set -a; . ./.env; set +a)`)
	}

	const remote = `:s3:${bucket}/${key}`
	const flags = ["--s3-no-head", "--s3-disable-checksum", "--no-update-modtime"]
	const result = await $({ nothrow: true, quiet: true })`rclone copyto ${file} ${remote} ${flags}`

	if (result.exitCode !== 0) {
		throw new CommandError(`rclone exited ${result.exitCode}: ${result.stderr.slice(-400)}`)
	}
}

/**
 * Copy one local file to `bucket/key`. Answers a one-line report.
 */
export async function uploadToBucket(options: UploadToBucketOptions): Promise<string> {
	if (!(await pathExists(options.file))) throw new CommandError(`file not found: ${options.file}`)

	const size = await formatFileSize(options.file)

	if (options.dryRun) {
		return `[dry-run] ${options.file} (${size}) → ${options.bucket}/${options.key}`
	}

	await (options.upload ?? uploadWithRclone)({ file: options.file, bucket: options.bucket, key: options.key })

	return `✓ ${options.bucket}/${options.key} (${size})`
}

/**
 * Publish a PMTiles archive under the tile worker's key layout. Answers the report with the URL it serves at.
 */
export async function publishTiles(options: PublishTilesOptions): Promise<string> {
	if (!options.file.endsWith(".pmtiles")) throw new CommandError(`--file must be a .pmtiles archive: ${options.file}`)

	const key = `${options.prefix}/${options.tileset}.pmtiles`
	const servedAt = `https://tiles.mailwoman.ai/${options.tileset}.json`

	const report = await uploadToBucket({
		file: options.file,
		bucket: options.bucket,
		key,
		dryRun: options.dryRun,
		upload: options.upload,
	})

	return options.dryRun ? `${report}\n[dry-run] would serve at ${servedAt}` : `${report}\n  served at ${servedAt}`
}
