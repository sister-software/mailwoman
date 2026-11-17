// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Renders the capability-probe recipes with a probe-only seed and freezes the development
 *   and confirmation probe sets (`heldout/probes/build.ts`).
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/probes/build.run.ts \
 *     --corpora <corpus MANIFEST.json>,<corpus MANIFEST.json> --out <directory> \
 *     [--name v0.8.19-probes] [--render-seed 1900] [--seed 1820] [--confirm-seed 1821] \
 *     [--po-box-quota 500] [--postal-unit-quota 200] [--floor 20] [--path-root /mnt/mw]
 *
 *   `--corpora` names every training corpus whose probe rows the sets mustn't repeat.
 *   Audit both sets with `heldout/dataset/overlap.run.ts --match-text` before reading a score from them.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { poBoxCedexRecipe } from "@mailwoman/corpus/recipes/po/box/cedex/recipe"
import {
	generatePostalGuidelineRows,
	POSTAL_GUIDELINE_LEGS,
	readPostalGuidelinePlaces,
} from "@mailwoman/corpus/recipes/postal/guideline"
import type { PostalGuidelineLeg, PostalGuidelinePlace } from "@mailwoman/corpus/recipes/postal/guideline/leg"
import { POSTAL_UNIT_GUIDELINE_LEGS } from "@mailwoman/corpus/recipes/postal/unit-guideline"

import { heldoutRowGroup, type HeldoutRow } from "#tools/eval-harness/heldout/per/country"
import {
	buildProbeSets,
	foldProbeTexts,
	type ProbeCandidate,
	type ProbeLeg,
	readProbeExclusions,
} from "#tools/eval-harness/heldout/probes/build"
import { CURRENT_RELEASE_SPEC } from "#tools/eval-harness/release/current-spec"
import { readReleaseSpec } from "#tools/eval-harness/release/requirements"

const { values } = parseArguments({
	options: {
		corpora: { type: "string", description: "Training corpus MANIFEST.json files, comma-separated" },
		out: { type: "string", description: "The directory the sets are written to" },
		name: { type: "string", default: "v0.8.19-probes", description: "The suffix of both set names" },
		"render-seed": { type: "string", default: "1900", description: "The recipes' PRNG seed" },
		seed: { type: "string", default: "1820", description: "The development draw's order seed" },
		"confirm-seed": { type: "string", default: "1821", description: "The confirmation draw's order seed" },
		"po-box-quota": { type: "string", default: "500", description: "Rows per po_box_cedex leg per set" },
		"postal-unit-quota": { type: "string", default: "200", description: "Rows per postal_unit leg per set" },
		"po-box-cedex-count": {
			type: "string",
			default: "30000",
			description: "Rows the po-box-cedex recipe renders over its five countries",
		},
		"guideline-count": { type: "string", default: "2000", description: "Rows each guideline leg renders" },
		floor: { type: "string", default: "20", description: "Rows every template takes before the proportional split" },
		"path-root": { type: "string", default: "/mnt/mw", description: "Local directory for a manifest's /data prefix" },
		spec: { type: "string", default: CURRENT_RELEASE_SPEC, description: "The spec whose checks select the sources" },
	},
})

if (!values.corpora || !values.out) throw new Error("--corpora and --out are required")

