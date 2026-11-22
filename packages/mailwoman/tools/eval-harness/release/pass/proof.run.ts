// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Proves the release evaluator can return `pass` on a frozen collection's groups (`release/pass/proof`),
 *   the step to run before any re-split that a training run will be graded against.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/release/pass/proof.run.ts \
 *     --datasets <collection manifest .json>,... --provenance <overlap audit provenance .json>,... \
 *     [--spec <spec .json>] [--role confirmation] [--seed 1] [--assume-provenance <class>] [--out <report .json>]
 *
 *   It reads each manifest's row entries and the audits' provenance classes,
 *   and no rows file: no label is read and no model is scored.
 *   `--spec` defaults to the current specification.
 *
 *   `--role` is the evaluation role the collections are for, and the run reports
 *   any pin of that role the collections don't match.
 *   A role's pins are set after its collections are frozen, so a mismatch is reported
 *   rather than counted against the proof.
 *
 *   `--assume-provenance` classes the rows no audit classes.
 *   Without it they read `unknown`.
 *
 *   Exits 1 unless the arm above the published rate passes and the arm at it doesn't.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { readHeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"
import type { HeldoutProvenance } from "#tools/eval-harness/heldout/per/country"
import { readProvenanceHistory } from "#tools/eval-harness/heldout/per/provenance-history"
import { CURRENT_RELEASE_SPEC } from "#tools/eval-harness/release/current-spec"
import { runPassProof } from "#tools/eval-harness/release/pass/proof"
import {
	EVALUATION_ROLES,
	type EvaluationRole,
	HELDOUT_PROVENANCE_CLASSES,
	readReleaseSpec,
} from "#tools/eval-harness/release/requirements"

const { values } = parseArguments({
	options: {
		datasets: { type: "string", description: "Frozen collection manifests, comma-separated" },
		provenance: { type: "string", description: "Overlap-audit provenance files, comma-separated" },
		spec: { type: "string", description: "The release-requirement specification; defaults to the current one" },
		role: { type: "string", default: "confirmation", description: "The evaluation role the collections are for" },
		seed: { type: "string", default: "1", description: "Mixed into each row's synthetic outcome hash" },
		"assume-provenance": {
			type: "string",
			description: "The provenance class of a row no audit classes; otherwise unknown",
		},
		out: { type: "string", description: "Where to write the report" },
	},
})

const list = (value: string | undefined) =>
	(value ?? "")
		.split(",")
		.map((path) => path.trim())
		.filter((path) => path.length > 0)

const datasets = list(values.datasets)

if (!datasets.length) throw new Error("--datasets is required")

const role = values.role as EvaluationRole

if (!EVALUATION_ROLES.includes(role)) throw new Error(`--role is one of ${EVALUATION_ROLES.join(", ")}`)

const fallback = (values["assume-provenance"] ?? "unknown") as HeldoutProvenance

if (!HELDOUT_PROVENANCE_CLASSES.includes(fallback)) {
	throw new Error(`--assume-provenance is one of ${HELDOUT_PROVENANCE_CLASSES.join(", ")}`)
}

const seed = Number(values.seed)

if (!Number.isSafeInteger(seed)) throw new Error(`--seed ${values.seed} is not an integer`)

const spec = await readReleaseSpec(values.spec ?? CURRENT_RELEASE_SPEC)
const manifests = await Promise.all(datasets.map((path) => readHeldoutDatasetManifest(path)))
const history = await readProvenanceHistory(list(values.provenance))

const ids = manifests.map((manifest) => `${manifest.datasetID}@${manifest.version}`)
const pinned = spec.evaluations[role].ids

const pinReasons = [
	...pinned.filter((id) => !ids.includes(id)).map((id) => `the ${role} role pins ${id}, which no given manifest is`),
	...ids.filter((id) => !pinned.includes(id)).map((id) => `${id} isn't pinned to the ${role} role`),
]

const report = runPassProof({
	spec,
	entries: manifests.flatMap((manifest) => manifest.rows),
	history,
	seed,
	fallback,
})

const classes = new Map<string, number>()

for (const manifest of manifests) {
	for (const row of manifest.rows) {
		const provenance = history.get(row.rowID)?.provenance ?? fallback

		classes.set(provenance, (classes.get(provenance) ?? 0) + 1)
	}
}

console.log(`pass proof under spec ${report.specVersion}: ${report.proven ? "proven" : "not proven"}`)
console.log(`collections: ${ids.join(", ")}; ${report.rows} rows in ${report.groups} groups`)
console.log(`provenance: ${[...classes].map(([provenance, rows]) => `${provenance} ${rows}`).join(", ")}`)

for (const reason of pinReasons) {
	console.log(`  pin: ${reason}`)
}

if (report.tagSelectorsDropped.length) {
	console.log(
		`  read without their tag selector, an upper bound on their rows: ${report.tagSelectorsDropped.join(", ")}`
	)
}

const show = (value: number | null) => (value == null ? "n/a" : value.toFixed(4))

for (const { arm, verdict, expected, met } of report.arms) {
	console.log(
		`\n${arm.label} (published ${arm.published}, candidate ${arm.candidate}): ${verdict.outcome}, ` +
			`expected ${expected}${met ? "" : " — NOT MET"}`
	)

	for (const reason of verdict.reasons) {
		console.log(`  ${reason}`)
	}

	console.log(["check", "kind", "rows", "groups", "estimate", "lower", "upper", "threshold", "outcome"].join("\t"))

	for (const check of verdict.checks) {
		console.log(
			[
				check.id,
				check.check,
				check.rows,
				check.groups,
				show(check.estimate),
				show(check.lower),
				show(check.upper),
				show(check.threshold),
				`${check.outcome}${check.reasons.length ? ` (${check.reasons.join("; ")})` : ""}`,
			].join("\t")
		)
	}
}

if (values.out) {
	await writeLocalJSONFile({ datasets, role, pinReasons, provenance: list(values.provenance), ...report }, values.out)
}

if (!report.proven) {
	process.exitCode = 1
}
