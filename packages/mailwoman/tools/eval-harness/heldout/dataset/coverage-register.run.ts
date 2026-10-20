/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the committed evaluation coverage register for one dataset version: markdown under
 *   `docs/engineering/reference/` and the same rows as JSON beside it.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/coverage-register.run.ts \
 *     --dataset <dataset manifest .json> \
 *     [--spec packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v1.json] \
 *     [--provenance <overlap audit .json>] [--verdict <verdict .json>] \
 *     [--out docs/engineering/reference/evaluation-coverage.mdx] [--json docs/engineering/reference/evaluation-coverage.json]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import {
	buildCoverageRegister,
	renderCoverageRegisterMarkdown,
} from "#tools/eval-harness/heldout/dataset/coverage-register"
import { readHeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"
import type { ProvenanceRecord } from "#tools/eval-harness/heldout/per/country"
import type { ReleaseVerdict } from "#tools/eval-harness/release/evaluate"
import { readReleaseSpec } from "#tools/eval-harness/release/requirements"

const { values } = parseArguments({
	options: {
		dataset: { type: "string", description: "The held-out dataset manifest" },
		spec: {
			type: "string",
			default: "packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v1.json",
			description: "The release-requirement specification",
		},
		provenance: {
			type: "string",
			description: "The overlap audit's provenance file",
		},
		verdict: {
			type: "string",
			description: "The release evaluator's verdict for this specification",
		},
		out: {
			type: "string",
			default: "docs/engineering/reference/evaluation-coverage.mdx",
			description: "Where to write the markdown page",
		},
		json: {
			type: "string",
			default: "docs/engineering/reference/evaluation-coverage.json",
			description: "Where to write the register JSON",
		},
	},
})

if (!values.dataset) throw new Error("--dataset is required")

let provenance: {
	source: string
	rows: Record<string, ProvenanceRecord>
} | null = null

if (values.provenance) {
	const file = await readLocalJSONFile<{
		rows?: Record<string, ProvenanceRecord>
		auditSHA256?: string
	}>(values.provenance)

	if (!file.rows) throw new Error(`${values.provenance} holds no rows object`)

	provenance = {
		source: `${values.provenance}${file.auditSHA256 ? ` (audit ${file.auditSHA256.slice(0, 16)})` : ""}`,
		rows: file.rows,
	}
}

const register = buildCoverageRegister({
	dataset: await readHeldoutDatasetManifest(values.dataset),
	spec: await readReleaseSpec(repoRootPath(values.spec)),
	provenance,
	verdict: values.verdict ? await readLocalJSONFile<ReleaseVerdict>(values.verdict) : null,
})

const command = [
	"node packages/mailwoman/tools/eval-harness/heldout/dataset/coverage-register.run.ts",
	`--dataset ${values.dataset}`,
	`--spec ${values.spec}`,
	...(values.provenance ? [`--provenance ${values.provenance}`] : []),
	...(values.verdict ? [`--verdict ${values.verdict}`] : []),
].join(" \\\n  ")

await writeLocalTextFile(renderCoverageRegisterMarkdown(register, command), repoRootPath(values.out))
await writeLocalJSONFile(register, repoRootPath(values.json))

console.log(`${register.rows.length} countries written to ${values.out} and ${values.json}`)
