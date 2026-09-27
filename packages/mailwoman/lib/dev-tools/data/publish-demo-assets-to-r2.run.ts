/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Usage: node packages/mailwoman/lib/dev-tools/data/publish-demo-assets-to-r2.run.ts --src <staged-dir>
 *   [--bucket nexus-public] [--prefix mailwoman] [--dry-run]
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { formatDemoAssetPublishResult, publishDemoAssets } from "#release-tools/publish-demo-assets"

const { values } = parseArguments({
	options: {
		src: { type: "string", description: "Staged asset directory mirroring the R2 layout below the prefix" },
		bucket: { type: "string", default: "nexus-public", description: "R2 bucket" },
		prefix: { type: "string", default: "mailwoman", description: "R2 key prefix" },
		"dry-run": { type: "boolean", default: false, description: "Validate and print objects without uploading" },
	},
})

if (!values.src) throw new Error("missing required option --src <staged-dir>")

const result = await publishDemoAssets({
	src: values.src,
	bucket: values.bucket,
	prefix: values.prefix,
	dryRun: values["dry-run"],
	onObject: console.log,
})

console.log(formatDemoAssetPublishResult(result, values["dry-run"]))
