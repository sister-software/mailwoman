// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes the specification version that registers a release candidate: a copy of `--spec`
 *   with `identities.candidate` set to the sha256 of `--model` and `--description`,
 *   the version raised by one, and `--rationale` opening the rationale.
 *   The record is validated before it's written.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/release/register-candidate.run.ts \
 *     --spec <source spec .json> --model <the exact model.onnx that ships> --description <artifact> \
 *     --rationale <why, and every read of the source version> --out <new spec .json> [--spec-version <n>]
 *
 *   An existing `--out` is refused, because a specification is never amended in place.
 *   A change that makes the new version current also moves `release/current-spec.ts`.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"

import { deriveCandidateSpec } from "#tools/eval-harness/release/register-candidate"
import { readReleaseSpec } from "#tools/eval-harness/release/requirements"

const SCOPE = "register-candidate"

const { values } = parseArguments({
	options: {
		spec: { type: "string", description: "The source specification" },
		model: { type: "string", description: "The exact model.onnx that will ship" },
		description: { type: "string", description: "Which artifact the digest names" },
		rationale: { type: "string", description: "Why the version exists, and every read of the source version" },
		"spec-version": { type: "string", description: "The new version; one more than the source's when omitted" },
		out: { type: "string", description: "Where to write the new specification" },
	},
})

const out = requiredArgument(SCOPE, "out", values.out)
const model = requiredArgument(SCOPE, "model", values.model)

if (await pathExists(out)) {
	throw new Error(`${out} exists: a specification is never amended in place`)
}

const source = await readReleaseSpec(requiredArgument(SCOPE, "spec", values.spec))
const sha256 = await sha256File(model)

const derived = deriveCandidateSpec(source, {
	sha256,
	description: requiredArgument(SCOPE, "description", values.description),
	rationale: requiredArgument(SCOPE, "rationale", values.rationale),
	...(values["spec-version"] ? { specVersion: values["spec-version"] } : {}),
})

await writeLocalJSONFile(derived, out)

console.log(`spec ${derived.specVersion} from ${source.specVersion}: candidate ${sha256} (${model})`)
console.log(`wrote ${out}`)
