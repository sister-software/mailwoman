/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Operator results measure the explanation section. Blocker accuracy is the number of investigated
 *   explanations that held, over the dispositions with a recorded result. Time saved is the operator's
 *   baseline less the minutes spent, summed over the results that record both. Each measure states its
 *   denominator, and a measure with no qualifying result is unknown rather than zero.
 */

import { type OperatorDisposition, type Statement, StatementKind } from "#explanations"
import { distinctSources, type SourceRecordID } from "#sources"

export type BlockerAccuracy =
	| { status: "measured"; held: number; denominator: number; sources: readonly SourceRecordID[] }
	| { status: "unknown"; reason: string }

export type TimeSaved =
	| { status: "measured"; minutes: number; denominator: number; sources: readonly SourceRecordID[] }
	| { status: "unknown"; reason: string }

export interface OperatorResultReport {
	dispositions: number
	/**
	 * Dispositions without a recorded result.
	 * Neither measure counts them.
	 */
	pending: number
	/**
	 * The records of the dispositions that await an result.
	 */
	pendingSources: readonly SourceRecordID[]
	blockerAccuracy: BlockerAccuracy
	timeSaved: TimeSaved
}

/**
 * Measures blocker accuracy and time saved over the given dispositions.
 */
export function reportOperatorResults(dispositions: readonly OperatorDisposition[]): OperatorResultReport {
	const results = dispositions.flatMap((disposition) => (disposition.result ? [disposition.result] : []))

	const timed = results.flatMap((result) =>
		result.minutesSpent !== null && result.baselineMinutes !== null
			? [{ saved: result.baselineMinutes - result.minutesSpent, source: result.evidence.source }]
			: []
	)

	return {
		dispositions: dispositions.length,
		pending: dispositions.length - results.length,
		pendingSources: distinctSources(
			dispositions.flatMap((disposition) => (disposition.result ? [] : [disposition.evidence.source]))
		),
		blockerAccuracy: results.length
			? {
					status: "measured",
					held: results.filter((result) => result.held).length,
					denominator: results.length,
					sources: distinctSources(results.map((result) => result.evidence.source)),
				}
			: { status: "unknown", reason: "no disposition records an result" },
		timeSaved: timed.length
			? {
					status: "measured",
					minutes: timed.reduce((sum, entry) => sum + entry.saved, 0),
					denominator: timed.length,
					sources: distinctSources(timed.map((entry) => entry.source)),
				}
			: { status: "unknown", reason: "no result records both the minutes spent and the operator's baseline" },
	}
}

/**
 * The report's statements for an {@link OperatorResultReport}.
 *
 * A measured value is an estimate with its denominator.
 * An unknown measure is an absence: a deduction that states which record it lacks.
 *
 * The count of dispositions that await an result cites those dispositions' records.
 */
export function operatorResultStatements(report: OperatorResultReport): readonly Statement[] {
	const statements: Statement[] = []
	const { blockerAccuracy, timeSaved } = report

	if (blockerAccuracy.status === "measured") {
		statements.push({
			kind: StatementKind.Estimate,
			text: `The investigated explanation held in ${blockerAccuracy.held} of ${blockerAccuracy.denominator} dispositions with a recorded result.`,
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
		const results = `${timeSaved.denominator} ${timeSaved.denominator === 1 ? "result that records" : "results that record"} both times`

		const change =
			timeSaved.minutes >= 0 ? `saved ${timeSaved.minutes} minutes` : `took ${-timeSaved.minutes} minutes longer`

		statements.push({
			kind: StatementKind.Estimate,
			text: `Against the operator's baselines, the investigations ${change} over ${results}.`,
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
			text: `${report.pending} of ${report.dispositions} dispositions ${report.pending === 1 ? "awaits" : "await"} an result.`,
			sources: report.pendingSources,
			absence: false,
		})
	}

	return statements
}
