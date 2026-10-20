/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The graded arc keeps two answers apart. Training attribution asks whether the change, rather than the rig or
 *   the cost of fine-tuning, moved the board: the self-control leg must be quiet and the placebo (null) leg is
 *   subtracted from the candidate. Release eligibility asks whether the exact candidate artifact meets the
 *   registered release requirements, and it is read from the verdict `release/evaluate.run.ts` writes for that
 *   artifact and that specification version. The board's changed rows are reported as findings with their
 *   addresses. Release eligibility is decided by the verdict alone.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256File } from "@mailwoman/core/hash"
import { CURRENT_RELEASE_SPEC } from "mailwoman/tools/eval-harness/release/current-spec"
import { ReleaseOutcome } from "mailwoman/tools/eval-harness/release/evaluate"
import { readReleaseSpec } from "mailwoman/tools/eval-harness/release/requirements"
import { resolvePath } from "path-ts"

import { runCompare } from "#dev-mcp/compare"
import type { EngineRegistryLike } from "#dev-mcp/engine/registry"
import type { ComparedRow } from "#dev-mcp/tool-kit"

/**
 * One board row the candidate changed, with the exact input beside both arms' output.
 */
export interface BoardFinding {
	input: string
	country: string | null
	/**
	 * The published model's output on the row.
	 */
	published: unknown
	/**
	 * The candidate's output on the row.
	 */
	candidate: unknown
	/**
	 * The checker's issues with the candidate's output, which state the expected value.
	 */
	issues: string[]
}

/**
 * The board counts and changed rows for one comparison leg.
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
	 * Counts regressed rows by country, for reporting.
	 * Rows without a country count under `??`.
	 */
	regressedByCountry: Record<string, number>

	regressedInputs: string[]

	improvedInputs: string[]

	/**
	 * Every regressed row, with both arms' output.
	 */
	regressedRows: BoardFinding[]
	runID: string | null
}

/**
 * The training shape.
 *
 * A fine-tune needs a null leg.
 * A from-scratch run has no such requirement.
 */
export type RunShape = "fine-tune" | "from-scratch"

/**
 * What the arc knows about release evidence for the candidate.
 */
export interface ReleaseEvidence {
	/**
	 * The parsed verdict JSON from `release/evaluate.run.ts`, or `null` when no verdict was supplied.
	 */
	verdict: unknown
	verdictPath: string | null
	/**
	 * The sha256 of the candidate's `model.onnx`, measured by the arc.
	 */
	candidateSHA256: string
	/**
	 * The `specVersion` of the release-requirement specification the verdict must have been evaluated against.
	 */
	specVersion: string
}

/**
 * Release eligibility of the candidate artifact, as the release verdict decides it.
 */
export interface ReleaseEligibility {
	outcome: ReleaseOutcome
	specVersion: string
	candidateSHA256: string
	verdictPath: string | null
	reasons: string[]
}

/**
 * Reads release eligibility from a release verdict.
 *
 * A missing verdict is insufficient evidence.
 * A verdict evaluated for another artifact or another specification version,
 * or one whose fields cannot be read, is refused with an error.
 */
