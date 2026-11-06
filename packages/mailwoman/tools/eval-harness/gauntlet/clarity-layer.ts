/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The gauntlet's clarity layer: runs every board row with a truth point at each level of clarity and reports how far
 *   down each place still answers.
 *
 *   This layer measures and cannot block a ship. It passes no country hint, because a person who types a bare name
 *   states none. It reads the committed cases, so it needs no `regression.db`.
 */

import { tempRootPathBuilder } from "@mailwoman/core/data-root"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { buildCaseLadder } from "#ablation/expectation"
import { AblationGazetteer } from "#tools/eval-harness/gauntlet/ablation/gazetteer"
import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"
import {
	CLARITY_LEVELS,
	type ClarityCounts,
	type ClarityOutcome,
	clarityVariants,
	emptyClarityCounts,
	gradeClarityAnswer,
	holdsDownTo,
} from "#tools/eval-harness/gauntlet/clarity"
import { buildGauntletDeps } from "#tools/eval-harness/gauntlet/harness"
import { type GauntletLayerOptions, layerDepsOptions } from "#tools/eval-harness/gauntlet/regression"

/**
 * Options for {@linkcode runClarityLayer}.
 */
export interface ClarityLayerOptions extends GauntletLayerOptions {
	outDir?: PathBuilderLike
	/**
	 * Cap the number of cases.
	 */
	limit?: number
	/**
	 * Keep only cases whose id matches this pattern.
	 */
	match?: string
}

/**
 * One graded rendering.
 */
interface ClarityRowResult {
	caseID: string
	level: string
	input: string
	anchored: boolean
	outcome: ClarityOutcome
	met: boolean
	km: number | null
	lat: number | null
	lon: number | null
	tier: string | null
}

/**
 * Renders the level table.
 */
function renderLevels(byLevel: ReadonlyMap<string, ClarityCounts>): string[] {
	const order = ["full", ...CLARITY_LEVELS.map((level) => level.id)]

	const keys = [...byLevel.keys()].toSorted(
		(a, b) => (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1)
	)

	return [
		"| level | n | exact | on chain | declared | abstained | wrong place | met |",
		"| --- | --: | --: | --: | --: | --: | --: | --: |",
		...keys.map((key) => {
			const c = byLevel.get(key)!

			return `| ${key} | ${c.n} | ${c.exact} | ${c.on_chain} | ${c.declared} | ${c.abstained} | ${c.wrong_place} | ${c.met} |`
		}),
	]
}

/**
 * Runs the layer.
 *
 * @returns `pass`, which reports only that the instrument measured at least one rendering.
 */
export async function runClarityLayer(
	options: ClarityLayerOptions = {}
): Promise<{ pass: boolean; outDir: string; byLevel: Record<string, ClarityCounts> }> {
	const match = options.match ? new RegExp(options.match, "u") : null
	const all = await loadRegressionCases()

	const selected = all.filter(
		(c) => typeof c.expectLat === "number" && typeof c.expectLon === "number" && (!match || match.test(c.id))
	)

	const cases = options.limit ? selected.slice(0, options.limit) : selected
	const outDir = PathBuilder.from(options.outDir ?? tempRootPathBuilder(`clarity-${Date.now()}`))

	using deps = await buildGauntletDeps(layerDepsOptions(options))
	using gazetteer = await AblationGazetteer.create()

	const rows: ClarityRowResult[] = []
	const byLevel = new Map<string, ClarityCounts>()
	const families: Array<{ caseID: string; input: string; holdsDownTo: string | null; levels: number }> = []

	for (const c of cases) {
		const truth = { lat: c.expectLat!, lon: c.expectLon!, toleranceKm: (c.expectToleranceM ?? 25_000) / 1000 }
		const drawn = buildCaseLadder({ lat: truth.lat, lon: truth.lon }, truth.toleranceKm, gazetteer, truth, c.country)

		const variants = [
			{ level: "full", input: c.input, anchored: true },
			...clarityVariants({ id: c.id, input: c.input, country: c.country, components: c.expectComponents ?? {} }),
		]

		const family: ClarityRowResult[] = []

		for (const variant of variants) {
			const result = await deps.geocode(variant.input)

			const graded = gradeClarityAnswer({
				answer: {
					lat: result.lat,
					lon: result.lon,
					declaredAmbiguity: result.intent_markers.some((marker) => marker.code === "declared_ambiguity"),
					candidates: result.candidates,
				},
				truth,
				ladder: drawn.ladder,
				anchored: variant.anchored,
			})

			const row: ClarityRowResult = {
				caseID: c.id,
				...variant,
				...graded,
				lat: result.lat,
				lon: result.lon,
				tier: result.resolution_tier,
			}

			family.push(row)

			const counts = byLevel.get(variant.level) ?? emptyClarityCounts()

			counts[graded.outcome]++

			counts.n++
			counts.met += graded.met ? 1 : 0
			byLevel.set(variant.level, counts)
		}

		rows.push(...family)
		families.push({ caseID: c.id, input: c.input, holdsDownTo: holdsDownTo(family), levels: family.length })
	}

	const summary = [
		`# Gauntlet clarity layer: ${cases.length} cases, ${rows.length} renderings`,
		"",
		...renderLevels(byLevel),
	].join("\n")

	console.log(summary)

	await writeLocalJSONFile(
		{ caseCount: cases.length, renderingCount: rows.length, byLevel: Object.fromEntries(byLevel), families, rows },
		outDir("clarity.json")
	)

	await writeLocalFile(`${summary}\n`, outDir("clarity.md"))

	console.log(`\nartifacts: ${outDir.toString()}`)

	return { pass: rows.length > 0, outDir: outDir.toString(), byLevel: Object.fromEntries(byLevel) }
}
