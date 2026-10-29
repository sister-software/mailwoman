/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Release-time exposure checks: a preflight before compute is spent, and a completed-run check before promotion.
 *
 *   A claim is a `(jurisdiction, phenomenon)` pair a shipped locale asserts it handles. A floor is the smallest
 *   realized exposure at which an exposure curve showed the phenomenon's behavior stable, with the report that
 *   established it. `floors.json` beside this module holds the floors. A floor is added only from an exposure-curve
 *   report. A claim without one reads `no-floor`: the check reports its exposure and leaves the verdict to the
 *   contrast board.
 *
 *   The preflight reads expected draws, the epoch-1 replay of the mixture times the epoch count. It refuses a config
 *   whose expected draws for a claimed phenomenon are zero, and applies no floor, because expected draws estimate
 *   realized exposure.
 *
 *   The completed-run check reads realized draws when the trainer logged them, and otherwise reports realized
 *   exposure as unmeasured rather than substituting the expectation. It refuses a claim under its floor, and any
 *   contrast group with a failing arm.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"

/**
 * The committed floors.
 */
export const FLOORS_PATH = workspacePath("mailwoman", "tools", "training", "exposure", "floors.json")

/**
 * A finding's verdict.
 */
export const Verdict = {
	Refuse: "refuse",
	Pass: "pass",
	NoFloor: "no-floor",
	Unmeasured: "unmeasured",
} as const

export type Verdict = (typeof Verdict)[keyof typeof Verdict]

/**
 * One claim's result, in the field order the Python check wrote.
 */
export interface Finding {
	jurisdiction: string
	phenomenon: string
	verdict: Verdict
	exposure: number | null
	floor: number | null
	reason: string
}

/**
 * One phenomenon's floor and the exposure-curve report that set it.
 */
export interface Floor {
	floor: number
	evidence: string
}

/**
 * The phenomenon-by-stage form counts the checks read from an exposure report.
 */
export interface ExposureForms {
	jurisdictions: Record<string, { phenomena: Record<string, Record<string, Record<string, number> | null>> }>
}

/**
 * Reads the floors by phenomenon.
 *
 * @throws When an entry has no integer `floor` or no `evidence` report.
 */
export async function loadFloors(path: string = FLOORS_PATH.toString()): Promise<Record<string, Floor>> {
	const { floors } = await readLocalJSONFile<{ floors: Record<string, Partial<Floor>> }>(path)

	for (const [phenomenon, entry] of Object.entries(floors)) {
		if (!Number.isInteger(entry.floor) || !entry.evidence) {
			throw new Error(`floor for '${phenomenon}' needs an integer \`floor\` and the \`evidence\` report that set it`)
		}
	}

	return floors as Record<string, Floor>
}

/**
 * Rows exercising `phenomenon` at `stage`, summed over its forms, or `null`
 * when the stage was not measured.
 */
function exposureOf(report: ExposureForms, stage: string, jurisdiction: string, phenomenon: string): number | null {
	const entry = report.jurisdictions[jurisdiction]

	if (!entry) return null

	const forms = entry.phenomena[phenomenon]?.[stage]

	return forms == null ? null : Object.values(forms).reduce((sum, n) => sum + n, 0)
}

/**
 * Refuses a claim whose expected draws are zero.
 * The report must include the `replayed_draws` stage.
 */
export function preflight(
	report: ExposureForms,
	claims: ReadonlyArray<readonly [string, string]>,
	epochs = 1
): Finding[] {
	return claims.map(([jurisdiction, phenomenon]) => {
		const draws = exposureOf(report, "replayed_draws", jurisdiction, phenomenon)

		const finding = (verdict: Verdict, exposure: number | null, reason: string): Finding => ({
			jurisdiction,
			phenomenon,
			verdict,
			exposure,
			floor: null,
			reason,
		})

		if (draws == null) return finding(Verdict.Unmeasured, null, "the report holds no replayed_draws stage")

		if (draws === 0) return finding(Verdict.Refuse, 0, "the config's mixture draws no row exercising it")

		return finding(Verdict.Pass, draws * epochs, `expected over ${epochs} epoch(s)`)
	})
}

/**
 * Refuses a claim under its floor and every failing contrast row (ids `<cc>-contrast-<group>-<arm>`).
 */
export function completedRun(
	report: ExposureForms,
	claims: ReadonlyArray<readonly [string, string]>,
	floors: Readonly<Record<string, Floor>>,
	contrastFailures: readonly string[] = []
): Finding[] {
	const findings: Finding[] = claims.map(([jurisdiction, phenomenon]) => {
		const realized = exposureOf(report, "realized_draws", jurisdiction, phenomenon)
		const entry = floors[phenomenon]
		const floor = entry?.floor ?? null

		const finding = (verdict: Verdict, exposure: number | null, floorValue: number | null, reason: string) => ({
			jurisdiction,
			phenomenon,
			verdict,
			exposure,
			floor: floorValue,
			reason,
		})

		if (realized == null) return finding(Verdict.Unmeasured, null, floor, "the trainer logged no realized draws")

		if (floor == null) return finding(Verdict.NoFloor, realized, null, "no exposure curve has set a floor")

		if (realized < floor) {
			return finding(Verdict.Refuse, realized, floor, `under the floor set by ${entry?.evidence}`)
		}

		return finding(Verdict.Pass, realized, floor, "at or over the floor")
	})

	for (const caseID of contrastFailures) {
		const separator = caseID.indexOf("-contrast-")

		const [country, rest] =
			separator === -1 ? [caseID, ""] : [caseID.slice(0, separator), caseID.slice(separator + "-contrast-".length)]

		findings.push({
			jurisdiction: country.toUpperCase(),
			phenomenon: `contrast:${rest}`,
			verdict: Verdict.Refuse,
			exposure: null,
			floor: null,
			reason: "contrast arm failed",
		})
	}

	return findings
}

/**
 * Whether any finding refuses.
 */
export function refused(findings: readonly Finding[]): boolean {
	return findings.some((finding) => finding.verdict === Verdict.Refuse)
}

/**
 * A `CC:PHENOMENON` argument as a claim.
 *
 * @throws When the value holds no colon.
 */
export function claimFromArgument(value: string): readonly [string, string] {
	const separator = value.indexOf(":")

	if (separator === -1) throw new Error(`--claim expects CC:PHENOMENON, got '${value}'`)

	return [value.slice(0, separator), value.slice(separator + 1)]
}
