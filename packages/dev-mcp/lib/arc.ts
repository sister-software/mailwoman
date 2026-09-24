/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compare control, null, and candidate models in order. A dirty self-control invalidates attribution; the null
 *   separates fine-tuning cost from added-data effects. The D-rule blocks regressions in protected countries.
 */

import { dRuleCountries, type ProtectedCountry, readScopeConfig } from "@mailwoman/core/scope-config"

import { runCompare } from "#compare/index"
import type { EngineRegistryLike } from "#engine/registry"
import type { ComparedRow } from "#tool-kit"

/**
 * Read protected countries and D-rule reasons from `scope.config.json`.
 */
export async function protectedCountries(): Promise<ProtectedCountry[]> {
	return dRuleCountries(await readScopeConfig())
}

/**
 * Board result and row-level changes for one comparison arm.
 */
export interface ArcLeg {
	label: string
	weights: string
	improved: number
	regressed: number
	net: number
	differed: number
	of: number
	/**
	 * Regressions grouped by country for the D-rule check.
	 */
	regressedByCountry: Record<string, number>
	/**
	 * Inputs that regressed.
	 */
	regressedInputs: string[]
	/**
	 * Inputs that improved.
	 */
	improvedInputs: string[]
	runID?: string
}

/**
 * Comparison results, attribution status, and release verdict.
 */
export interface ArcResult {
	shape: RunShape
	control?: ArcLeg
	null?: ArcLeg
	candidate: ArcLeg
	/**
	 * Candidate regressions minus null regressions; undefined when no null leg ran.
	 */
	attributableRegressions?: number
	attributableNet?: number
	/**
	 * False when the self-control invalidates attribution; candidate results are still reported.
	 */
	attributable: boolean
	dRuleViolations: Array<{ country: string; n: number; reason: string }>
	verdict: "ship" | "hold" | "unattributable"
	reasons: string[]
}

function legFrom(label: string, weights: string, result: Record<string, unknown>): ArcLeg {
	const graded = (result["graded"] ?? {}) as { improved?: number; regressed?: number }
	const differed = (result["arms_differed_on"] ?? {}) as { n?: number; of?: number }
	const rows = (result["rows_changed"] ?? []) as ComparedRow[]
	const regressedRows = rows.filter((row) => row.grade === "regressed")
	const improvedRows = rows.filter((row) => row.grade === "improved")
	const byCountry: Record<string, number> = {}

	for (const row of regressedRows) {
		const country = row.country ?? "??"

		byCountry[country] = (byCountry[country] ?? 0) + 1
	}

	const improved = graded.improved ?? 0
	const regressed = graded.regressed ?? 0

	return {
		label,
		weights,
		improved,
		regressed,
		net: improved - regressed,
		differed: differed.n ?? 0,
		of: differed.of ?? 0,
		regressedByCountry: byCountry,
		regressedInputs: regressedRows.map((row) => row.input),
		improvedInputs: improvedRows.map((row) => row.input),
		...(typeof result["run_id"] === "string" ? { runID: result["run_id"] } : {}),
	}
}

/**
 * Training shape determines whether a null comparison is required.
 */
export type RunShape = "fine-tune" | "from-scratch"

export interface ArcOptions {
	candidate: string
	shape?: RunShape
	/**
	 * Staged shipped weights, run through the candidate path.
	 * Dereference symlinks before staging.
	 */
	control?: string
	/**
	 * Fine-tune placebo using the same base and settings without added data.
	 */
	null?: string
	inputs?: unknown
	locale?: string
}

/**
 * Determine attribution and ship/hold status from comparison results.
 */
