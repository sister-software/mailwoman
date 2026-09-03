/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Lift the required lines out of a gauntlet log.
 *
 *   The gauntlet is the release authority and this module adds nothing to its grading — a second implementation of it
 *   would be a second answer key. What it does is surface three things the spec says must not stay buried in a log a
 *   reader has to scroll:
 *
 *   1. The **conditional header**, which is the verdict's actual denominator. Reading the tail of a gauntlet log instead of
 *      this line is how "+15 rows, zero regressions" got reported on 2026-08-15 for a run that was 329/352 against a
 *      350/352 baseline — 21 regressions, in a line printed above the part that got read.
 *   2. The **pins line**. `run.ts` states the reason it prints on every run, pinned or not: "two pin logs that
 *      differ only in a flag someone typed are not evidence about that flag unless each log says which configuration
 *      it graded."
 *   3. The **firing count**, for the one pass that prints one. An unchanged verdict from a mechanism that never ran
 *      proves nothing — but only postcode-country coherence reports its own firing rate, so this field is named for
 *      THAT pass rather than for "the pin under test". Pin a different pin and the log carries no evidence it
 *      participated; the `unparsed` note says so rather than letting the coherence number stand in for it.
 *
 *   Every field is EXTRACTED, so every field can be absent. A pattern that does not match yields `null` and a note
 *   saying the line was not found; it never yields a plausible default. A parser that invented a `0` here would be
 *   manufacturing exactly the kind of number this repo's meaning-of-zero rule exists to forbid.
 */

interface GauntletLayerReport {
	layer: string
	gated_pass: number
	gated_total: number
	tracked: number
}

export interface GauntletReport {
	/**
	 * `PASS` / `FAIL` as the run printed it, or `null` when no verdict line appeared — a crash, or a run killed before it
	 * finished. Never defaulted to FAIL: "did not finish" and "finished and failed" are different facts.
	 */
	verdict: string | null
	layers: GauntletLayerReport[]
	/**
	 * The `describeResolverPins` line, verbatim.
	 */
	pins: string | null
	/**
	 * `{ n, of }` for the POSTCODE-COUNTRY COHERENCE pass specifically, or `null` when the log carried no firing line.
	 *
	 * Named for the mechanism it measures rather than for "the pin under test", because those are usually not the same
	 * thing: pin `gazetteerPrior` and this still reports coherence, which is the only pass that prints a firing count.
	 * Reading it as the pinned pin's firing rate would be a fabricated number.
	 */
	postcode_country_coherence_fired_on: { n: number; of: number } | null
	/**
	 * Refused rows, verbatim, in log order. These are the rows a verdict rests on.
	 */
	gated_failures: string[]
	/**
	 * Tracked rows the run flagged as now passing — the promote-to-pass candidates.
	 */
	now_passing: string[]
	/**
	 * What could not be extracted, and from which pattern. Read this before trusting an absent field.
	 */
	unparsed: string[]
}

/**
 * Only patterns whose quantifiers cannot overlap live here.
 *
 * The lines this file recognises by shape rather than by regex — the pins line, the promote line — are matched with
 * `startsWith` / `indexOf` instead. Both wanted an ambiguous quantifier to express (`(.*pins.*|.*=.*)$` and
 * `(.*?)\s+now PASSES`), which backtracks quadratically on a long non-matching line and which CodeQL flags as
 * polynomial ReDoS. A gauntlet log is our own output rather than hostile input, so the practical exposure was small —
 * but the string version is both shorter and unconditionally linear, so there was nothing to trade away.
 */
const HEADER = /^=== Gauntlet · (\S+) \((\d+)\/(\d+) gated cases pass(?:, (\d+) tracked)?\)/
const VERDICT = /^verdict: (PASS|FAIL)/
const FIRING = /^postcode-country coherence fired on (\d+)\/(\d+) cases/

const PINS_PREFIX = "[gauntlet] "
const GATED_FAILURE_MARK = "✗"
const NOW_PASSING_MARK = " now PASSES"
const NOW_PASSING_PREFIX = "+"

/**
 * Parse a gauntlet run's combined output.
 *
 * Takes stdout and stderr together because the pieces are split across them — the report goes to stdout, the pins line
 * to stderr — and a reader wanting "what did this run grade" should not have to know which stream carried which.
 */
