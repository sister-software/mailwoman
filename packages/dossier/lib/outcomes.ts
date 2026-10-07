/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Operator outcomes measure the explanation section. Blocker accuracy is the number of investigated
 *   explanations that held, over the dispositions with a recorded outcome. Time saved is the operator's
 *   baseline less the minutes spent, summed over the outcomes that record both. Each measure states its
 *   denominator, and a measure with no qualifying outcome is unknown rather than zero.
 */

import { type OperatorDisposition, type Statement, StatementKind } from "#explanations"
import { distinctSources, type SourceRecordID } from "#sources"

export type BlockerAccuracy =
	| { status: "measured"; held: number; denominator: number; sources: readonly SourceRecordID[] }
	| { status: "unknown"; reason: string }

export type TimeSaved =
	| { status: "measured"; minutes: number; denominator: number; sources: readonly SourceRecordID[] }
	| { status: "unknown"; reason: string }

export interface OutcomeReport {
	dispositions: number
	/**
	 * Dispositions without a recorded outcome.
	 * Neither measure counts them.
	 */
	pending: number
	/**
	 * The records of the dispositions that await an outcome.
	 */
	pendingSources: readonly SourceRecordID[]
	blockerAccuracy: BlockerAccuracy
	timeSaved: TimeSaved
}

/**
 * Measures blocker accuracy and time saved over the given dispositions.
 */
export function reportOutcomes(dispositions: readonly OperatorDisposition[]): OutcomeReport {
	const outcomes = dispositions.flatMap((disposition) => (disposition.outcome ? [disposition.outcome] : []))

	const timed = outcomes.flatMap((outcome) =>
		outcome.minutesSpent !== null && outcome.baselineMinutes !== null
			? [{ saved: outcome.baselineMinutes - outcome.minutesSpent, source: outcome.evidence.source }]
			: []
	)

	return {
		dispositions: dispositions.length,
		pending: dispositions.length - outcomes.length,
		pendingSources: distinctSources(
			dispositions.flatMap((disposition) => (disposition.outcome ? [] : [disposition.evidence.source]))
		),
		blockerAccuracy: outcomes.length
			? {
					status: "measured",
					held: outcomes.filter((outcome) => outcome.held).length,
					denominator: outcomes.length,
					sources: distinctSources(outcomes.map((outcome) => outcome.evidence.source)),
				}
			: { status: "unknown", reason: "no disposition records an outcome" },
		timeSaved: timed.length
			? {
					status: "measured",
					minutes: timed.reduce((sum, entry) => sum + entry.saved, 0),
					denominator: timed.length,
					sources: distinctSources(timed.map((entry) => entry.source)),
				}
			: { status: "unknown", reason: "no outcome records both the minutes spent and the operator's baseline" },
	}
}

/**
 * The report's statements for an {@link OutcomeReport}.
 *
 * A measured value is an estimate with its denominator.
 * An unknown measure is an absence: a deduction that states which record it lacks.
 *
 * The count of dispositions that await an outcome cites those dispositions' records.
 */
export function outcomeStatements(report: OutcomeReport): readonly Statement[] {
	const statements: Statement[] = []
	const { blockerAccuracy, timeSaved } = report

	if (blockerAccuracy.status === "measured") {
		statements.push({
			kind: StatementKind.Estimate,
			text: `The investigated explanation held in ${blockerAccuracy.held} of ${blockerAccuracy.denominator} dispositions with a recorded outcome.`,
			sources: blockerAccuracy.sources,
			absence: false,
		})
	} else {
		statements.push({
			kind: StatementKind.Deduction,
			text: `Blocker accuracy is unknown because ${blockerAccuracy.reason}.`,
			sources: [],
			absence: true,
		})
	}

	if (timeSaved.status === "measured") {
		const outcomes = `${timeSaved.denominator} ${timeSaved.denominator === 1 ? "outcome that records" : "outcomes that record"} both times`

		const change =
			timeSaved.minutes >= 0 ? `saved ${timeSaved.minutes} minutes` : `took ${-timeSaved.minutes} minutes longer`

		statements.push({
			kind: StatementKind.Estimate,
			text: `Against the operator's baselines, the investigations ${change} over ${outcomes}.`,
			sources: timeSaved.sources,
			absence: false,
		})
	} else {
		statements.push({
			kind: StatementKind.Deduction,
			text: `Time saved is unknown because ${timeSaved.reason}.`,
			sources: [],
			absence: true,
		})
	}

	if (report.pending > 0) {
		statements.push({
			kind: StatementKind.Fact,
			text: `${report.pending} of ${report.dispositions} dispositions ${report.pending === 1 ? "awaits" : "await"} an outcome.`,
			sources: report.pendingSources,
			absence: false,
		})
	}

	return statements
}
