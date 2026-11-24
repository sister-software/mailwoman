// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The shape of one remote overlay tile build: where its inputs, logs and exports sit in the inputs bucket,
 *   and the boot script a build instance runs.
 *
 *   The script holds no secret. It reads the R2 upload keys from Parameter Store through the instance role, so the
 *   user data an EC2 console shows stays free of them.
 */

import { AWS_BUILD_PARAMETER_PATH, AWS_BUILD_REGION } from "#release-kit/deploy/aws/credentials"

/**
 * The key prefix of every object a build reads or writes in the inputs bucket.
 */
const OVERLAY_BUILD_PREFIX = "overlay-tiles"

/**
 * The image every launch runs unless the caller names another.
 */
export const OVERLAY_BUILD_IMAGE = "ghcr.io/sister-software/mailwoman-overlay-tiles"

/**
 * The instance type a launch uses unless the caller names another.
 *
 * An x86 type, because the image is `linux/amd64`, with local NVMe storage for the clones,
 * the exports and the tile sort: 16 vCPUs, 64 GiB and one 950 GB instance-store volume.
 */
export const OVERLAY_BUILD_INSTANCE_TYPE = "m6id.4xlarge"

/**
 * The hours a build instance may run before both deadlines terminate it.
 */
export const OVERLAY_BUILD_DEFAULT_HOURS = 15

/**
 * The Parameter Store names, under {@linkcode AWS_BUILD_PARAMETER_PATH}, of the R2 upload settings.
 *
 * The container's rclone reads them as `RCLONE_S3_*`.
 */
export const OVERLAY_BUILD_PARAMETERS = {
	endpoint: "r2-endpoint",
	accessKeyID: "r2-access-key-id",
	secretAccessKey: "r2-secret-access-key",
} as const

/**
 * The public Parameter Store name of the current Amazon Linux 2023 x86 machine image.
 */
export const OVERLAY_BUILD_IMAGE_PARAMETER = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"

export interface OverlayBuildScriptOptions {
	bucket: string
	image: string
	tilesetVersion: string
	/**
	 * The row sets the run builds, as `tiles overlays --rowsets` takes them.
	 */
	rowSets: readonly string[]
	hours: number
	countries?: readonly string[]
	/**
	 * Builds both archives and prints their publish targets in place of the upload.
	 */
	skipPublish: boolean
}

/**
 * Quotes one value for a POSIX shell.
 */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`
}

/**
 * The key of a build's log in the inputs bucket, by tile set version and instance id.
 */
export function overlayBuildLogKey(tilesetVersion: string, instanceID: string): string {
	return `${OVERLAY_BUILD_PREFIX}/logs/${tilesetVersion}-${instanceID}.log`
}

/**
 * The boot script of a build instance.
 *
 * 1. It schedules a halt at the deadline before any other step, so a hung step still ends the instance.
 * 2. It formats the instance-store volume and mounts it at `/work`, where Docker keeps its images.
 * 3. It runs the image's `mailwoman tiles overlays` with the R2 keys from Parameter Store.
 * 4. On any exit it uploads its log to the inputs bucket and halts.
 *
 * The instance launches with a shutdown behavior of `terminate`, so each halt terminates it.
 */
export function overlayBuildScript(options: OverlayBuildScriptOptions): string {
	const region = AWS_BUILD_REGION
	const s3 = (key: string) => shellQuote(`s3://${options.bucket}/${key}`)
	// The instance id is known only on the instance, so the shell appends it to the quoted prefix.
	const logURL = `${s3(`${OVERLAY_BUILD_PREFIX}/logs/${options.tilesetVersion}-`)}"$instance".log`

	const runArgs = [
		"--tileset-version",
		shellQuote(options.tilesetVersion),
		"--rowsets",
		shellQuote(options.rowSets.join(",")),
		"--repos-cache",
		s3(`${OVERLAY_BUILD_PREFIX}/wof-repos/`),
		"--export-copy",
		s3(`${OVERLAY_BUILD_PREFIX}/exports/${options.tilesetVersion}/`),
		...(options.countries?.length ? ["--countries", shellQuote(options.countries.join(","))] : []),
		...(options.skipPublish ? ["--dry-run"] : []),
	]

	const parameter = (name: string) =>
		`"$(aws ssm get-parameter --with-decryption --region ${region} --name ${shellQuote(`${AWS_BUILD_PARAMETER_PATH}/${name}`)} --query Parameter.Value --output text)"`

	return [
		"#!/bin/bash",
		`shutdown -h +${Math.round(options.hours * 60)}`,
		"set -euo pipefail",
		"exec > >(tee -a /var/log/overlay-build.log) 2>&1",
		`token=$(curl -sfX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')`,
		`instance=$(curl -sf -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-id)`,
		"finish() {",
		"  status=$?",
		'  echo "EXIT=$status $(date -u +%FT%TZ)"',
		`  aws s3 cp --only-show-errors --region ${region} /var/log/overlay-build.log ${logURL} || true`,
		"  shutdown -h now",
		"}",
		"trap finish EXIT",
		'echo "START $(date -u +%FT%TZ) $instance"',
		"device=$(lsblk -dpno NAME,MODEL | awk '/Instance Storage/ {print $1; exit}')",
		'test -n "$device"',
		'mkfs.xfs -f "$device"',
		"mkdir -p /work",
		'mount "$device" /work',
		"mkdir -p /work/docker /work/run /etc/docker",
		"dnf install -y docker",
		`echo '{"data-root":"/work/docker"}' > /etc/docker/daemon.json`,
		"systemctl start docker",
		`docker pull ${shellQuote(options.image)}`,
		[
			"docker run --rm -v /work/run:/work",
			`-e AWS_REGION=${region}`,
			`-e RCLONE_S3_ENDPOINT=${parameter(OVERLAY_BUILD_PARAMETERS.endpoint)}`,
			`-e RCLONE_S3_ACCESS_KEY_ID=${parameter(OVERLAY_BUILD_PARAMETERS.accessKeyID)}`,
			`-e RCLONE_S3_SECRET_ACCESS_KEY=${parameter(OVERLAY_BUILD_PARAMETERS.secretAccessKey)}`,
			shellQuote(options.image),
			...runArgs,
		].join(" \\\n  "),
		"",
	].join("\n")
}