export function readReleaseEligibility(evidence: ReleaseEvidence): ReleaseEligibility {
	const base = {
		specVersion: evidence.specVersion,
		candidateSHA256: evidence.candidateSHA256,
		verdictPath: evidence.verdictPath,
	}

	if (evidence.verdict == null) {
		return {
			...base,
			outcome: ReleaseOutcome.Insufficient,
			reasons: [
				`No release verdict was supplied for candidate model.onnx sha256 ${evidence.candidateSHA256}. Run ` +
					`release/evaluate.run.ts against spec ${evidence.specVersion} and pass its output as release_verdict.`,
			],
		}
	}

	const source = evidence.verdictPath ?? "the release verdict"

	if (typeof evidence.verdict !== "object") throw new TypeError(`${source} is not a JSON object`)

	const verdict = evidence.verdict as {
		specVersion?: unknown
		outcome?: unknown
		reasons?: unknown
		artifacts?: { candidate?: unknown } | null
	}

	if (typeof verdict.specVersion !== "string") throw new TypeError(`${source} holds no specVersion`)

	const candidate = verdict.artifacts?.candidate

	if (typeof candidate !== "string") throw new TypeError(`${source} holds no artifacts.candidate sha256`)

	const outcomes: readonly unknown[] = Object.values(ReleaseOutcome)

	if (!outcomes.includes(verdict.outcome)) throw new TypeError(`${source} holds outcome ${String(verdict.outcome)}`)

	if (!Array.isArray(verdict.reasons) || verdict.reasons.some((reason) => typeof reason !== "string")) {
		throw new TypeError(`${source} holds no reasons array of strings`)
	}

	if (candidate !== evidence.candidateSHA256) {
		throw new Error(
			`${source} was evaluated for candidate model.onnx sha256 ${candidate}, and the candidate under test is ` +
				`${evidence.candidateSHA256}. A release verdict describes one artifact.`
		)
	}

	if (verdict.specVersion !== evidence.specVersion) {
		throw new Error(
			`${source} was evaluated against release spec ${verdict.specVersion}, and the current spec is ` +
				`${evidence.specVersion}. A candidate evaluated against a revised spec needs a fresh verdict.`
		)
	}

	return {
		...base,
		outcome: verdict.outcome as ReleaseOutcome,
		reasons: verdict.reasons as string[],
	}
}

/**
 * The inputs {@link decideArc} decides from.
 */
export interface ArcDecisionInput {
	control: ArcLeg | null
	null: ArcLeg | null
	candidate: ArcLeg
	release: ReleaseEvidence
	shape?: RunShape
}

/**
 * The legs, training attribution, release eligibility and board findings of one arc.
 */
export interface ArcResult {
	shape: RunShape
	control: ArcLeg | null
	null: ArcLeg | null
	candidate: ArcLeg

	/**
	 * Release eligibility, read from the release verdict for the candidate artifact.
	 * Only `pass` permits promotion.
	 */
	release: ReleaseEligibility

	attribution: {
		/**
		 * False when the self-control leg disagreed with itself.
		 *
		 * The candidate numbers are still reported, but they are not evidence.
		 */
		attributable: boolean
		/**
		 * The candidate's regressions minus the placebo control arm's.
		 * It is `null` when no null leg ran.
		 */
		regressions: number | null
		net: number | null
		reasons: string[]
	}

	/**
	 * The board rows the candidate regressed, reported for investigation.
	 * They never decide release eligibility.
	 */
	findings: BoardFinding[]
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
		regressedRows: regressedRows.map((row) => ({
			input: row.input,
			country: row.country,
			published: row.a,
			candidate: row.b,
			issues: row.issues_b,
		})),
		runID: typeof result["run_id"] === "string" ? result["run_id"] : null,
	}
}

/**
 * Options for {@link runArc}.
 *
 * Each weights cache path is compared against the shipped weights.
 */
export interface ArcOptions {
	candidate: string
	shape?: RunShape

	/**
	 * The weights cache that holds a staged copy of the shipped weights.
	 *
	 * It runs through the candidate path to show that the rig produces no differences by itself.
	 * Dereference symlinks when staging it.
	 */
	control?: string

	/**
	 * The weights cache of a placebo fine-tune with the same base and settings and without the added data.
	 */
	null?: string

	/**
	 * The verdict JSON `release/evaluate.run.ts` wrote for this candidate's `model.onnx`.
	 */
	releaseVerdict?: string

	/**
	 * The release-requirement specification the verdict must match.
	 * Defaults to `CURRENT_RELEASE_SPEC`.
	 */
	releaseSpec?: string
	inputs?: unknown
	locale?: string
}

/**
 * Decides training attribution and reads release eligibility from the legs and the release evidence.
 *
 * Throws when the release verdict belongs to another artifact or specification version.
 */
export function decideArc(input: ArcDecisionInput): ArcResult {
	const { control, candidate } = input
	const nullLeg = input.null
	const shape = input.shape ?? "fine-tune"
	const release = readReleaseEligibility(input.release)
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

	const attributableRegressions = nullLeg ? candidate.regressed - nullLeg.regressed : null
	const attributableNet = nullLeg ? candidate.net - nullLeg.net : null

	if (attributableNet !== null && attributableNet <= 0) {
		reasons.push(
			`Attributable net is ${attributableNet} (candidate ${candidate.net} minus null ${nullLeg?.net}). The change ` +
				"has not bought back the cost of the fine-tune it rode in on."
		)
	}

	return {
		shape,
		control,
		null: nullLeg,
		candidate,
		release,
		attribution: {
			attributable,
			regressions: attributableRegressions,
			net: attributableNet,
			reasons,
		},
		findings: candidate.regressedRows,
	}
}

