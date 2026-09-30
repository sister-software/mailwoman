/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts the spans the flat component map deletes on the regression board, by tag.
 *
 *   `decodeAsJSON` holds one value per tag, so a parse with two spans of one tag reports one and
 *   deletes the other. `slotNodes` decides which one survives. This counts how often that decision is
 *   made and on which tags. Those two counts bound what an ordering change inside it can move.
 *
 *   The report is the projection's own `dropped` array rather than a second walk of the tree, so the
 *   count is the population the ordering governs.
 *
 *   The parse runs without the resolver, so no span is grounded and the ordering reduces to its later
 *   keys. A grounded run can only reduce the count, because grounding is the first key.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/projection-drops.run.ts [--show 25] [--json <out>]
 */

import { isAdminHierarchyTag } from "@mailwoman/codex/component"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { createScorer } from "@mailwoman/neural/scorer"
import { resolveWeights } from "@mailwoman/neural/weights"

import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"

const { values } = parseArguments({
	options: {
		show: { type: "string", description: "How many dropped spans to print (default 25)" },
		json: { type: "string", description: "Write the per-drop records to this path" },
	},
})

const show = Number(values.show ?? 25)

if (!Number.isFinite(show) || show < 0) throw new Error(`--show must be a non-negative number, read ${values.show}`)

// `resolveWeights` locates the tokenizer and the model card itself.
// A rewrite of `model.onnx` into a sibling filename would miss a bundle whose
// card resolves from the base package instead.
// That case is the `baseModelCardPath` fallback below.
const weights = await resolveWeights({})

const modelCardPath = weights.modelCardPath ?? weights.baseModelCardPath

if (!modelCardPath) {
	throw new Error(
		`The weights at ${weights.modelPath} resolved no model-card.json. ` +
			`The card states the label set, so a parse without it would report tags this build cannot emit.`
	)
}

const scorer = await createScorer({
	modelPath: weights.modelPath,
	tokenizerPath: weights.tokenizerPath,
	modelCardPath,
	strict: true,
	tier: "server",
})

const cases = await loadRegressionCases()

interface Drop {
	id: string
	country: string
	input: string
	tag: string
	deleted: string
	kept: string
	hierarchy: boolean
}

const drops: Drop[] = []
let rowsWithADrop = 0

for (const seed of cases) {
	const tree = await scorer.parse(seed.input, { postcodeRepair: true })
	const dropped = decodeAsJSON(tree, { includeDropped: true }).dropped ?? []

	if (!dropped.length) continue

	rowsWithADrop++

	for (const entry of dropped) {
		drops.push({
			id: seed.id,
			country: (seed.country ?? "").toUpperCase(),
			input: seed.input,
			tag: entry.tag,
			deleted: entry.value,
			kept: entry.kept,
			hierarchy: isAdminHierarchyTag(entry.tag),
		})
	}
}

const outsideHierarchy = drops.filter((drop) => !drop.hierarchy)

console.log(`board rows parsed: ${cases.length}`)
console.log(`  rows where the flat map deleted at least one span: ${rowsWithADrop}`)
console.log(`  deleted spans in total: ${drops.length}`)
console.log(
	`    on an administrative or postal rung, where text order decides: ${drops.length - outsideHierarchy.length}`
)
console.log(`    on every other tag, where label confidence decides: ${outsideHierarchy.length}`)

const byTag = new Map<string, number>()

for (const drop of drops) {
	byTag.set(drop.tag, (byTag.get(drop.tag) ?? 0) + 1)
}

console.log(`\nper tag:`)

for (const [tag, n] of [...byTag].toSorted((a, b) => b[1] - a[1])) {
	console.log(`  ${tag}  ${n}${isAdminHierarchyTag(tag) ? "  (text order)" : "  (confidence)"}`)
}

console.log(
	`\nfirst ${Math.min(show, outsideHierarchy.length)} of ${outsideHierarchy.length} drops decided by confidence:`
)

for (const drop of outsideHierarchy.slice(0, show)) {
	console.log(`\n  ${drop.id} (${drop.country})  tag ${drop.tag}`)
	console.log(`    input:   ${drop.input}`)
	console.log(`    kept:    ${drop.kept}`)
	console.log(`    deleted: ${drop.deleted}`)
}

if (values.json) {
	await writeLocalJSONFile(
		{
			rowsParsed: cases.length,
			rowsWithADrop,
			drops: drops.length,
			dropsOutsideHierarchy: outsideHierarchy.length,
			byTag: [...byTag].map(([tag, n]) => ({ tag, n, hierarchy: isAdminHierarchyTag(tag) })),
			records: drops,
		},
		values.json
	)

	console.log(`\nwrote ${values.json}`)
}
