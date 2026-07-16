/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Harness baseline assertion — an eval refuses to produce a report when its instruments read
 *   wrong (#727 stage-2, Tier 0).
 *
 *   This is NOT a promotion gate. `promotion-gate.ts` asks "is this model good enough to ship";
 *   this asks "is this harness measuring what it thinks it is". A gate spec's floors are one-sided
 *   (higher is better, fail below); a baseline is TWO-SIDED — a metric 40% ABOVE its registered
 *   value is as loud a signal as 40% below, because the usual cause is that the number changed
 *   meaning, not that the model got better. That two-sidedness is the whole point; a one-sided
 *   check would have passed both incidents below.
 *
 *   Why it exists — two verdicts nearly went out wrong in a single arc, both from a harness
 *   reporting confidently on a broken instrument:
 *
 *   - Phase 1 read street token@1 = 0.348 against a v264 known-good of 0.573 (-39%). Two bugs:
 *       a missing `map_location` in `from_pretrained()` and piece-concatenation welding words
 *       ("5thAve"). The number was reported before the cause was found.
 *   - Phase 4a measured a resolver rerank while the resolver reached street tier 0/267 times —
 *       no street shards were wired. The instrument was dark and the report read as a finding.
 *       The verdict was VOID; see `2026-07-16-phase4a-rerank-invalid-measurement.md`.
 *
 *   A registered baseline covers BOTH shapes, because instrument-health preconditions register the
 *   same way headline metrics do — `paris.resolver.street_evidence_rate@ban-street-centroids` is a
 *   row like any other, and a dark resolver reading 0.000 deviates from it past its band.
 *
 *   Usage — declare what the harness depends on, pass observations, let it refuse:
 *
 *   ```ts
 *   const verdict = assertBaselines([
 *   	{ id: "parity.street.token_at_1@v264", observed: streetTokenAt1 },
 *   	{ id: "paris.resolver.street_evidence_rate@ban-street-centroids", observed: withStreet / total },
 *   ])
 *   if (!verdict.ok) throw new BaselineDeviationError(verdict)
 *   // …or simply: guardReport([...]) — which throws on your behalf.
 *   ```
 *
 *   A harness with several readings should use a PROFILE instead (`assertProfile("v264", {…})`),
 *   which maps its own metric keys to ids in one declared place — see `baselines.json`.
 *
 *   Registering a baseline is a deliberate act: `baselines.json` demands a commit, a command, and
 *   a note saying what the number means. A baseline you can't reproduce from its own row isn't a
 *   baseline, it's a rumor. When a number legitimately moves (new fixture, new tokenizer, a real
 *   model change), RE-REGISTER it with a fresh row and a reason — never widen the tolerance to make
 *   a deviation quiet. That's the silent-gate-drift failure wearing a different hat.
 */

import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** A registered baseline row, as stored in `baselines.json`. */
export interface RegisteredBaseline {
	/** Stable identifier: `<fixture-or-scope>.<metric>@<model-or-artifact>`. */
	id: string
	/** Which harness module reads this number. */
	harness: string
	/** Human-readable metric name. */
	metric: string
	/** Model / artifact label the number was measured on. */
	model: string
	/** Fixture the number was measured over, when applicable. */
	fixture?: string
	/** The registered value. */
	value: number
	/**
	 * Allowed relative deviation, either direction. Defaults to the file's `default_tolerance_rel`. Widening this to
	 * silence a real deviation is the drift failure — re-register instead.
	 */
	tolerance_rel?: number
	/**
	 * Absolute tolerance. Takes precedence over `tolerance_rel` when declared — use it for small-count metrics whose
	 * relative band is meaningless (one fixture out of 63 moves a rate of 1/63 by 100%). Required when `value` is 0,
	 * where relative deviation is undefined.
	 */
	tolerance_abs?: number
	/** ISO date the row was registered. */
	registered_at: string
	/** Commit the number was measured at. */
	commit: string
	/** The command that reproduces it. */
	command: string
	/** What the number means, and what a deviation would imply. */
	note: string
}

