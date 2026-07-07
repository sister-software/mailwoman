/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   2D pre-publish eval gate. Consumes two per-tag eval JSON files (produced by
 *   `scripts/eval-morphology-fst.ts --out-json`) and applies the DeepSeek-turn-1 2D threshold:
 *
 *   ```
 *   FAIL if  (recall drop > recall_threshold_pp  AND baseline_recall > recall_min_baseline_pct)
 *   OR (hallucination spike > hall_abs_threshold
 *       AND new_hallucination_rate > hall_rate_threshold_pct)
 * ```
 *
 *   The two-dimensional shape is critical. A recall-only gate (DeepSeek turn 1 "v0.6.1 would sail
 *   through") misses the case where a tag's recall holds steady but its hallucination count
 *   explodes — exactly what happened to v0.6.1's `dependent_locality` (0 → 1066). A
 *   hallucination-only gate misses the case where a tag silently stops being emitted but recall on
 *   it was already low.
 *
 *   Both dimensions must guard. The thresholds match the [Layer 1 eval doc's "what v0.6.2
 *   needs"](../docs/articles/evals/2026-05-28-layer-1-morphology-fst.md): 2pp recall, 100 absolute
 *   hallucination spike, 20% hallucination-rate ceiling.
 *
 *   Usage: node --experimental-strip-types scripts/eval-gate.ts\
 *   --baseline /tmp/eval-v0.6.1.json\
 *   --candidate /tmp/eval-v0.6.2.json\
 *   [--recall-threshold-pp 2]\
 *   [--recall-min-baseline-pct 10]\
 *   [--hall-abs-threshold 100]\
 *   [--hall-rate-threshold-pct 20]\
 *   [--out-md /tmp/gate-report.md]
 *
 *   Exit: 0 on PASS, 1 on FAIL. Always prints a per-tag diff table to stdout.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { parseArgs as parseNodeArgs } from "node:util"

interface PerTagStats {
	expected: number
	correct: number
	missed: number
	boundary: number
	confused: number
	hallucinated: number
	recall_pct: number
	hallucination_rate_pct: number
}

interface EvalReport {
	name: string
	golden_set: number
	exact_match_pct: number
	model: string
	admin_fst?: string | null
	morphology_enabled?: boolean
	per_tag: Record<string, PerTagStats>
}

interface GateArgs {
	baselinePath: string
	candidatePath: string
	recallThresholdPp: number
	recallMinBaselinePct: number
	hallAbsThreshold: number
	hallRateThresholdPct: number
	outMd?: string
}

function parseArgs(): GateArgs {
	const out: Partial<GateArgs> = {
		recallThresholdPp: 2,
		recallMinBaselinePct: 10,
		hallAbsThreshold: 100,
		hallRateThresholdPct: 20,
	}

	// node:util parseArgs (strict:false = old scan parity: unknown flags tolerated)
	const { values } = parseNodeArgs({
		options: {
			baseline: { type: "string" },
			candidate: { type: "string" },
			"hall-abs-threshold": { type: "string" },
			"hall-rate-threshold-pct": { type: "string" },
			"out-md": { type: "string" },
			"recall-min-baseline-pct": { type: "string" },
			"recall-threshold-pp": { type: "string" },
		},
		strict: false,
		allowPositionals: true,
	})

	if (values["baseline"] != null) {
		out.baselinePath = values["baseline"] as string
	}

	if (values["candidate"] != null) {
		out.candidatePath = values["candidate"] as string
	}

	if (values["recall-threshold-pp"] != null) {
		out.recallThresholdPp = Number(values["recall-threshold-pp"] as string)
	}

	if (values["recall-min-baseline-pct"] != null) {
		out.recallMinBaselinePct = Number(values["recall-min-baseline-pct"] as string)
	}

	if (values["hall-abs-threshold"] != null) {
		out.hallAbsThreshold = Number(values["hall-abs-threshold"] as string)
	}

	if (values["hall-rate-threshold-pct"] != null) {
		out.hallRateThresholdPct = Number(values["hall-rate-threshold-pct"] as string)
	}

	if (values["out-md"] != null) {
		out.outMd = values["out-md"] as string
	}

	if (!out.baselinePath || !out.candidatePath) {
		console.error(
			"Usage: scripts/eval-gate.ts --baseline <json> --candidate <json> [--recall-threshold-pp 2] [--recall-min-baseline-pct 10] [--hall-abs-threshold 100] [--hall-rate-threshold-pct 20] [--out-md <path>]"
		)
		process.exit(2)
	}

	return out as GateArgs
}

interface TagViolation {
	tag: string
	kind: "recall" | "hallucination"
	baseline: PerTagStats
	candidate: PerTagStats
	detail: string
}

function evaluate(
	baseline: EvalReport,
	candidate: EvalReport,
	args: GateArgs
): { violations: TagViolation[]; rows: string[] } {
	const violations: TagViolation[] = []
	const rows: string[] = []

	const allTags = new Set<string>([...Object.keys(baseline.per_tag), ...Object.keys(candidate.per_tag)])
	const sortedTags = [...allTags].sort((a, b) => {
		// Order by baseline expected count desc — important tags first.
		const ea = baseline.per_tag[a]?.expected ?? 0
		const eb = baseline.per_tag[b]?.expected ?? 0

		return eb - ea
	})

	for (const tag of sortedTags) {
		const b = baseline.per_tag[tag]
		const c = candidate.per_tag[tag]

		if (!b || !c) {
			// Either side missing the tag — fall through and emit a diff row but no gate violation
			// (a tag that didn't exist in one eval is a schema diff, not a regression).
			rows.push(`| ${tag} | ${b ? b.expected : "—"} | ${c ? c.expected : "—"} | (schema diff) |`)
			continue
		}

		const recallDeltaPp = c.recall_pct - b.recall_pct
		const hallDeltaAbs = c.hallucinated - b.hallucinated
		const candidateHallRate = c.hallucination_rate_pct

		// --- Recall regression gate -----------------------------------------------------------
		// Recall drop is meaningful when (a) the drop is large and (b) the baseline was high
		// enough that the drop isn't noise on a sparse tag.
		if (-recallDeltaPp > args.recallThresholdPp && b.recall_pct > args.recallMinBaselinePct) {
			violations.push({
				tag,
				kind: "recall",
				baseline: b,
				candidate: c,
				detail: `recall ${b.recall_pct.toFixed(1)}% → ${c.recall_pct.toFixed(1)}% (Δ ${recallDeltaPp.toFixed(1)}pp; baseline > ${args.recallMinBaselinePct}%)`,
			})
		}

		// --- Hallucination spike gate ---------------------------------------------------------
		// Hallucination spike is meaningful when (a) absolute count grew significantly and (b)
		// the new rate (hallucinations / expected occurrences) is high. This catches v0.6.1-style
		// dep_loc explosions (0 → 1066, with `expected=40` → 2650% hallucination rate).
		if (hallDeltaAbs > args.hallAbsThreshold && candidateHallRate > args.hallRateThresholdPct) {
			violations.push({
				tag,
				kind: "hallucination",
				baseline: b,
				candidate: c,
				detail: `hallucinated ${b.hallucinated} → ${c.hallucinated} (Δ +${hallDeltaAbs}; new rate ${candidateHallRate.toFixed(1)}% of expected)`,
			})
		}

		const arrow = recallDeltaPp > 0.1 ? "↑" : recallDeltaPp < -0.1 ? "↓" : "→"
		const hallArrow = hallDeltaAbs > 5 ? "↑" : hallDeltaAbs < -5 ? "↓" : "→"
		rows.push(
			`| ${tag} | ${b.expected} | ${b.recall_pct.toFixed(1)}% ${arrow} ${c.recall_pct.toFixed(1)}% (${recallDeltaPp >= 0 ? "+" : ""}${recallDeltaPp.toFixed(1)}pp) | ${b.hallucinated} ${hallArrow} ${c.hallucinated} (${hallDeltaAbs >= 0 ? "+" : ""}${hallDeltaAbs}) |`
		)
	}

	return { violations, rows }
}

function buildReport(
	baseline: EvalReport,
	candidate: EvalReport,
	args: GateArgs,
	violations: TagViolation[],
	rows: string[]
): string {
	const lines: string[] = []
	const verdict = violations.length === 0 ? "**PASS** ✓" : "**FAIL** ✗"
	lines.push(`# Eval Gate: ${verdict}`)
	lines.push("")
	lines.push(
		`- **Baseline:** \`${baseline.name}\` — ${baseline.golden_set} entries, ${baseline.exact_match_pct.toFixed(1)}% exact-match`
	)
	lines.push(
		`- **Candidate:** \`${candidate.name}\` — ${candidate.golden_set} entries, ${candidate.exact_match_pct.toFixed(1)}% exact-match`
	)
	lines.push("")
	lines.push(
		`**Thresholds:** recall drop > ${args.recallThresholdPp}pp on tags with baseline > ${args.recallMinBaselinePct}% recall, OR hallucination spike > ${args.hallAbsThreshold} with new rate > ${args.hallRateThresholdPct}% of expected occurrences.`
	)
	lines.push("")

	if (violations.length > 0) {
		lines.push(`## Violations (${violations.length})`)
		lines.push("")

		for (const v of violations) {
			lines.push(`- **${v.tag}** (${v.kind}) — ${v.detail}`)
		}
		lines.push("")
	}
	lines.push("## Per-tag diff")
	lines.push("")
	lines.push("| Tag | Expected | Recall (baseline → candidate) | Hallucinated (baseline → candidate) |")
	lines.push("|-----|----------|-------------------------------|-------------------------------------|")

	for (const r of rows) {
		lines.push(r)
	}
	lines.push("")

	return lines.join("\n")
}

function main(): void {
	const args = parseArgs()
	const baseline = JSON.parse(readFileSync(args.baselinePath, "utf8")) as EvalReport
	const candidate = JSON.parse(readFileSync(args.candidatePath, "utf8")) as EvalReport

	const { violations, rows } = evaluate(baseline, candidate, args)
	const report = buildReport(baseline, candidate, args, violations, rows)

	console.log(report)

	if (args.outMd) {
		writeFileSync(args.outMd, report)
		console.error(`Wrote gate report to ${args.outMd}`)
	}

	if (violations.length > 0) {
		console.error(`GATE FAILED: ${violations.length} violation(s).`)
		process.exit(1)
	}
	console.error("GATE PASSED.")
	process.exit(0)
}

main()
