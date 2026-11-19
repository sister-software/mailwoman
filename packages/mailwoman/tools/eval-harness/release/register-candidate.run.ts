// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes the specification version that registers a release candidate: a copy of `--spec`
 *   (the current specification by default) with `identities.candidate` set to the sha256 of `--model`
 *   and `--description`, the version raised by one, and `--rationale` as the rationale.
 *
 *   The record is validated and written to the committed path of its own version.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/release/register-candidate.run.ts \
 *     --model <the exact model.onnx that ships> --description <artifact> \
 *     --rationale <why, and every read of the source version> [--spec <source spec .json>] [--spec-version <n>]
 *
 *   An existing file at that path is refused, because a specification is never amended in place.
 *   A change that makes the new version current also moves `release/current-spec.ts`.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"

import { CURRENT_RELEASE_SPEC, releaseSpecPath } from "#tools/eval-harness/release/current-spec"
import { deriveCandidateSpec } from "#tools/eval-harness/release/register-candidate"
import { readReleaseSpec } from "#tools/eval-harness/release/requirements"

const SCOPE = "register-candidate"

const { values } = parseArguments({
	options: {
		spec: { type: "string", default: CURRENT_RELEASE_SPEC, description: "The source specification" },
		model: { type: "string", description: "The exact model.onnx that will ship" },
		description: { type: "string", description: "Which artifact the digest names" },
		rationale: { type: "string", description: "Why the version exists, and every read of the source version" },
		"spec-version": { type: "string", description: "The new version; one more than the source's when omitted" },
	},
})

const model = requiredArgument(SCOPE, "model", values.model)
const source = await readReleaseSpec(values.spec)

const derived = deriveCandidateSpec(source, {
	candidate: {
		description: requiredArgument(SCOPE, "description", values.description),
		sha256: await sha256File(model),
	},
	rationale: requiredArgument(SCOPE, "rationale", values.rationale),
	...(values["spec-version"] ? { specVersion: values["spec-version"] } : {}),
})

const out = releaseSpecPath(derived.specVersion)

// The core writers hold no exclusive-create write, so the check precedes the write.
if (await pathExists(out)) {
	throw new Error(`${out} exists: a specification is never amended in place`)
}

await writeLocalJSONFile(derived, out)

console.log(
	`spec ${derived.specVersion} from ${source.specVersion}: candidate ${derived.identities.candidate.sha256} (${model})`
)
console.log(`wrote ${out}`)
