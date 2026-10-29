/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes `data/label-schema.v1.json` from the TypeScript label constants, the semantic tag registry and the committed
 *   address-system registry, and formats it with oxfmt.
 *
 *   With `--check`, the tool only reads the committed file. It exits non-zero when that file's content differs from
 *   the constants.
 *
 *   Usage: `node packages/neural/tools/emit-label-schema.run.ts [--check]`
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { buildLabelSchema, type LabelSchema } from "#label-schema"
import { readAddressSystemsReference } from "#tools/address-system-registry"

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })

const target = workspacePath("neural", "data", "label-schema.v1.json")
const schema = buildLabelSchema(await readAddressSystemsReference())

if (values.check) {
	const committed = await readLocalJSONFile<LabelSchema>(target)

	// Both sides go through one serializer, so oxfmt's layout of the committed file does not affect the comparison.
	if (prettyJSON(committed) === prettyJSON(schema)) {
		console.log(`${target} matches the label constants`)
	} else {
		console.error(`${target} differs from the label constants; rerun without --check`)

		process.exitCode = 1
	}
} else {
	await writeLocalJSONFile(schema, target)
	await runFile("yarn", ["oxfmt", target], { cwd: repoRootPath() })

	console.log(`wrote ${target}`)
}