export function parseGauntletReport(stdout: string, stderr: string): GauntletReport {
	const report: GauntletReport = {
		verdict: null,
		layers: [],
		pins: null,
		postcode_country_coherence_fired_on: null,
		gated_failures: [],
		now_passing: [],
		unparsed: [],
	}

	// The log is already fully in memory and capped at 8 MB by the job registry, so there is no stream to consume
	// lazily and no growth path.
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- bounded, already buffered
	for (const line of `${stderr}\n${stdout}`.split("\n")) {
		const header = HEADER.exec(line)

		if (header) {
			report.layers.push({
				layer: header[1]!,
				gated_pass: Number(header[2]),
				gated_total: Number(header[3]),
				tracked: header[4] ? Number(header[4]) : 0,
			})

			continue
		}

		const verdict = VERDICT.exec(line)

		if (verdict) {
			report.verdict = verdict[1]!

			continue
		}

		const firing = FIRING.exec(line)

		if (firing) {
			report.postcode_country_coherence_fired_on = { n: Number(firing[1]), of: Number(firing[2]) }

			continue
		}

		const trimmed = line.trim()

		if (trimmed.startsWith(GATED_FAILURE_MARK)) {
			report.gated_failures.push(trimmed.slice(GATED_FAILURE_MARK.length).trim())

			continue
		}

		// `+ <id> now PASSES — promote to status=pass`. Located by index rather than matched by pattern: the id can
		// contain anything, and expressing "everything up to the marker" as a regex needs a lazy quantifier followed by
		// `\s+`, which is the quadratic shape.
		if (trimmed.startsWith(NOW_PASSING_PREFIX)) {
			const marker = trimmed.indexOf(NOW_PASSING_MARK)

			if (marker > 0) {
				report.now_passing.push(trimmed.slice(NOW_PASSING_PREFIX.length, marker).trim())

				continue
			}
		}

		if (!report.pins && line.startsWith(PINS_PREFIX)) {
			const rest = line.slice(PINS_PREFIX.length).trim()

			// The pins line is the one that names a configuration — either by saying so or by carrying an assignment.
			if (rest.toLowerCase().includes("pins") || rest.includes("=")) {
				report.pins = rest
			}
		}
	}

	if (!report.verdict) {
		report.unparsed.push(
			"No `verdict:` line found. The run did not reach a verdict — read the log rather than treating this as a FAIL."
		)
	}

	if (!report.layers.length) {
		report.unparsed.push(
			"No `=== Gauntlet · <layer> (n/m gated cases pass) ===` header found, so the pass counts and their denominator " +
				"are unknown. Do not read the absence of failures as a clean run."
		)
	}

	if (!report.pins) {
		report.unparsed.push("No pins line found, so the configuration this run graded is not recorded here.")
	}

	if (!report.postcode_country_coherence_fired_on) {
		report.unparsed.push(
			"No postcode-country coherence firing line found — that pass either did not run or spoke on no rows, and this " +
				"log cannot tell them apart. NOTE: no other pin prints a firing count, so a run pinning a different pin " +
				"carries no evidence here that it participated at all."
		)
	}

	return report
}

/**
 * A one-line reading of the report, for the `summary` an agent relays.
 *
 * Leads with the admitted fraction rather than the verdict word: the fraction is the thing a reader can compare against
 * a baseline, and the line that got skipped the day this rule was written.
 */
export function summarizeGauntletReport(report: GauntletReport): string {
	if (!report.layers.length) {
		return `No gated header was found in this run's output, so there is no pass count to report. Verdict line: ${report.verdict ?? "absent"}. Read the log.`
	}

	const layers = report.layers
		.map((layer) => `${layer.layer} ${layer.gated_pass}/${layer.gated_total} gated`)
		.join("; ")

	const failures = report.gated_failures.length
		? ` ${report.gated_failures.length} gated failure${report.gated_failures.length === 1 ? "" : "s"}.`
		: ""

	const promotions = report.now_passing.length
		? ` ${report.now_passing.length} tracked row${report.now_passing.length === 1 ? "" : "s"} now pass and could be promoted.`
		: ""

	const fired = report.postcode_country_coherence_fired_on
		? ` Postcode-country coherence fired on ${report.postcode_country_coherence_fired_on.n}/${report.postcode_country_coherence_fired_on.of} rows` +
			" (that pass is the only one printing a firing count — it is not a reading on whatever pin you pinned)."
		: ""

	return `${layers}. Verdict ${report.verdict ?? "ABSENT"}.${failures}${promotions}${fired}`
}
