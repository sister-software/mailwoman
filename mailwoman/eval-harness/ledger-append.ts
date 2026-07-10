/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ledger-append (#885) — turn a promotion-gate out-dir into one row of
 *   `evals/scores-by-version.json`, so the per-version score ledger updates itself instead of
 *   relying on discipline (which is how it froze at v4.4.0 for eleven releases).
 *
 *   Metric values come from the out-dir's `verdict.json` (the gate's own floor readings — the
 *   same numbers the promote decision used). Run metadata (corpus, steps, hardware) defaults from
 *   the model-card; everything is overridable by option. Rows follow the file's PRACTICED shape
 *   (the v4.4.0 row): the strict schema wants 64-hex digests for corpus/eval-set, but the
 *   populated rows use free-text pointers — this tool warns on that drift, it does not fail.
 *
 *   Refuses to append a duplicate (same model_version + run_id) unless `replace`, and always
 *   validates the result is parseable JSON before writing (write-to-temp, then rename).
 *
 *   Usage:
 *     mailwoman eval ledger-append \
 *       --out-dir /path/to/gate-out --model-version 5.0.0 \
 *       --run-id v193a3-anchor-absorption-step080000-rescore-20260702 \
 *       --model-path "@mailwoman/neural-weights-en-us@5.0.0" \
 *       [--card neural-weights-en-us/model-card.json] [--notes "..."] [--replace]
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"

/** Options for {@linkcode ledgerAppend}. */
export interface LedgerAppendOptions {
	/** The promotion-gate out-dir carrying `verdict.json`. */
	outDir?: string
	/** The npm semver being ledgered. */
	modelVersion?: string
	/** Stable run id (`^[a-z0-9-]+$`). */
	runId?: string
	/** The published artifact pointer, e.g. `@mailwoman/neural-weights-en-us@5.0.0`. */
	modelPath?: string
	/** Model card JSON (run-metadata defaults). Default `neural-weights-en-us/model-card.json`. */
	card?: string
	/** The ledger file. Default `evals/scores-by-version.json`. */
	ledger?: string
	/** ISO date the model trained. Default: today. */
	trainedAt?: string
	/** Free-text notes appended to the row. */
	notes?: string
	/** Overwrite an existing row for the same run_id / model_version. */
	replace?: boolean
	/**
	 * The gate-revision escape (mirrors the no-silent-gate-drift discipline): a FAIL verdict may be ledgered ONLY when
	 * every failing check is named here — i.e. the operator adjudicated the exact miss at a fork (e.g. a per-artifact
	 * int8-delta exception recorded in the gate spec's $revision comment). The excepted checks are stamped into the row's
	 * notes; any UNnamed failure still refuses. Repeatable.
	 */
	operatorException?: string[]
}

interface Verdict {
	label: string
	graded_artifact: string
	verdict: string
	results: Record<string, { floor: number; actual: number; pass: boolean }>
}

interface ModelCard {
	training?: { corpus_version?: string; steps?: number; hardware?: string }
}

interface Ledger {
	schema_version: number
	runs: Array<{ run_id: string; model_version: string }>
}

/**
 * Append one gate run to the ledger. Returns the process-style exit code the old script used: 0 = appended, 1 = refused
 * (duplicate without `replace`, or an un-excepted FAIL verdict), 2 = usage error.
 */
