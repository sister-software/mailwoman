/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Wall-time attribution for one OA resolver run, written beside the run rather than into it.
 *
 *   The promotion comparator reads every file under a promotion output directory byte-for-byte, and a timing number
 *   differs between two runs of the same artifact. So a profile path must name somewhere outside that directory, and a
 *   run that passes no path writes nothing.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"

/**
 * Gazetteer queries one run made, counted before the memo answers any of them.
 */
export interface LookupCensus {
	calls: number
	keys: Set<string>
}

/**
 * The accumulators one run fills: setup is the rig build, and the two per-row totals separate the model call from the
 * gazetteer work, which no thread or concurrency setting can trade against the other.
 */
export interface RunTiming {
	setupMs: number
	loopStartedAt: number
	parse: number
	resolve: number
}

export interface RunProfileFacts {
	evalPath: string
	rows: number
	defaultCountry: string
	anchorOff: boolean
	lookupMemo: boolean
	timing: RunTiming
	census: LookupCensus | null
}

function round(ms: number): number {
	return Math.round(ms * 10) / 10
}

/**
 * Write one run's attribution, or nothing when `path` is empty.
 *
 * A row that throws inside `neural.parse` contributes to neither per-row total, so `parse_ms + resolve_ms` is a floor
 * on the loop rather than its total.
 */
export async function writeRunProfile(path: string, facts: RunProfileFacts): Promise<void> {
	if (!path) return

	const { timing, census, rows } = facts
	const loopMs = performance.now() - timing.loopStartedAt
	const perRow = Math.max(rows, 1)

	await writeLocalJSONFile(
		{
			eval: facts.evalPath,
			rows,
			defaultCountry: facts.defaultCountry,
			anchorOff: facts.anchorOff,
			lookup_memo: facts.lookupMemo,
			setup_ms: round(timing.setupMs),
			loop_ms: round(loopMs),
			parse_ms: round(timing.parse),
			resolve_ms: round(timing.resolve),
			other_ms: round(loopMs - timing.parse - timing.resolve),
			parse_ms_per_row: round(timing.parse / perRow),
			resolve_ms_per_row: round(timing.resolve / perRow),
			rss_end_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
			lookup_calls: census?.calls ?? 0,
			lookup_distinct_keys: census?.keys.size ?? 0,
			lookup_calls_per_row: round((census?.calls ?? 0) / perRow),
		},
		path
	)
}
