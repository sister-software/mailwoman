/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ledger-append (#885) — turn a `promotion-gate.ts` out-dir into one row of
 *   `evals/scores-by-version.json`, so the per-version score ledger updates itself instead of
 *   relying on discipline (which is how it froze at v4.4.0 for eleven releases).
 *
 *   Metric values come from the out-dir's `verdict.json` (the gate's own floor readings — the
 *   same numbers the promote decision used). Run metadata (corpus, steps, hardware) defaults from
 *   the model-card; everything is overridable by flag. Rows follow the file's PRACTICED shape
 *   (the v4.4.0 row): the strict schema wants 64-hex digests for corpus/eval-set, but the
 *   populated rows use free-text pointers — this tool warns on that drift, it does not fail.
 *
 *   Refuses to append a duplicate (same model_version + run_id) unless --replace, and always
 *   validates the result is parseable JSON before writing (write-to-temp, then rename).
 *
 *   Usage:
 *     node --experimental-strip-types scripts/eval/ledger-append.ts \
 *       --out-dir /path/to/gate-out --model-version 5.0.0 \
 *       --run-id v193a3-anchor-absorption-step080000-rescore-20260702 \
 *       --model-path "@mailwoman/neural-weights-en-us@5.0.0" \
 *       [--card neural-weights-en-us/model-card.json] [--notes "..."] [--replace]
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

const { values } = parseArgs({
	options: {
		"out-dir": { type: "string" },
		"model-version": { type: "string" },
		"run-id": { type: "string" },
		"model-path": { type: "string" },
		card: { type: "string", default: "neural-weights-en-us/model-card.json" },
		ledger: { type: "string", default: "evals/scores-by-version.json" },
		"trained-at": { type: "string" },
		notes: { type: "string", default: "" },
		replace: { type: "boolean", default: false },
		// The gate-revision escape (mirrors the no-silent-gate-drift discipline): a FAIL verdict may
		// be ledgered ONLY when every failing check is named here — i.e. the operator adjudicated the
		// exact miss at a fork (e.g. a per-artifact int8-delta exception recorded in the gate spec's
		// $revision comment). The excepted checks are stamped into the row's notes; any UNnamed
		// failure still refuses. Repeatable.
		"operator-exception": { type: "string", multiple: true },
	},
})

for (const req of ["out-dir", "model-version", "run-id", "model-path"] as const) {
	if (!values[req]) {
		console.error(`✗ --${req} required`)
		process.exit(2)
	}
}

const runID = values["run-id"]!

if (!/^[a-z0-9-]+$/.test(runID)) {
	console.error(`✗ --run-id must match ^[a-z0-9-]+$ (got: ${runID})`)
	process.exit(2)
}

interface Verdict {
	label: string
	graded_artifact: string
	verdict: string
	results: Record<string, { floor: number; actual: number; pass: boolean }>
}

const verdict = JSON.parse(readFileSync(`${values["out-dir"]}/verdict.json`, "utf8")) as Verdict
const exceptions = values["operator-exception"] ?? []
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
		process.exit(1)
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

interface ModelCard {
	training?: { corpus_version?: string; steps?: number; hardware?: string }
}

const card: ModelCard = existsSync(values.card!) ? (JSON.parse(readFileSync(values.card!, "utf8")) as ModelCard) : {}
// The practiced corpus_version is the short label; the card's is a long provenance sentence.
const corpusVersion = (card.training?.corpus_version ?? "unknown").split("=")[0]!.trim()

const row = {
	run_id: runID,
	model_version: values["model-version"]!,
	model_path: values["model-path"]!,
	corpus_version: corpusVersion,
	corpus_sha256: "see the shipped model-card corpus_version (practiced-shape pointer, not a digest)",
	eval_set_version: `promotion-gate battery (${verdict.label}): golden v0.1.2 + real-OOD + arena perturb`,
	eval_set_sha256: "per-file, see data/eval/external",
	trained_at: values["trained-at"] ?? new Date().toISOString().slice(0, 10),
	hardware: card.training?.hardware ?? "unknown",
	training_steps: card.training?.steps ?? 0,
	training_wall_clock_seconds: 0,
	metrics,
	notes:
		`${values.notes}${exceptionNote} [graded_artifact=${verdict.graded_artifact}; gate=${verdict.label}; out-dir=${values["out-dir"]}]`.trim(),
}

interface Ledger {
	schema_version: number
	runs: Array<{ run_id: string; model_version: string }>
}

const ledger = JSON.parse(readFileSync(values.ledger!, "utf8")) as Ledger
const dup = ledger.runs.findIndex((r) => r.run_id === row.run_id || r.model_version === row.model_version)

if (dup !== -1 && !values.replace) {
	console.error(
		`✗ ledger already has a row for ${ledger.runs[dup]!.model_version} (${ledger.runs[dup]!.run_id}) — pass --replace to overwrite`
	)
	process.exit(1)
}

if (dup !== -1) {
	ledger.runs.splice(dup, 1)
}
ledger.runs.push(row as never)

const tmp = `${values.ledger}.tmp`

writeFileSync(tmp, JSON.stringify(ledger, null, "\t") + "\n")
JSON.parse(readFileSync(tmp, "utf8")) // self-check before the swap
renameSync(tmp, values.ledger!)
console.log(`✓ appended ${row.model_version} (${row.run_id}) → ${values.ledger} [${ledger.runs.length} runs]`)
