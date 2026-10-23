/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a corpus's support index beside its manifest.
 *
 *   The index counts the train split's tag-set shapes and folded surfaces once, so `mwdev_support`
 *   answers a gauntlet row's corpus support without a scan.
 *
 *   Usage:
 *     node packages/mailwoman/tools/dev-tools/corpus/support-index.run.ts --manifest <MANIFEST.json>
 *     node packages/mailwoman/tools/dev-tools/corpus/support-index.run.ts --manifest <MANIFEST.json> --limit-files 2 --out <dir>
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { buildSupportIndex } from "@mailwoman/corpus/tools/support-index"

const { values: args } = parseArguments({
	options: {
		manifest: { type: "string" },
		out: { type: "string" },
		"limit-files": { type: "string" },
	},
})

if (!args.manifest) {
	throw new Error("--manifest <MANIFEST.json> is required")
}

const limitFiles = args["limit-files"] ? Number(args["limit-files"]) : undefined

if (limitFiles !== undefined && !(Number.isInteger(limitFiles) && limitFiles > 0)) {
	throw new Error(`--limit-files takes a positive integer; received ${stringifyJSON(args["limit-files"])}`)
}

const record = await buildSupportIndex(args.manifest, {
	...(args.out ? { outDir: args.out } : {}),
	...(limitFiles !== undefined ? { limitFiles } : {}),
	log: (line) => console.error(line),
})

console.log(stringifyJSON(record))
