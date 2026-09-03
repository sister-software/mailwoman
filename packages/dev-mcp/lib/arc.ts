/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The graded-arc protocol as ONE call: self-control, then null, then candidate — in that order, and with the first
 *   two able to stop the third from being reported.
 *
 *   The order is the whole point. On 2026-08-23 eight training runs were graded candidate-against-shipped and every one
 *   reported a regression that was, in substantial part, the cost of fine-tuning at all. The two controls that say so
 *   were run eighth and ninth. They were not skipped because anyone decided to skip them; they were skipped because
 *   running them is three more commands at the moment you already have a number in hand, and a number in hand feels
 *   like an answer. Making the controls the DEFAULT PATH rather than a discipline is the only fix that survives a
 *   fresh context.
 *
 *   Two facts this encodes that an agent otherwise re-derives every time:
 *
 *   - **A candidate's regressions are `candidate − null`, not `candidate − shipped`.** Touching the base costs rows
 *     before the new extract is read at all — measured at 10 of 649 on `v440-step-060000`, paid inside the first 1,000
 *     steps and flat to 4,000. Eighteen regressions where the null has ten is eight attributable, not eighteen.
 *   - **A self-control that is not 0 invalidates the session, not the row.** If the shipped model graded through the
 *     candidate path disagrees with itself, no candidate number from that rig means anything, and reporting one
 *     anyway is how a harness bug becomes a model finding.
 *
 *   So `runArc` REFUSES to attribute when the self-control is dirty. It reports the candidate's raw numbers, marks
 *   them unattributable, and says which control failed. That refusal is the feature.
 */

import { runCompare } from "#compare"
import type { EngineRegistryLike } from "#engine-registry"
import type { ComparedRow } from "#tool-kit"

/**
 * Locales that iron rule 6 — the D-rule — protects unconditionally.
 *
 * No default-on mechanism ships with a known regression on any of these, whatever the net says. A candidate that wins
 * 40 rows and loses one in France is not a candidate.
 */
export const D_RULE_COUNTRIES = ["FR", "GB", "DE"] as const

/**
 * One arm's board result, reduced to what a verdict needs.
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
	 * Regressed rows grouped by country, so the D-rule can be checked without re-reading the whole run.
	 */
	regressedByCountry: Record<string, number>
	/**
	 * The addresses that regressed. Complete and never truncated: the aggregate is a summary of these, and the whole
	 * reason this file exists is that the summary was allowed to stand in for them.
	 */
	regressedInputs: string[]
	/**
	 * The addresses that improved. Carried for the same reason as the regressions, and originally omitted — which made
	 * every report from this tool one-sided: "35 regressed" with the 37 wins reduced to a count nobody could inspect. A
	 * candidate is a TRADE, and a reader cannot price a trade with one side hidden.
	 */
	improvedInputs: string[]
	runID?: string
}

/**
 * What the arc concluded, and whether it is entitled to conclude anything.
 */
export interface ArcResult {
	shape: RunShape
	control?: ArcLeg
	null?: ArcLeg
	candidate: ArcLeg
	/**
	 * `candidate.regressed − null.regressed`. Undefined when no null leg ran — in which case the candidate's regression
	 * count is a gross number carrying an unknown fine-tune tax, and saying so is more useful than a subtraction against
	 * nothing.
	 */
	attributableRegressions?: number
	attributableNet?: number
	/**
	 * False when a control disqualified the measurement. The candidate numbers are still reported; they are just not
	 * evidence about the candidate.
	 */
	attributable: boolean
	dRuleViolations: Array<{ country: string; n: number }>
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
 * How the candidate was trained.
 *
 * This is not bookkeeping: it decides whether a null leg is MISSING or INAPPLICABLE. A fine-tune inherits a base and
 * pays to touch it, so a null is the only thing that separates the change's cost from the tax. A from-scratch run
 * inherits nothing, so there is no tax to subtract and demanding a null would be asking for a control of nothing.
 * Reporting the second case with the first case's caveat is how a correct number gets discounted.
 */
export type RunShape = "fine-tune" | "from-scratch"

export interface ArcOptions {
	candidate: string
	shape?: RunShape
	/**
	 * A staged copy of the SHIPPED weights, run through the identical candidate path. Dereference the symlinks when
	 * staging it — a directory that points back at the shipped artifacts grades the shipped model under the candidate's
	 * name and the control passes for the wrong reason.
	 */
	control?: string
	/**
	 * The null arm: same base, same steps, same seed, same brake, NO added extract.
	 */
	null?: string
	inputs?: unknown
	locale?: string
}

/**
 * The verdict, given three legs. Pure on purpose: this is the half that was getting decided by eye, and deciding it by
 * eye is what produced eight confidently-wrong regression counts.
 */
export function decideArc(
	control: ArcLeg | undefined,
	nullLeg: ArcLeg | undefined,
	candidate: ArcLeg,
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

	const dRuleViolations = D_RULE_COUNTRIES.map((country) => ({
		country,
		n: candidate.regressedByCountry[country] ?? 0,
	})).filter((entry) => entry.n > 0)

	const attributableRegressions = nullLeg ? candidate.regressed - nullLeg.regressed : undefined
	const attributableNet = nullLeg ? candidate.net - nullLeg.net : undefined

	if (dRuleViolations.length) {
		reasons.push(
			`D-RULE: regressions on ${dRuleViolations.map((entry) => `${entry.country} (${entry.n})`).join(", ")}. ` +
				"Iron rule 6 blocks a default-on ship regardless of net. Fix, gate per-locale, or make it opt-in."
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
 * Run the arc. Legs run SEQUENTIALLY — three concurrent board runs saturate the lab host, and the arc is not on
 * anyone's critical path.
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

	return decideArc(control, nullLeg, candidate, options.shape ?? "fine-tune")
}

/**
 * The one-line verdict.
 *
 * It lives beside {@linkcode decideArc} rather than in the tool wrapper because the first version computed the same
 * sentence in both places and they disagreed on their first live run: `reasons` correctly called a from-scratch run's
 * null INAPPLICABLE while the wrapper's summary still called the number an upper bound carrying a fine-tune tax. Two
 * copies of a rule agree until one of them is fixed.
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
 * Render an arc the way it should be read — the verdict, then what the controls said, then the addresses.
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
