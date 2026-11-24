// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `release.launch-overlay-build`: run the overlay tile build on one EC2 instance under the tile-build key.
 *
 *   The launch stages the admin database in the inputs bucket, writes the R2 upload
 *   keys to Parameter Store, starts a tagged instance whose boot script runs the image,
 *   and sets the instance's termination deadline.
 *   Two deadlines end the instance: the boot script's own halt timer, and an EventBridge
 *   Scheduler schedule that terminates it from outside.
 *
 *   A launch whose schedule fails terminates the instance it started.
 */

import { md5File } from "@mailwoman/core/crypto/hash"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writePrivateTextFile } from "@mailwoman/core/fs/writers"
import { gitHead } from "@mailwoman/core/repo/git"
import { OperationEffect } from "@mailwoman/core/scripting"
import { isProcessError } from "@mailwoman/core/scripting/process"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { z } from "zod"

import { aws, type AWSCaller, callerIdentity, tileBuildKey } from "#release-kit/deploy/aws/cli"
import {
	AWS_BUILD_PARAMETER_PATH,
	AWS_BUILD_TAG,
	AWS_INSTANCE_ROLE_NAME,
	AWS_SCHEDULE_PREFIX,
	AWS_SCHEDULER_ROLE_NAME,
	awsInputsBucket,
} from "#release-kit/deploy/aws/credentials"
import {
	OVERLAY_BUILD_DEFAULT_HOURS,
	OVERLAY_BUILD_IMAGE,
	OVERLAY_BUILD_IMAGE_PARAMETER,
	OVERLAY_BUILD_INSTANCE_TYPE,
	OVERLAY_BUILD_PARAMETERS,
	OVERLAY_BUILD_PREFIX,
	overlayBuildLogKey,
	overlayBuildScript,
} from "#release-kit/deploy/overlay-build"
import { defineOperation } from "#release-kit/operation"
import { flag, list, text } from "#release-kit/operations/inputs"

/**
 * The admin database file a launch stages unless the caller names another.
 */
const DEFAULT_ADMIN_FILE = "admin-global-priority.db"

/**
 * The size of the instance's root volume.
 *
 * It holds the operating system and Docker's packages.
 * The image and the build run on the instance-store volume.
 */
const ROOT_VOLUME_GB = 30

/**
 * Whether an object exists in the inputs bucket.
 *
 * A missing object is a 404.
 * Any other failure, such as a refused permission, is thrown.
 */
async function objectExists(caller: AWSCaller, bucket: string, key: string): Promise<boolean> {
	try {
		await aws(caller, ["s3api", "head-object", "--bucket", bucket, "--key", key])

		return true
	} catch (error) {
		if (isProcessError(error) && /\b404\b|Not Found/u.test(String(error.stderr))) return false

		throw error
	}
}

/**
 * The R2 upload settings from the environment.
 * The launch copies them to Parameter Store.
 */
async function r2Settings(): Promise<Record<keyof typeof OVERLAY_BUILD_PARAMETERS, string>> {
	const { $private } = await import("mailwoman/env")

	const settings = {
		endpoint: $private.RCLONE_S3_PUBLIC_ENDPOINT,
		accessKeyID: $private.RCLONE_S3_PUBLIC_ACCESS_KEY_ID,
		secretAccessKey: $private.RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY,
	}

	const missing = Object.entries(settings).filter(([, value]) => !value)

	if (missing.length) {
		throw new Error(
			"launch-overlay-build needs RCLONE_S3_PUBLIC_ENDPOINT, RCLONE_S3_PUBLIC_ACCESS_KEY_ID and RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY, the keys that write mailwoman-tiles"
		)
	}

	return settings as Record<keyof typeof OVERLAY_BUILD_PARAMETERS, string>
}

/**
 * An EventBridge Scheduler `at()` expression for a UTC instant, to the second.
 */
function atExpression(instant: Date): string {
	return `at(${instant.toISOString().slice(0, 19)})`
}

const launchReport = z.object({
	instanceID: z.string().nullable(),
	instanceType: z.string(),
	image: z.string(),
	deadline: z.string(),
	schedule: z.string().nullable(),
	adminKey: z.string(),
	adminUploaded: z.boolean(),
	logURL: z.string().nullable(),
	tileSets: z.array(z.string()),
})

/**
 * `release.launch-overlay-build`: start one overlay tile build on EC2 with a termination deadline.
 */
