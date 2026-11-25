// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Copies between a local file and an R2 object with `rclone`, over the `RCLONE_S3_*` credentials.
 *
 *   rclone reads the `RCLONE_S3_*` variables as the config of its on-the-fly `:s3:`
 *   remote, so no rclone config file is needed.
 *   The flags skip the HEAD and checksum requests that R2 answers with 501 after a PUT.
 */

import { CommandError } from "@mailwoman/core/scripting/command"
import { runProcess } from "@mailwoman/core/scripting/process"

const REQUIRED_ENV = ["RCLONE_S3_ENDPOINT", "RCLONE_S3_ACCESS_KEY_ID", "RCLONE_S3_SECRET_ACCESS_KEY"] as const

const R2_FLAGS = ["--s3-no-head", "--s3-no-check-bucket", "--s3-disable-checksum", "--no-update-modtime"]

/**
 * One object in a bucket the `RCLONE_S3_*` credentials reach.
 */
export interface BucketObject {
	bucket: string
	/**
	 * The object key, including any prefix.
	 */
	key: string
}

/**
 * An object as rclone's on-the-fly `:s3:` remote addresses it.
 */
function remoteOf(object: BucketObject): string {
	return `:s3:${object.bucket}/${object.key}`
}

/**
 * Copies `from` to `to` with `rclone copyto`, where each side is a local path or a bucket object.
 *
 * @throws When a `RCLONE_S3_*` variable is unset, or rclone exits non-zero.
 */
export async function copyWithRclone(from: string | BucketObject, to: string | BucketObject): Promise<void> {
	const { $private } = await import("#env")

	const missing = REQUIRED_ENV.filter((name) => !$private[name])

	if (missing.length) {
		throw new CommandError(`missing env: ${missing.join(", ")} — source the repo .env first (set -a; . ./.env; set +a)`)
	}

	const side = (value: string | BucketObject) => (typeof value === "string" ? value : remoteOf(value))
	const result = await runProcess("rclone", ["copyto", side(from), side(to), ...R2_FLAGS], { reject: false })

	if (result.exitCode !== 0) {
		throw new CommandError(`rclone exited ${result.exitCode}: ${result.stderr.slice(-400)}`)
	}
}