export function decideArc(
	control: ArcLeg | undefined,
	nullLeg: ArcLeg | undefined,
	candidate: ArcLeg,
	protections: readonly ProtectedCountry[],
	shape: RunShape = "fine-tune"
): ArcResult {
	const reasons: string[] = []
	let attributable = true

	if (!control) {
		reasons.push(
			"No self-control leg ran. The rig was not shown to be quiet, so a small candidate delta cannot be " +
				"distinguished from harness noise. Stage the shipped weights through the candidate path and pass `control`."
		)
	} else if (control.differed > 0) {
		attributable = false

		reasons.push(
			`SELF-CONTROL DIRTY: the shipped model disagrees with itself on ${control.differed} of ${control.of} rows. ` +
				"Nothing measured on this rig is evidence about the candidate. Fix the rig before reading any number below."
		)
	}

	if (!nullLeg && shape === "fine-tune") {
		reasons.push(
			"No null leg ran. The candidate's regression count is GROSS — it carries the cost of touching the base at " +
				"all, which measured 10 of 649 rows on this base with no new data. Treat the count as an upper bound."
		)
	} else if (!nullLeg) {
		reasons.push(
			"No null leg, and none is applicable: a from-scratch run inherits no base, so there is no fine-tune tax to " +
				"subtract and the comparison against shipped is already the attributable one."
		)
	}

	const dRuleViolations = protections
		.map(({ country, reason }) => ({
			country,
			n: candidate.regressedByCountry[country] ?? 0,
			reason,
		}))
		.filter((entry) => entry.n > 0)

	const attributableRegressions = nullLeg ? candidate.regressed - nullLeg.regressed : undefined
	const attributableNet = nullLeg ? candidate.net - nullLeg.net : undefined

	if (dRuleViolations.length) {
		reasons.push(
			`D-RULE: regressions on ${dRuleViolations
				.map((entry) => `${entry.country} (${entry.n}) — ${entry.reason}`)
				.join("; ")}. ` +
				"Iron rule 6 blocks a default-on ship regardless of net. Fix, check per-locale, or make it opt-in."
		)
	}

	if (attributableNet !== undefined && attributableNet <= 0) {
		reasons.push(
			`Attributable net is ${attributableNet} (candidate ${candidate.net} minus null ${nullLeg?.net}). The change ` +
				"has not bought back the cost of the fine-tune it rode in on."
		)
	}

	const verdict: ArcResult["verdict"] = !attributable
		? "unattributable"
		: !dRuleViolations.length && candidate.net > 0 && (attributableNet ?? candidate.net) > 0
			? "ship"
			: "hold"

	return {
		shape,
		...(control ? { control } : {}),
		...(nullLeg ? { null: nullLeg } : {}),
		candidate,
		...(attributableRegressions === undefined ? {} : { attributableRegressions }),
		...(attributableNet === undefined ? {} : { attributableNet }),
		attributable,
		dRuleViolations,
		verdict,
		reasons,
	}
}

/**
 * Run controls and candidate comparisons sequentially.
 */
export async function runArc(registry: EngineRegistryLike, options: ArcOptions): Promise<ArcResult> {
	const inputs = options.inputs ?? { kind: "board" }
	const locale = options.locale
	const base = locale ? { locale } : {}
	const executionPath = locale ? "single-config" : "board-routed"

	const compare = async (label: string, weights: string): Promise<ArcLeg> => {
		const result = (await runCompare(registry, {
			inputs,
			arm_a: { kind: "mailwoman", config: { ...base } },
			arm_b: { kind: "mailwoman", config: { ...base, weights_cache: weights } },
			variable: ["weights_cache"],
			grade: "auto",
			execution_path: executionPath,
		})) as Record<string, unknown>

		return legFrom(label, weights, result)
	}

	const control = options.control ? await compare("self-control (shipped vs itself)", options.control) : undefined
	const nullLeg = options.null ? await compare("null (same base, no new data)", options.null) : undefined
	const candidate = await compare("candidate", options.candidate)

	return decideArc(control, nullLeg, candidate, await protectedCountries(), options.shape ?? "fine-tune")
}

/**
 * Summarize the verdict and attribution in one line.
 */
export function summarizeArc(arc: ArcResult): string {
	const attribution =
		arc.attributableNet === undefined
			? arc.shape === "from-scratch"
				? ", which is already the attributable number — a from-scratch run inherits no base. "
				: ", with no null leg to attribute it against — treat as an upper bound. "
			: `, of which net ${arc.attributableNet} is attributable to the change rather than to the fine-tune. `

	return (
		`${arc.verdict.toUpperCase()}. Candidate net ${arc.candidate.net} ` +
		`(${arc.candidate.improved} improved, ${arc.candidate.regressed} regressed)` +
		attribution +
		arc.reasons.join(" ")
	)
}

/**
 * Render the verdict, control results, and changed addresses.
 */
export function renderArc(arc: ArcResult): string {
	const lines: string[] = [`verdict: ${arc.verdict}`]

	for (const reason of arc.reasons) {
		lines.push(`  ! ${reason}`)
	}

	lines.push("", "leg                                  improved  regressed  net  differed")

	for (const leg of [arc.control, arc.null, arc.candidate]) {
		if (!leg) continue

		lines.push(
			`${leg.label.padEnd(36)} ${String(leg.improved).padStart(8)} ${String(leg.regressed).padStart(10)} ` +
				`${String(leg.net).padStart(4)} ${`${leg.differed}/${leg.of}`.padStart(9)}`
		)
	}

	if (arc.attributableNet !== undefined) {
		lines.push(
			"",
			`attributable to the CHANGE: net ${arc.attributableNet}, regressions ${arc.attributableRegressions} ` +
				"(candidate minus null)"
		)
	}

	if (arc.candidate.improvedInputs.length) {
		lines.push("", "improved addresses:")

		for (const input of arc.candidate.improvedInputs) {
			lines.push(`  + ${input}`)
		}
	}

	if (arc.candidate.regressedInputs.length) {
		lines.push("", "regressed addresses:")

		for (const input of arc.candidate.regressedInputs) {
			lines.push(`  - ${input}`)
		}
	}

	return lines.join("\n")
}