/**
 * Reads the release evidence for a candidate weights directory.
 */
export async function readReleaseEvidence(
	candidate: string,
	releaseVerdict: string | undefined,
	releaseSpec: string | undefined
): Promise<ReleaseEvidence> {
	const spec = await readReleaseSpec(resolvePath(releaseSpec ?? CURRENT_RELEASE_SPEC))

	return {
		verdict: releaseVerdict ? await readLocalJSONFile<unknown>(releaseVerdict) : null,
		verdictPath: releaseVerdict ?? null,
		candidateSHA256: await sha256File(resolvePath(candidate, "model.onnx")),
		specVersion: spec.specVersion,
	}
}

/**
 * Runs the control, null and candidate comparisons in sequence and decides the arc.
 *
 * The release evidence is read and checked before any leg runs, so a mismatched verdict is refused at once.
 */
export async function runArc(registry: EngineRegistryLike, options: ArcOptions): Promise<ArcResult> {
	const release = await readReleaseEvidence(options.candidate, options.releaseVerdict, options.releaseSpec)

	readReleaseEligibility(release)

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

	const control = options.control ? await compare("self-control (shipped vs itself)", options.control) : null
	const nullLeg = options.null ? await compare("null (same base without new data)", options.null) : null
	const candidate = await compare("candidate", options.candidate)

	return decideArc({
		control,
		null: nullLeg,
		candidate,
		release,
		shape: options.shape ?? "fine-tune",
	})
}

/**
 * Returns release eligibility, attribution and the candidate counts as one line.
 */
export function summarizeArc(arc: ArcResult): string {
	const attribution =
		arc.attribution.net === null
			? arc.shape === "from-scratch"
				? ", which is already the attributable number — a from-scratch run inherits no base. "
				: ", with no null leg to attribute it against — treat as an upper bound. "
			: `, of which net ${arc.attribution.net} is attributable to the change rather than to the fine-tune. `

	return (
		`RELEASE ${arc.release.outcome.toUpperCase()} (spec ${arc.release.specVersion}). ` +
		`ATTRIBUTION ${arc.attribution.attributable ? "ATTRIBUTABLE" : "UNATTRIBUTABLE"}. ` +
		`Candidate board net ${arc.candidate.net} ` +
		`(${arc.candidate.improved} improved, ${arc.candidate.regressed} regressed)` +
		attribution +
		[...arc.release.reasons, ...arc.attribution.reasons].join(" ")
	)
}

/**
 * Renders release eligibility, attribution, a table of legs and the changed addresses as text.
 */
export function renderArc(arc: ArcResult): string {
	const lines: string[] = [
		`release: ${arc.release.outcome} (spec ${arc.release.specVersion}, candidate sha256 ${arc.release.candidateSHA256})`,
	]

	for (const reason of arc.release.reasons) {
		lines.push(`  ! ${reason}`)
	}

	lines.push(`attribution: ${arc.attribution.attributable ? "attributable" : "unattributable"}`)

	for (const reason of arc.attribution.reasons) {
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

	if (arc.attribution.net !== null) {
		lines.push(
			"",
			`attributable to the CHANGE: net ${arc.attribution.net}, regressions ${arc.attribution.regressions} ` +
				"(candidate minus null)"
		)
	}

	if (arc.candidate.improvedInputs.length) {
		lines.push("", "improved addresses:")

		for (const input of arc.candidate.improvedInputs) {
			lines.push(`  + ${input}`)
		}
	}

	if (arc.findings.length) {
		lines.push("", "regressed addresses (findings to investigate; they do not decide release eligibility):")

		for (const finding of arc.findings) {
			lines.push(`  - ${finding.input}${finding.country ? ` [${finding.country}]` : ""}`)

			for (const issue of finding.issues) {
				lines.push(`      ${issue}`)
			}
		}
	}

	return lines.join("\n")
}