/**
 * Maps a harness's own metric keys to baseline ids. Exists because the mapping isn't derivable: v264 has no span head,
 * so oracle-k's segment decode is the summed-BIO stand-in (`@v264-summed-bio`) while its token decode is the real thing
 * (`@v264`).
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

/** One harness reading, checked against the registry. */
export interface BaselineObservation {
	id: string
	observed: number
}

/** Why a single observation failed. */
export interface BaselineViolation {
	id: string
	/** `unregistered` — no row exists, so the reading cannot be verified at all. */
	kind: "deviation" | "unregistered"
	observed: number
	expected?: number
	/** Signed relative deviation; negative means the observation read low. */
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
 * `new URL`-relative for the source tree, with a compiled-tree fallback — tsc does not emit readFileSync'd JSON into
 * `out/`, so `mailwoman/out/eval-harness/` reads the source-tree copy at `mailwoman/eval-harness/baselines.json`. Same
 * bridge as `resolveGateSpecPath`.
 */
function resolveBaselineFilePath(): string {
	const sibling = new URL("./baselines.json", import.meta.url)

	if (existsSync(sibling)) return fileURLToPath(sibling)

	return fileURLToPath(new URL("../../eval-harness/baselines.json", import.meta.url))
}

function loadBaselineFile(): BaselineFile {
	if (!cachedFile) {
		cachedFile = JSON.parse(readFileSync(resolveBaselineFilePath(), "utf8")) as BaselineFile
	}

	return cachedFile
}

/** Every registered baseline, for tooling that wants to list or audit them. */
export function listBaselines(): RegisteredBaseline[] {
	return loadBaselineFile().baselines
}

export function findBaseline(id: string): RegisteredBaseline | undefined {
	return loadBaselineFile().baselines.find((b) => b.id === id)
}

export function listProfiles(): string[] {
	return Object.keys(loadBaselineFile().profiles)
}

/** Look up a profile, refusing loudly on a typo rather than silently checking nothing. */
export function resolveProfile(name: string): BaselineProfile {
	const profile = loadBaselineFile().profiles[name]

	if (!profile) {
		throw new Error(
			`Unknown baseline profile "${name}". Registered: ${listProfiles().join(", ") || "(none)"}. ` +
				`Add one to mailwoman/eval-harness/baselines.json, or omit the flag for an unregistered candidate.`
		)
	}

	return profile
}

/**
 * Check a harness's readings against a profile. Metric keys the profile doesn't map are ignored — a profile declares
 * what it can vouch for, not everything a harness happens to compute.
 */
export function assertProfile(name: string, readings: Record<string, number>): BaselineVerdict {
	const profile = resolveProfile(name)
	const observations: BaselineObservation[] = []

	for (const [metricKey, id] of Object.entries(profile.observe)) {
		const observed = readings[metricKey]

		if (observed === undefined) continue
		observations.push({ id, observed })
	}

	return assertBaselines(observations)
}

/**
 * Check observations against the registry. An unregistered id is a violation, not a pass — an unverifiable reading is
 * exactly the state both incidents were in.
 */
export function assertBaselines(observations: BaselineObservation[]): BaselineVerdict {
	const file = loadBaselineFile()
	const violations: BaselineViolation[] = []

	for (const observation of observations) {
		const baseline = findBaseline(observation.id)

		if (!baseline) {
			violations.push({ id: observation.id, kind: "unregistered", observed: observation.observed })
			continue
		}

		const tolerance = baseline.tolerance_rel ?? file.default_tolerance_rel

		// An absolute tolerance wins when declared. Small-count metrics (a street-evidence rate of
		// 1/63) have a meaningless relative band — one fixture moves it 100% — so those rows opt out
		// of relative checking entirely. A zero-valued row MUST declare one; relative is undefined.
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

/** Render a verdict for a terminal — the message a refusing harness prints instead of a report. */
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
		"this quiet — that is silent gate drift."
	)

	return lines.join("\n")
}

/** Assert, or throw. The one-liner a harness puts before it prints anything. */
export function guardReport(observations: BaselineObservation[]): void {
	const verdict = assertBaselines(observations)

	if (!verdict.ok) throw new BaselineDeviationError(verdict)
}
