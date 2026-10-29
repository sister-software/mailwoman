/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the OpenStreetMap evaluation suites by address shape from the per-country extracts, filters them to
 *   rows neither compared model trained on, and freezes each as a held-out dataset with its lineage.
 *   `grade.run.ts` beside it grades models on the frozen suites.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/osm-suites/build.run.ts \
 *     --extracts "$MAILWOMAN_DATA_ROOT/db/osm/corpus" --out scratchpad/osm-suites \
 *     --corpus <training MANIFEST.json> --corpus <…> --model-card <model-card.json> \
 *     [--training-config <config .yaml>] [--path-root /mnt/mw] [--per-country 200] [--seed 2868] \
 *     [--countries al,au]
 *
 *   Name each compared model by its `--model-card`, or by its `--training-config` when the card's
 *   `training.corpus_version` is stale. It reads the extracts and writes only under `--out`, which may not lie
 *   under the extract directory.
 */

import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { isoSecondsUTC } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { collectOSMSuiteRows, freezeOSMSuites, type PolicyLookup } from "#tools/eval-harness/osm-suites/build"
import { extractCountryOf } from "#tools/eval-harness/osm-suites/extract"

const { values } = parseArguments({
	options: {
		extracts: { type: "string" },
		out: { type: "string" },
		corpus: { type: "string", multiple: true },
		"model-card": { type: "string", multiple: true },
		"training-config": { type: "string", multiple: true },
		"path-root": { type: "string" },
		"per-country": { type: "string" },
		seed: { type: "string" },
		countries: { type: "string" },
	},
})

if (!values.extracts || !values.out) throw new Error("--extracts <directory> and --out <directory> are required")

const extracts = resolvePath(values.extracts)
const out = resolvePath(values.out)

if (`${out}/`.startsWith(`${extracts}/`))
	throw new Error(`--out ${out} lies under --extracts; the extracts are read only`)

const countries = new Set(
	(values.countries ?? "")
		.split(",")
		.filter((code) => code.length === 2)
		.map((code) => code.toUpperCase())
)

// Only the dated per-country files: `osm-<cc>.corpus.jsonl` and `*.localities.*` were written by other runs.
const files = (await Globerator.files("jsonl", { cwd: extracts, absolute: true, recursive: false }).toSorted()).filter(
	(file) => {
		const country = extractCountryOf(file)

		return country !== null && /-26101\d\.corpus\.jsonl$/u.test(file) && (!countries.size || countries.has(country))
	}
)

if (!files.length) throw new Error(`no osm-<cc>-26101x.corpus.jsonl file under ${extracts}`)

const perCountry = Number(values["per-country"] ?? 200)
const seed = Number(values.seed ?? 2868)

console.error(`[osm-suites] ${files.length} extracts, ${perCountry} rows per country and shape, seed ${seed}`)

const collected = await collectOSMSuiteRows({
	files,
	perCountry,
	seed,
	onFile: (file) =>
		console.error(
			`[osm-suites] ${file.country}: ${file.tally["read"] ?? 0} read; ` +
				Object.entries(file.available)
					.map(([shape, n]) => `${shape} ${n}`)
					.join(", ")
		),
})

// `@mailwoman/osm` is an optional peer, so its policies are read only when it is installed.
const policies = await import("@mailwoman/osm/extraction-policy").catch(() => null)

const policyFor: PolicyLookup = (country) => {
	const policy = policies?.extractionPolicyFor(country)

	return policy ? { name: policies!.extractionPolicyName(policy), version: policy.version } : null
}

await makeDirectories(out)

const frozen = await freezeOSMSuites({
	collected,
	perCountry,
	seed,
	overlap: {
		corpora: values.corpus ?? [],
		modelCards: values["model-card"] ?? [],
		trainingConfigs: values["training-config"] ?? [],
		pathRoot: values["path-root"] ?? "/data",
	},
	outDirectory: out.toString(),
	createdAt: isoSecondsUTC(),
	policyFor,
})

const summary: Record<string, unknown> = {
	extracts: files.length,
	suites: frozen.map((suite) => ({
		shape: suite.shape,
		sampled: suite.sampled,
		kept: suite.kept,
		counts: suite.counts,
		reasons: suite.audit.reasons,
		manifest: suite.manifestPath,
	})),
}

for (const suite of frozen) {
	console.error(
		`[osm-suites] ${suite.shape}: ${suite.sampled} sampled, ${suite.kept} kept (${Object.entries(suite.counts)
			.map(([cls, n]) => `${cls} ${n}`)
			.join(", ")})`
	)
}

await writeLocalJSONFile(summary, resolvePath(out, "summary.json"))

console.log(stringifyJSON(summary))
