/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parse-only read of the reserved bare-postcode cases. One classifier stays warm for all 56
 *   inputs, and the report names every input whose first token is not decoded as a postcode.
 */

import { BARE_POSTCODE_EVAL_CASES, type BarePostcodeEvalFamily } from "@mailwoman/corpus/recipes/bare/postcode-eval"
import type { NeuralParseTrace } from "@mailwoman/neural"

import { buildGauntletDeps, type GauntletDepsOptions } from "#eval-harness/gauntlet/harness"

export interface BarePostcodeCapabilityOptions extends GauntletDepsOptions {
	label?: string
}

export interface BarePostcodeCapabilityResult {
	pass: boolean
	groups: Record<BarePostcodeEvalFamily, { postcode: number; houseNumber: number; other: number; total: number }>
}

function headTag(trace: NeuralParseTrace): string {
	const index = trace.path[0]

	return index === undefined ? "(none)" : (trace.labels[index] ?? "(none)").replace(/^[BI]-/u, "")
}

/**
 * Run the reserved cases through one warm parser and print group counts plus every miss.
 */
export async function runBarePostcodeCapability(
	options: BarePostcodeCapabilityOptions = {},
	report: (line: string) => void = console.log
): Promise<BarePostcodeCapabilityResult> {
	using deps = await buildGauntletDeps(options)

	const groups: BarePostcodeCapabilityResult["groups"] = {
		nnn_nn: { postcode: 0, houseNumber: 0, other: 0, total: 0 },
		nnnn_ll: { postcode: 0, houseNumber: 0, other: 0, total: 0 },
	}

	const misses: string[] = []

	for (const row of BARE_POSTCODE_EVAL_CASES) {
		const { trace } = await deps.diagnoseParse(row.input)
		const tag = headTag(trace)
		const group = groups[row.family]

		group.total++

		if (tag === "postcode") {
			group.postcode++
		} else if (tag === "house_number") {
			group.houseNumber++
		} else {
			group.other++
		}

		if (tag !== "postcode") {
			misses.push(`${row.country} ${row.input}: ${tag}`)
		}
	}

	report(`=== ${options.label ?? options.weightsCacheRoot ?? "shipped weights"} ===`)

	for (const [family, group] of Object.entries(groups)) {
		report(
			`${family}: postcode ${group.postcode}/${group.total}; ` +
				`house_number ${group.houseNumber}/${group.total}; other ${group.other}/${group.total}`
		)
	}

	if (misses.length) {
		report("non-postcode reads:")

		for (const miss of misses) {
			report(`  ${miss}`)
		}
	}

	return { pass: misses.length === 0, groups }
}