export function ledgerAppend(options: LedgerAppendOptions): number {
	const card = options.card ?? "neural-weights-en-us/model-card.json"
	const ledgerPath = options.ledger ?? "evals/scores-by-version.json"
	const notes = options.notes ?? ""

	for (const [flag, value] of [
		["out-dir", options.outDir],
		["model-version", options.modelVersion],
		["run-id", options.runId],
		["model-path", options.modelPath],
	] as const) {
		if (!value) {
			console.error(`✗ --${flag} required`)

			return 2
		}
	}

	const runID = options.runId!

	if (!/^[a-z0-9-]+$/.test(runID)) {
		console.error(`✗ --run-id must match ^[a-z0-9-]+$ (got: ${runID})`)

		return 2
	}

	const verdict = JSON.parse(readFileSync(`${options.outDir}/verdict.json`, "utf8")) as Verdict
	const exceptions = options.operatorException ?? []
	let exceptionNote = ""

	if (verdict.verdict !== "PASS") {
		const failing = Object.entries(verdict.results)
			.filter(([, r]) => !r.pass)
			.map(([k]) => k)
		const unexcepted = failing.filter((k) => !exceptions.includes(k))

		if (unexcepted.length > 0) {
			console.error(
				`✗ refusing to ledger a ${verdict.verdict} verdict — the ledger records shipped/shippable runs.\n` +
					`  failing checks: ${failing.join(", ")}\n` +
					`  (only ${exceptions.length ? exceptions.join(", ") : "none"} are operator-excepted; ` +
					`name each adjudicated miss via --operator-exception)`
			)

			return 1
		}
		exceptionNote = ` OPERATOR-EXCEPTED CHECKS (adjudicated at the promote fork, see the gate spec's revision comment): ${failing.join(", ")}.`
		console.error(`! ledgering a FAIL verdict under operator exception: ${failing.join(", ")}`)
	}

	// verdict floor keys → the ledger's practiced metrics shape (the v4.4.0 row).
	const KEY_MAP: Record<string, [group: string, name: string]> = {
		"us.postcode": ["us", "postcode"],
		"us.country_homograph_f1": ["us", "country_homograph"],
		"us.micro": ["us", "micro"],
		"us.locality": ["us", "locality"],
		"us.region": ["us", "region"],
		"us.street": ["us", "street"],
		"us.street_prefix": ["us", "street_prefix"],
		"us.street_suffix": ["us", "street_suffix"],
		"us.unit_real": ["us", "unit"],
		"us.po_box_real": ["us", "po_box_real"],
		"us.intersection_real": ["us", "intersection_real"],
		"fr.postcode": ["fr", "postcode"],
		"fr.house_number": ["fr", "house_number"],
		"fr.region": ["fr", "region"],
		"fr.cedex_real": ["fr", "cedex_real"],
		"de.native_locality": ["de", "native_locality_anchor_on"],
		"arena.perturb": ["arena", "perturb"],
	}

	const metrics: Record<string, Record<string, number>> = {}

	for (const [key, entry] of Object.entries(verdict.results)) {
		const mapped = KEY_MAP[key]

		if (!mapped) {
			console.error(`! unmapped verdict key ${key} — add it to KEY_MAP; skipping`)
			continue
		}
		const [group, name] = mapped
		metrics[group] ??= {}
		metrics[group][name] = entry.actual
	}

	const modelCard: ModelCard = existsSync(card) ? (JSON.parse(readFileSync(card, "utf8")) as ModelCard) : {}
	// The practiced corpus_version is the short label; the card's is a long provenance sentence.
	const corpusVersion = (modelCard.training?.corpus_version ?? "unknown").split("=")[0]!.trim()

	const row = {
		run_id: runID,
		model_version: options.modelVersion!,
		model_path: options.modelPath!,
		corpus_version: corpusVersion,
		corpus_sha256: "see the shipped model-card corpus_version (practiced-shape pointer, not a digest)",
		eval_set_version: `promotion-gate battery (${verdict.label}): golden v0.1.2 + real-OOD + arena perturb`,
		eval_set_sha256: "per-file, see data/eval/external",
		trained_at: options.trainedAt ?? new Date().toISOString().slice(0, 10),
		hardware: modelCard.training?.hardware ?? "unknown",
		training_steps: modelCard.training?.steps ?? 0,
		training_wall_clock_seconds: 0,
		metrics,
		notes:
			`${notes}${exceptionNote} [graded_artifact=${verdict.graded_artifact}; gate=${verdict.label}; out-dir=${options.outDir}]`.trim(),
	}

	const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger
	const dup = ledger.runs.findIndex((r) => r.run_id === row.run_id || r.model_version === row.model_version)

	if (dup !== -1 && !options.replace) {
		console.error(
			`✗ ledger already has a row for ${ledger.runs[dup]!.model_version} (${ledger.runs[dup]!.run_id}) — pass --replace to overwrite`
		)

		return 1
	}

	if (dup !== -1) {
		ledger.runs.splice(dup, 1)
	}
	ledger.runs.push(row as never)

	const tmp = `${ledgerPath}.tmp`

	writeFileSync(tmp, JSON.stringify(ledger, null, "\t") + "\n")
	JSON.parse(readFileSync(tmp, "utf8")) // self-check before the swap
	renameSync(tmp, ledgerPath)
	console.log(`✓ appended ${row.model_version} (${row.run_id}) → ${ledgerPath} [${ledger.runs.length} runs]`)

	return 0
}
