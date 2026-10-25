/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/data/publish-public-bucket.run.ts --src <staged-dir>
 *   [--bucket mailwoman-public] [--prefix mailwoman] [--dry-run]
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import {
	formatPublicBucketPublishResult,
	publishToPublicBucket,
} from "@mailwoman/gazetteer/tools/publish/public-bucket"

import { $public } from "#env"

const { values } = parseArguments({
	options: {
		src: { type: "string", description: "Staged asset directory mirroring the R2 layout below the prefix" },
		bucket: { type: "string", default: $public.MAILWOMAN_PUBLIC_BUCKET, description: "R2 bucket" },
		prefix: { type: "string", default: "mailwoman", description: "R2 key prefix" },
		"dry-run": { type: "boolean", default: false, description: "Validate and print objects without uploading" },
	},
})

if (!values.src) throw new Error("missing required option --src <staged-dir>")

const result = await publishToPublicBucket({
	src: values.src,
	bucket: values.bucket,
	prefix: values.prefix,
	dryRun: values["dry-run"],
	onObject: console.log,
})

console.log(formatPublicBucketPublishResult(result, values["dry-run"]))
