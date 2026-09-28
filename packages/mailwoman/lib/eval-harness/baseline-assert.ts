/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Baseline assertion: a harness refuses to report when its instruments read wrong, and the check is two-sided because a metric above its registered value is as loud a signal as one below.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

/**
 * A registered baseline row, as stored in `baselines.json`.
 */
export interface RegisteredBaseline {
	/**
	 * Stable identifier: `<fixture-or-scope>.<metric>@<model-or-artifact>`.
	 */
	id: string
	harness: string
	metric: string
	model: string
	fixture?: string
	value: number
	/**
	 * Allowed relative deviation in either direction, defaulting to the file's `default_tolerance_rel`;
	 * widening it to silence a real deviation is the drift failure, so re-register instead.
	 */
	tolerance_rel?: number
	/**
	 * Absolute tolerance, taking precedence over `tolerance_rel` and required
	 * when `value` is 0 where relative deviation is undefined.
	 */
	tolerance_abs?: number
	registered_at: string
	commit: string
	command: string
	note: string
}

/**
 * Maps a harness's own metric keys to baseline ids.
 *
 * The mapping is not derivable because one model can carry both a real and a stand-in artifact id.
 */
export interface BaselineProfile {
	description: string
	observe: Record<string, string>
}

interface BaselineFile {
	default_tolerance_rel: number
	profiles: Record<string, BaselineProfile>
	baselines: RegisteredBaseline[]
}

/**
 * One harness reading, checked against the registry.
 */
export interface BaselineObservation {
	id: string
	observed: number
}

/**
 * Why a single observation failed.
 */
export interface BaselineViolation {
	id: string
	/**
	 * `unregistered` means no row exists, so the reading cannot be verified at all.
	 */
	kind: "deviation" | "unregistered"
	observed: number
	expected?: number
	/**
	 * Signed relative deviation, negative when the observation read low.
	 */
	deviationRel?: number
	tolerance?: number
	baseline?: RegisteredBaseline
}

export interface BaselineVerdict {
	ok: boolean
	violations: BaselineViolation[]
	checked: number
}

let cachedFile: BaselineFile | undefined

/**
 * Anchored at the package root because tsc does not emit `baselines.json` into `out/`,
 * so the file path derives from the package root rather than this module's location.
 */
function resolveBaselineFilePath(): string {
	return resolvePackagePath("mailwoman", "lib", "eval-harness", "baselines.json")
}

async function loadBaselineFile(): Promise<BaselineFile> {
	if (!cachedFile) {
		cachedFile = await readLocalJSONFile<BaselineFile>(resolveBaselineFilePath())
	}

	return cachedFile
}

/**
 * Every registered baseline, for tooling that wants to list or audit them.
 */
export async function listBaselines(): Promise<RegisteredBaseline[]> {
	return (await loadBaselineFile()).baselines
}

export async function findBaseline(id: string): Promise<RegisteredBaseline | undefined> {
	return (await loadBaselineFile()).baselines.find((b) => b.id === id)
}

export async function listProfiles(): Promise<string[]> {
	return Object.keys((await loadBaselineFile()).profiles)
}

/**
 * Look up a profile, refusing loudly on a typo rather than silently checking no profile.
 */
export async function resolveProfile(name: string): Promise<BaselineProfile> {
	const profile = (await loadBaselineFile()).profiles[name]

	if (!profile) {
		throw new Error(
			`Unknown baseline profile "${name}". Registered: ${(await listProfiles()).join(", ") || "(none)"}. ` +
				`Add one to mailwoman/eval-harness/baselines.json, or omit the flag for an unregistered candidate.`
		)
	}

	return profile
}

/**
 * Checks a harness's readings against a profile, ignoring metric keys the profile does not map.
 */
export async function assertProfile(name: string, readings: Record<string, number>): Promise<BaselineVerdict> {
	const profile = await resolveProfile(name)
	const observations: BaselineObservation[] = []

	for (const [metricKey, id] of Object.entries(profile.observe)) {
		const observed = readings[metricKey]

		if (observed === undefined) continue
		observations.push({ id, observed })
	}

	return assertBaselines(observations)
}

