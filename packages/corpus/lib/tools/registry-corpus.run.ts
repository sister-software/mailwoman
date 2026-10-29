/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Builds the noisy registry corpus for Taiwan (GCIS) or Japan (法人番号), then writes its `SOURCE_RIGHTS.json`.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/registry-corpus.run.ts tw --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-tw-registry-<date>
 *     node packages/corpus/lib/tools/registry-corpus.run.ts jp --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-registry-<date>
 *       [--rows 500000] [--val-fraction 0.02] [--board-rows 20000] [--postcode-fraction 0.3] [--rows-per-part 250000]
 *       [--stats-sample 50000] [--max-row-groups <n>] [--seed 42] [--force] [--unshippable-reason <why>]
 */

import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"

import { buildRegistryCorpus, REGISTRY_LOCALES, type RegistryLocale } from "#cjk/registry"
import { openSourceRightsAdmission, writeSourceRightsRecord } from "#source-register/corpus-inputs"

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		"out-dir": { type: "string" },
		rows: { type: "string", default: "500000" },
		"val-fraction": { type: "string", default: "0.02" },
		"board-rows": { type: "string", default: "20000" },
		"postcode-fraction": { type: "string", default: "0.3" },
		"rows-per-part": { type: "string", default: "250000" },
		"stats-sample": { type: "string", default: "50000" },
		"max-row-groups": { type: "string" },
		seed: { type: "string", default: "42" },
		force: { type: "boolean", default: false },
		"unshippable-reason": { type: "string" },
	},
})

const locales = Object.keys(REGISTRY_LOCALES).toSorted()
const locale = positionals[0]

if (!locale || !locales.includes(locale)) throw new Error(`the first argument names a locale: ${locales.join(", ")}`)

const outDir = requiredArgument("registry-corpus", "--out-dir", values["out-dir"])

const integer = (name: string, value: string): number => {
	const parsed = Number(value)

	if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer, got ${value}`)

	return parsed
}

const admission = await openSourceRightsAdmission({
	context: `${locale} registry build`,
	unshippableReason: values["unshippable-reason"] ?? null,
})

admission.admitAll([REGISTRY_LOCALES[locale as RegistryLocale].source])

const report = await buildRegistryCorpus({
	locale: locale as RegistryLocale,
	outDir,
	rows: integer("rows", values.rows),
	valFraction: Number(values["val-fraction"]),
	boardRows: integer("board-rows", values["board-rows"]),
	postcodeFraction: Number(values["postcode-fraction"]),
	rowsPerPart: integer("rows-per-part", values["rows-per-part"]),
	statsSample: integer("stats-sample", values["stats-sample"]),
	maxRowGroups: values["max-row-groups"] ? integer("max-row-groups", values["max-row-groups"]) : undefined,
	seed: integer("seed", values.seed),
	force: values.force,
})

await writeSourceRightsRecord(admission.record(), outDir)

console.log(
	pythonJSONDumps(new Map([...report].filter(([key]) => key !== "splits")), { indent: 2, ensureASCII: false })
)