export const launchOverlayBuild = defineOperation({
	id: "release.launch-overlay-build",
	description: `Run the overlay tile build on one tagged EC2 instance under the tile-build key (AWS_TILE_BUILD_*). Stages the admin database (--admin, default the data root's ${DEFAULT_ADMIN_FILE}) in the inputs bucket, copies the R2 upload keys to Parameter Store, and starts the image (--image, default ${OVERLAY_BUILD_IMAGE}:<HEAD>) on --instance-type (default ${OVERLAY_BUILD_INSTANCE_TYPE}). The instance terminates when the build exits, and in any case after --hours (default ${OVERLAY_BUILD_DEFAULT_HOURS}): its own halt timer and an EventBridge schedule both enforce the deadline. --tileset-version names the published tile sets. --countries limits the build, and --skip-publish builds without uploading. --dry-run prints the boot script and changes nothing.`,
	effect: OperationEffect.ExternalWrite,
	options: {
		"tileset-version": { type: "string" },
		image: { type: "string" },
		"instance-type": { type: "string" },
		hours: { type: "string" },
		admin: { type: "string" },
		countries: { type: "string" },
		"skip-publish": { type: "boolean" },
	},
	inputSchema: z
		.object({
			"tileset-version": z.string({ error: "--tileset-version is required, such as v1" }),
			image: text,
			"instance-type": text,
			hours: z.coerce.number().positive().max(48).optional(),
			admin: text,
			countries: list,
			"skip-publish": flag,
		})
		.strict(),
	outputSchema: launchReport,
	async run(input, context) {
		const key = tileBuildKey()

		if (!key)
			throw new Error("launch-overlay-build needs AWS_TILE_BUILD_ACCESS_KEY_ID and AWS_TILE_BUILD_SECRET_ACCESS_KEY")

		const caller: AWSCaller = { key }
		const { Account: accountID } = await callerIdentity(caller)
		const bucket = awsInputsBucket(accountID)
		const tilesetVersion = input["tileset-version"]
		const image = input.image ?? `${OVERLAY_BUILD_IMAGE}:${await gitHead(undefined, { short: true })}`
		const instanceType = input["instance-type"] ?? OVERLAY_BUILD_INSTANCE_TYPE
		const hours = input.hours ?? OVERLAY_BUILD_DEFAULT_HOURS
		const adminPath = input.admin ?? wofDatabasePath(DEFAULT_ADMIN_FILE).toString()

		context.log(`hashing ${adminPath}`)

		const adminKey = `${OVERLAY_BUILD_PREFIX}/inputs/admin-${await md5File(adminPath)}.db`
		const adminStaged = await objectExists(caller, bucket, adminKey)

		const script = overlayBuildScript({
			bucket,
			image,
			tilesetVersion,
			adminKey,
			hours,
			countries: input.countries,
			skipPublish: input["skip-publish"],
		})

		const deadline = new Date(Date.now() + hours * 3_600_000)

		const tileSets = ["wof", "gazetteer"].map(
			(rowSet) => `https://tiles.mailwoman.post/${rowSet}.${tilesetVersion}.json`
		)

		const report = {
			instanceType,
			image,
			deadline: deadline.toISOString(),
			adminKey: `s3://${bucket}/${adminKey}`,
			tileSets: input["skip-publish"] ? [] : tileSets,
		}

		if (context.dryRun) {
			context.log(`would ${adminStaged ? "reuse" : "upload"} s3://${bucket}/${adminKey}`)

			context.log(
				`would write ${Object.keys(OVERLAY_BUILD_PARAMETERS).length} parameters under ${AWS_BUILD_PARAMETER_PATH}`
			)

			context.log(`would launch ${instanceType} with this boot script:\n${script}`)

			return { ...report, instanceID: null, schedule: null, adminUploaded: false, logURL: null }
		}

		if (!adminStaged) {
			context.log(`uploading ${adminPath} to s3://${bucket}/${adminKey}`)
			await aws(caller, ["s3", "cp", "--only-show-errors", adminPath, `s3://${bucket}/${adminKey}`])
		}

		await using scratch = await temporaryDirectory("overlay-build-")

		const settings = await r2Settings()

		for (const [field, name] of Object.entries(OVERLAY_BUILD_PARAMETERS)) {
			// The value goes through a file so it never appears on a command line.
			const valueFile = scratch.path(`${name}.txt`)

			await writePrivateTextFile(settings[field as keyof typeof settings], valueFile)

			await aws(caller, [
				"ssm",
				"put-parameter",
				"--name",
				`${AWS_BUILD_PARAMETER_PATH}/${name}`,
				"--type",
				"SecureString",
				"--overwrite",
				"--value",
				`file://${valueFile}`,
			])
		}

		context.log(`wrote ${Object.keys(OVERLAY_BUILD_PARAMETERS).length} parameters under ${AWS_BUILD_PARAMETER_PATH}`)

		const machineImage = await aws<{ Parameter: { Value: string } }>(caller, [
			"ssm",
			"get-parameter",
			"--name",
			OVERLAY_BUILD_IMAGE_PARAMETER,
		])

		if (!machineImage) throw new Error(`${OVERLAY_BUILD_IMAGE_PARAMETER} returned no image id`)

		const scriptFile = scratch.path("user-data.sh")

		await writePrivateTextFile(script, scriptFile)

		const tags = [
			{ Key: AWS_BUILD_TAG.key, Value: AWS_BUILD_TAG.value },
			{ Key: "Name", Value: `overlay-tiles-${tilesetVersion}` },
			{ Key: "mailwoman:deadline", Value: deadline.toISOString() },
		]

		const launched = await aws<{ Instances: Array<{ InstanceId: string }> }>(caller, [
			"ec2",
			"run-instances",
			"--image-id",
			machineImage.Parameter.Value,
			"--instance-type",
			instanceType,
			"--count",
			"1",
			"--iam-instance-profile",
			`Name=${AWS_INSTANCE_ROLE_NAME}`,
			"--instance-initiated-shutdown-behavior",
			"terminate",
			"--metadata-options",
			// The container reaches the metadata service through Docker's bridge, one hop past the host.
			"HttpTokens=required,HttpPutResponseHopLimit=2",
			"--block-device-mappings",
			stringifyJSON([
				{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: ROOT_VOLUME_GB, VolumeType: "gp3", DeleteOnTermination: true } },
			]),
			"--tag-specifications",
			stringifyJSON([
				{ ResourceType: "instance", Tags: tags },
				{ ResourceType: "volume", Tags: tags },
			]),
			"--user-data",
			`file://${scriptFile}`,
		])

		const instanceID = launched?.Instances[0]?.InstanceId

		if (!instanceID) throw new Error("run-instances returned no instance id")

		context.log(`launched ${instanceID} (${instanceType})`)

		const schedule = `${AWS_SCHEDULE_PREFIX}${instanceID}`

		try {
			await aws(caller, [
				"scheduler",
				"create-schedule",
				"--name",
				schedule,
				"--schedule-expression",
				atExpression(deadline),
				"--schedule-expression-timezone",
				"UTC",
				"--flexible-time-window",
				"Mode=OFF",
				"--action-after-completion",
				"DELETE",
				"--target",
				stringifyJSON({
					Arn: "arn:aws:scheduler:::aws-sdk:ec2:terminateInstances",
					RoleArn: `arn:aws:iam::${accountID}:role/${AWS_SCHEDULER_ROLE_NAME}`,
					Input: stringifyJSON({ InstanceIds: [instanceID] }),
				}),
			])
		} catch (error) {
			// An instance without its outside deadline is terminated now, rather than left to its own timer.
			await aws(caller, ["ec2", "terminate-instances", "--instance-ids", instanceID])

			throw new Error(
				`the deadline schedule failed, so ${instanceID} was terminated: ${String(isProcessError(error) ? error.stderr : error)}`
			)
		}

		context.log(`scheduled ${schedule} to terminate ${instanceID} at ${deadline.toISOString()}`)

		return {
			...report,
			instanceID,
			schedule,
			adminUploaded: !adminStaged,
			logURL: `s3://${bucket}/${overlayBuildLogKey(tilesetVersion, instanceID)}`,
		}
	},
	formatOutput(report) {
		return [
			report.instanceID ? `instance ${report.instanceID} (${report.instanceType})` : `dry run: ${report.instanceType}`,
			`image ${report.image}`,
			`admin database ${report.adminKey}${report.adminUploaded ? " (uploaded)" : ""}`,
			`terminates by ${report.deadline}${report.schedule ? ` (schedule ${report.schedule})` : ""}`,
			...(report.logURL ? [`log, written when the build exits: ${report.logURL}`] : []),
			...(report.tileSets.length ? ["tile sets:", ...report.tileSets.map((url) => `  ${url}`)] : []),
		].join("\n")
	},
})
