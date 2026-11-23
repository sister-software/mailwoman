// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Chooses the validation groups of the evaluation-group policy (HOLDOUT_AND_EVALUATION section 4.6)
 *   from a corpus manifest's held-out pool, by a per-country quota, and writes the list `resplit.run.ts
 *   --validation-groups` reads.
 *
 *   Each country's target is `min(cap, max(margin × floor, minimum))` rows, and `min(cap, margin × street
 *   floor)` street rows, the floors being the `val` entries of the config's `required_validation_coverage`.
 *   Groups are taken lowest `hashUint32` first. A country whose pool is under its target keeps the pool,
 *   and the run lists it.
 *
 *   A group one of the config's training receipts requires stays in
 *   train (`tools/training/audits/required-groups`).
 *   The file records the skip under `requiredTrainingGroups`, and the run prints it by country.
 *
 *   Usage:
 *     node packages/mailwoman/tools/dev-tools/corpus/validation/quota.run.ts \
 *       --manifest <overlay>/MANIFEST.json --config <training config .yaml> \
 *       --evaluation-groups packages/corpus/data/holdout/evaluation-groups.v0.8.18.json \
 *       --out <VALIDATION_GROUPS.json> [--margin 2] [--minimum-rows 200] [--cap-rows 20000]
 *
 *   The read is one DuckDB pass over each file's id, country and span-tag columns.
 */

import { sha256File } from "@mailwoman/core/crypto/hash"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { evaluationGroupsIdentity, readEvaluationGroups } from "@mailwoman/corpus/utils/evaluation-groups"
import {
	DEFAULT_VALIDATION_QUOTA,
	selectValidationGroups,
	VALIDATION_GROUPS_ATTRIBUTE,
	type ValidationGroupsFile,
	type ValidationQuota,
	validationTarget,
} from "@mailwoman/corpus/utils/validation-groups"

import { readValidationPool, validationFloorsFromConfig } from "#tools/dev-tools/corpus/validation/quota"
import { describeRequiredGroupSkip, readRequiredTrainingGroups } from "#tools/training/audits/required-groups"
import { loadTrainingConfig } from "#tools/training/config"

const { values } = parseArguments({
	options: {
		manifest: { type: "string", description: "The corpus MANIFEST.json whose held-out pool is read" },
		config: { type: "string", description: "The training config whose validation floors set the targets" },
		"evaluation-groups": { type: "string", description: "The frozen evaluation-group list the pool excludes" },
		out: { type: "string", description: "Where to write the validation-group list" },
		margin: { type: "string", default: String(DEFAULT_VALIDATION_QUOTA.margin) },
		"minimum-rows": { type: "string", default: String(DEFAULT_VALIDATION_QUOTA.minimumRows) },
		"cap-rows": { type: "string", default: String(DEFAULT_VALIDATION_QUOTA.capRows) },
	},
})

if (!values.manifest || !values.config || !values["evaluation-groups"] || !values.out) {
	throw new Error("--manifest, --config, --evaluation-groups and --out are required")
}

const positive = (flag: string, value: string | undefined) => {
	const parsed = Number(value)

	if (!(Number.isFinite(parsed) && parsed > 0)) throw new Error(`--${flag} takes a positive number; received ${value}`)

	return parsed
}

const quota: ValidationQuota = {
	margin: positive("margin", values.margin),
	minimumRows: Math.ceil(positive("minimum-rows", values["minimum-rows"])),
	capRows: Math.ceil(positive("cap-rows", values["cap-rows"])),
}

const frozen = await readEvaluationGroups(values["evaluation-groups"])
const config = await loadTrainingConfig(values.config)
const floors = validationFloorsFromConfig(config)
const required = await readRequiredTrainingGroups(config)

const { candidates, totals, files, skipped } = await readValidationPool({
	manifest: values.manifest,
	frozen,
	capRows: quota.capRows,
	required,
	onProgress: (read, all) => {
		if (read % 100 === 0 || read === all) {
			console.error(`validation quota: ${read}/${all} files`)
		}
	},
})

const selected = selectValidationGroups(candidates, (country) => validationTarget(floors.get(country), quota), quota)

// The selection saw only the head of each pool, so the pool figures are the census's.
for (const [country, selection] of Object.entries(selected.countries)) {
	const total = totals.get(country)!

	selection.poolRows = total.rows
	selection.poolGroups = total.groups
}

const manifest = await readLocalJSONFile<{ corpus_version?: unknown }>(values.manifest)

const file: ValidationGroupsFile = {
	attribute: VALIDATION_GROUPS_ATTRIBUTE,
	drawnFrom: {
		manifest: values.manifest,
		sha256: await sha256File(values.manifest),
		corpusVersion: typeof manifest.corpus_version === "string" ? manifest.corpus_version : null,
	},
	config: { path: values.config, sha256: await sha256File(values.config) },
	evaluationGroups: evaluationGroupsIdentity(frozen),
	...(skipped ? { requiredTrainingGroups: skipped } : {}),
	quota,
	countries: selected.countries,
	groups: selected.groups,
}

await writeLocalJSONFile(file, values.out)

const exhausted = Object.entries(selected.countries).filter(([, selection]) => selection.exhausted)
const rows = Object.values(selected.countries).reduce((sum, selection) => sum + selection.rows, 0)

console.log(
	`${values.out}: ${selected.groups.length} groups, ${rows} rows in ${Object.keys(selected.countries).length} countries ` +
		`from ${files} files`
)

if (skipped) {
	for (const line of describeRequiredGroupSkip(skipped)) {
		console.log(line)
	}
}

for (const [country, selection] of exhausted) {
	console.log(
		`  ${country}: pool of ${selection.rows} rows (${selection.streetRows} street) is under its target of ` +
			`${selection.target.rows} (${selection.target.streetRows} street); it keeps the whole pool`
	)
}