const integer = (name: string, value: string | undefined) => {
	const parsed = Number(value)

	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${name} ${value} is not a whole number`)

	return parsed
}

const renderSeed = integer("render-seed", values["render-seed"])
const poBoxQuota = integer("po-box-quota", values["po-box-quota"])
const postalUnitQuota = integer("postal-unit-quota", values["postal-unit-quota"])
const guidelineCount = integer("guideline-count", values["guideline-count"])
const poBoxCount = integer("po-box-cedex-count", values["po-box-cedex-count"])

const PO_BOX_CEDEX = "invented-po-box-cedex"
const POSTAL_GUIDELINE = "invented-postal-guideline"
const POSTAL_UNIT_GUIDELINE = "invented-postal-unit-guideline"

const spec = await readReleaseSpec(values.spec)

const selected = (id: string) => {
	const req = spec.requirements.find((r) => r.id === id)

	if (req?.kind !== "capability") throw new Error(`${values.spec} registers no capability ${id}`)

	return req.select.sources ?? []
}

for (const [id, sources] of [
	["po_box_cedex", [PO_BOX_CEDEX, POSTAL_GUIDELINE]],
	["postal_unit", [POSTAL_UNIT_GUIDELINE]],
] as const) {
	const registered = selected(id)

	if (
		sources.some((s) => !registered.includes(s)) ||
		registered.some((s) => !(sources as readonly string[]).includes(s))
	) {
		throw new Error(`${id} selects ${registered.join(", ")}; this build renders ${sources.join(", ")}`)
	}
}

// Every leg the three recipes render, so each set covers each recipe's countries and forms.
const legs: ProbeLeg[] = [
	...["US", "FR", "CA", "AU", "NZ"].map((country) => ({ source: PO_BOX_CEDEX, country, quota: poBoxQuota })),
	...POSTAL_GUIDELINE_LEGS.map((leg) => ({ source: POSTAL_GUIDELINE, country: leg.country, quota: poBoxQuota })),
	...POSTAL_UNIT_GUIDELINE_LEGS.map((leg) => ({
		source: POSTAL_UNIT_GUIDELINE,
		country: leg.country,
		quota: postalUnitQuota,
	})),
]

interface RecipeLine {
	raw: string
	span_starts?: number[] | null
	span_ends?: number[] | null
	span_tags?: string[] | null
	country: string
	source: string
	source_id: string
	base_source_id: string | null
	template: string
}

const candidate = (line: RecipeLine): ProbeCandidate => {
	if (!line.span_starts || !line.span_ends || !line.span_tags) {
		throw new Error(`${line.source_id} was written without its span triple`)
	}

	const row: HeldoutRow = {
		raw: line.raw,
		span_starts: line.span_starts,
		span_ends: line.span_ends,
		span_tags: line.span_tags,
		country: line.country,
		source: line.source,
		source_id: line.source_id,
		group: heldoutRowGroup(line, line.source_id),
	}

	return { row, template: line.template }
}

const candidates: ProbeCandidate[] = []

console.error(`=== po-box-cedex, ${poBoxCount} rows, seed ${renderSeed}`)

const poBoxStats = await poBoxCedexRecipe.run(
	// The training pools, as the corpus's po-box-cedex rows were rendered: the probe is the same population.
	{ output: "", seed: renderSeed, variants: 0, count: poBoxCount, sourceName: PO_BOX_CEDEX, golden: false },
	(line) => {
		candidates.push(candidate(parseJSONStrict<RecipeLine>(line)))
	}
)

const guideline = async (legsToRender: readonly PostalGuidelineLeg[], source: string) => {
	const places = new Map<string, readonly PostalGuidelinePlace[]>()

	for (const leg of legsToRender) {
		const read = await readPostalGuidelinePlaces(leg)

		console.error(`  ${source} ${leg.country}: ${read.length} GeoNames postal places`)

		places.set(leg.country, read)
	}

	for (const row of generatePostalGuidelineRows({
		places,
		legs: legsToRender,
		count: guidelineCount,
		seed: renderSeed,
		source,
	})) {
		candidates.push(candidate(row as RecipeLine))
	}
}

console.error(`=== postal-guideline and postal-unit-guideline, ${guidelineCount} rows per leg, seed ${renderSeed}`)

await guideline(POSTAL_GUIDELINE_LEGS, POSTAL_GUIDELINE)
await guideline(POSTAL_UNIT_GUIDELINE_LEGS, POSTAL_UNIT_GUIDELINE)

const corpora = values.corpora
	.split(",")
	.map((path) => path.trim())
	.filter((path) => path.length > 0)

const limits = { memoryLimitBytes: 4 * 2 ** 30, threads: 4 }

const exclusions = await readProbeExclusions({
	corpora,
	sources: [PO_BOX_CEDEX, POSTAL_GUIDELINE, POSTAL_UNIT_GUIDELINE],
	pathRoot: values["path-root"],
	limits,
})

console.error(`excluding ${exclusions.groups.size} groups and ${exclusions.texts.size} folded texts`)

const built = await buildProbeSets({
	names: { development: `heldout-dev-${values.name}`, confirmation: `heldout-confirm-${values.name}` },
	candidates,
	folded: await foldProbeTexts(candidates, limits),
	exclusions,
	legs,
	seeds: { development: integer("seed", values.seed), confirmation: integer("confirm-seed", values["confirm-seed"]) },
	floor: integer("floor", values.floor),
	render: {
		seed: renderSeed,
		recipes: [
			{ recipe: poBoxCedexRecipe.name, source: PO_BOX_CEDEX, count: poBoxCount, ...poBoxStats },
			{ recipe: "postal-guideline", source: POSTAL_GUIDELINE, countPerLeg: guidelineCount },
			{ recipe: "postal-unit-guideline", source: POSTAL_UNIT_GUIDELINE, countPerLeg: guidelineCount },
		],
	},
	excludedBy: exclusions.files,
	outDirectory: values.out,
	createdAt: new Date().toISOString(),
})

for (const set of [built.development, built.confirmation]) {
	console.log(
		`${set.manifest.datasetID} version ${set.manifest.version}: ${set.manifest.rows.length} rows, ` +
			`rows sha256 ${set.manifest.rowsFile.sha256}, ${set.path}`
	)
}

console.log(["source", "country", "quota", "rendered", "excluded", "available", "dev", "confirm"].join("\t"))

for (const leg of built.legs) {
	console.log(
		[
			leg.source,
			leg.country,
			leg.quota,
			leg.rendered,
			leg.excluded,
			leg.available,
			leg.drawn.development,
			leg.drawn.confirmation,
		].join("\t")
	)
}