/**
 * Checks observations against the registry, where an unregistered id is a violation rather than a pass.
 */
export async function assertBaselines(observations: BaselineObservation[]): Promise<BaselineVerdict> {
	const file = await loadBaselineFile()
	const violations: BaselineViolation[] = []

	for (const observation of observations) {
		const baseline = await findBaseline(observation.id)

		if (!baseline) {
			violations.push({ id: observation.id, kind: "unregistered", observed: observation.observed })

			continue
		}

		const tolerance = baseline.tolerance_rel ?? file.default_tolerance_rel

		// An absolute tolerance wins when declared, and a zero-valued row must declare one
		// because relative deviation is undefined.
		if (baseline.tolerance_abs !== undefined || baseline.value === 0) {
			const toleranceAbs = baseline.tolerance_abs ?? 0
			const drift = Math.abs(observation.observed - baseline.value)

			if (drift > toleranceAbs) {
				violations.push({
					id: observation.id,
					kind: "deviation",
					observed: observation.observed,
					expected: baseline.value,
					tolerance: toleranceAbs,
					baseline,
				})
			}

			continue
		}

		const deviationRel = (observation.observed - baseline.value) / Math.abs(baseline.value)

		// Two-sided on purpose: a metric that jumps is a metric that probably changed meaning.
		if (Math.abs(deviationRel) > tolerance) {
			violations.push({
				id: observation.id,
				kind: "deviation",
				observed: observation.observed,
				expected: baseline.value,
				deviationRel,
				tolerance,
				baseline,
			})
		}
	}

	return { ok: violations.length === 0, violations, checked: observations.length }
}

export class BaselineDeviationError extends Error {
	readonly verdict: BaselineVerdict

	constructor(verdict: BaselineVerdict) {
		super(formatVerdict(verdict))
		this.name = "BaselineDeviationError"
		this.verdict = verdict
	}
}

/**
 * Renders a verdict for a terminal, the message a refusing harness prints instead of a report.
 */
export function formatVerdict(verdict: BaselineVerdict): string {
	if (verdict.ok) return `baseline check: ${verdict.checked} observation(s) within tolerance`

	const lines = [
		`REFUSING TO REPORT — ${verdict.violations.length} of ${verdict.checked} baseline check(s) failed.`,
		"",
		"A harness reading this far from its registered baseline is measuring something other than",
		"what it claims. Find the instrument bug before trusting any number in this run.",
		"",
	]

	for (const violation of verdict.violations) {
		if (violation.kind === "unregistered") {
			lines.push(
				`  ✗ ${violation.id}`,
				`      observed  ${violation.observed}`,
				`      NO REGISTERED BASELINE — this reading cannot be verified. Register it in`,
				`      mailwoman/eval-harness/baselines.json (commit + command + note required).`,
				""
			)

			continue
		}

		const percent = violation.deviationRel === undefined ? "n/a" : `${(violation.deviationRel * 100).toFixed(1)}%`
		const direction = (violation.deviationRel ?? 0) < 0 ? "LOW" : "HIGH"

		lines.push(
			`  ✗ ${violation.id}  reads ${direction}`,
			`      observed  ${violation.observed}`,
			`      expected  ${violation.expected}  (±${((violation.tolerance ?? 0) * 100).toFixed(0)}%)`,
			`      deviation ${percent}`,
			`      baseline  registered ${violation.baseline?.registered_at} @ ${violation.baseline?.commit}`,
			`      meaning   ${violation.baseline?.note}`,
			`      reproduce ${violation.baseline?.command}`,
			""
		)
	}

	lines.push(
		"If the number legitimately moved (new fixture, new tokenizer, a real model change),",
		"RE-REGISTER the baseline with a new row and a reason. Do not widen tolerance_rel to make",
		"this quiet — that is silent check drift."
	)

	return lines.join("\n")
}

/**
 * Asserts the observations and throws on a deviation, the one-liner a harness puts
 * before it prints anything.
 */
export async function guardReport(observations: BaselineObservation[]): Promise<void> {
	const verdict = await assertBaselines(observations)

	if (!verdict.ok) throw new BaselineDeviationError(verdict)
}
