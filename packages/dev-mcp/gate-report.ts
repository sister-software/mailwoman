/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read a promotion-gate run's own artifacts.
 *
 *   Unlike the gauntlet, the gate writes STRUCTURED output: `verdict.json` carries every floor with its reading, and
 *   `provenance.txt` records each graded artifact's md5 and dynamic-quant fingerprint. So nothing here parses prose for
 *   a number — the log is read only for the two things that exist nowhere else, the lore-guard refusal and the
 *   pre-filled ledger command.
 *
 *   This module adds no metric and moves no floor. The gate is the release authority; a floor relaxed here would be the
 *   silent gate drift the eval discipline exists to catch.
 */

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"

/**
 * One floor and what the run read against it.
 */
export interface FloorReading {
	metric: string
	floor: number
	/**
	 * The measured value, or `null` when the battery produced none.
	 *
	 * `null` is NOT zero and not a failure to clear the bar — it is a metric that was never measured, and the gate marks
	 * it failing precisely so an unmeasured floor cannot pass by default. Reported separately from `pass` so a reader can
	 * tell "missed the bar" from "never ran".
	 */
	observed: number | null
	/**
	 * `observed − floor`, or `null` when unmeasured. Negative means the floor was missed.
	 */
	margin: number | null
	pass: boolean
	measured: boolean
}

export interface GateReport {
	/**
	 * `PASS` / `FAIL` from `verdict.json`, or `null` when the file is absent — a run that crashed before assembling one.
	 */
	verdict: string | null
	label: string | null
	/**
	 * WHICH ARTIFACT the floors were read from, verbatim from the verdict.
	 *
	 * Surfaced at the top rather than buried because it is a documented confound: a package-shaped cache's `model.onnx`
	 * is whatever the package ships — int8, in every shipped weights package — and the verdict said `fp32` for a
	 * verifiably int8 cache on 2026-07-16. Two verdicts diffed without reading this field attribute a quantization delta
	 * to the model.
	 */
	graded_artifact: string | null
	floors: FloorReading[]
	int8_vs_fp32_deltas: Record<string, number>
	out_dir: string
	/**
	 * Contents of `provenance.txt`, or `null` when the run did not get far enough to write one.
	 */
	provenance: string | null
	/**
	 * The pre-filled `eval ledger-append` command the gate prints on a PASS, or `null`.
	 *
	 * Surfaced, never RUN. Appending to the ledger is a repo write and a claim about a shipped version; the gate runs on
	 * candidates that may never ship. See {@link GateReport.ledger_note}.
	 */
	ledger_command: string | null
	ledger_note: string
	/**
	 * The recompile-before-eval refusal, verbatim, when the gate's own lore guard fired. Passed through rather than
	 * worked around: that guard is correct, and a tool that swallowed it would grade a stale tree.
	 */
	lore_guard_refusal: string | null
	notes: string[]
}

/**
 * The `verdict.json` shape, as `promotion-gate-verdict.ts` writes it.
 */
interface RawVerdict {
	label?: string
	graded_artifact?: string
	verdict?: string
	results?: Record<string, { floor: number; actual: number | undefined; pass: boolean }>
	int8_vs_fp32_deltas?: Record<string, number>
}

const LEDGER_MARKER = "eval ledger-append"
const LORE_GUARD_MARKER = "recompile"

/**
 * Why the ledger command is reported rather than run.
 *
 * Carried on every gate result so the boundary travels with the command: a reader who sees a filled-in command and no
 * note has every reason to assume it already ran.
 */
export const LEDGER_NOTE =
	"This command is REPORTED, never run. Appending to evals/scores-by-version.json is a repo write and a claim about " +
	"a shipped version, while the gate runs on candidates that may never ship — so the operator runs it, with the real " +
	"npm semver, at promote time."

/**
 * Assemble a report from a finished gate run's out-dir plus its log.
 */
export function readGateReport(outDir: string, stdout: string, stderr: string): GateReport {
	const notes: string[] = []
	const verdictPath = join(outDir, "verdict.json")
	const provenancePath = join(outDir, "provenance.txt")

	let raw: RawVerdict | null = null

	if (existsSync(verdictPath)) {
		try {
			raw = parseJSONStrict<RawVerdict>(readFileSync(verdictPath, "utf8"))
		} catch (error) {
			notes.push(`verdict.json exists but did not parse: ${(error as Error).message}`)
		}
	} else {
		notes.push(
			`No verdict.json at ${verdictPath}. The run did not reach the verdict assembler — read the log. This is not a ` +
				"FAIL; a gate that never graded and a gate that graded FAIL are different outcomes."
		)
	}

	const floors: FloorReading[] = Object.entries(raw?.results ?? {}).map(([metric, result]) => {
		const measured = result.actual !== undefined && result.actual !== null

		return {
			metric,
			floor: result.floor,
			observed: measured ? result.actual! : null,
			margin: measured ? result.actual! - result.floor : null,
			pass: result.pass,
			measured,
		}
	})

	const unmeasured = floors.filter((floor) => !floor.measured)

	if (unmeasured.length) {
		notes.push(
			`${unmeasured.length} floor${unmeasured.length === 1 ? "" : "s"} had no measurement ` +
				`(${unmeasured.map((floor) => floor.metric).join(", ")}). The gate marks an unmeasured floor failing so it ` +
				"cannot pass by default — read these as 'never ran', not as 'missed the bar'."
		)
	}

	// The log is already buffered and capped at 8 MB by the job registry, so there is no stream to consume lazily.
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- bounded, already in memory
	const lines = `${stdout}\n${stderr}`.split("\n")

	let ledgerCommand: string | null = null
	let loreGuardRefusal: string | null = null

	for (const [index, line] of lines.entries()) {
		if (!ledgerCommand && line.includes(LEDGER_MARKER)) {
			// The command spans a couple of continued lines; take them until one does not end in a backslash.
			const collected = [line.trim()]

			for (let next = index + 1; next < lines.length && collected.at(-1)!.endsWith("\\"); next++) {
				collected.push(lines[next]!.trim())
			}

			ledgerCommand = collected.join(" ").replaceAll("\\ ", "")
		}

		if (!loreGuardRefusal && line.toLowerCase().includes(LORE_GUARD_MARKER) && line.includes("out")) {
			loreGuardRefusal = line.trim()
		}
	}

	if (!existsSync(provenancePath)) {
		notes.push(`No provenance.txt at ${provenancePath}, so the graded artifacts' md5s are unrecorded for this run.`)
	}

	return {
		verdict: raw?.verdict ?? null,
		label: raw?.label ?? null,
		graded_artifact: raw?.graded_artifact ?? null,
		floors,
		int8_vs_fp32_deltas: raw?.int8_vs_fp32_deltas ?? {},
		out_dir: outDir,
		provenance: existsSync(provenancePath) ? readFileSync(provenancePath, "utf8") : null,
		ledger_command: ledgerCommand,
		ledger_note: LEDGER_NOTE,
		lore_guard_refusal: loreGuardRefusal,
		notes,
	}
}

/**
 * One line for the `summary` an agent relays.
 *
 * Names `graded_artifact` before the verdict. A gate verdict without it invites the exact confound the field's own
 * docstring records — someone diffs two verdicts, sees a delta, and attributes to the model what was a precision
 * difference.
 */
export function summarizeGateReport(report: GateReport): string {
	if (!report.verdict) {
		return `No verdict was assembled in ${report.out_dir}. ${report.notes.join(" ")}`
	}

	const failed = report.floors.filter((floor) => !floor.pass)
	const unmeasured = failed.filter((floor) => !floor.measured)
	const missed = failed.filter((floor) => floor.measured)

	const detail = failed.length
		? ` ${missed.length} floor${missed.length === 1 ? "" : "s"} missed` +
			(unmeasured.length ? ` and ${unmeasured.length} unmeasured` : "") +
			`: ${failed.map((floor) => floor.metric).join(", ")}.`
		: ` All ${report.floors.length} floors met.`

	return (
		`Gate ${report.label ?? "(unlabelled)"} graded the ${report.graded_artifact ?? "UNRECORDED"} artifact: ` +
		`${report.verdict}.${detail}`
	)
}

/**
 * Artifacts the card itself declares, beyond the three the layout check covers.
 *
 * Read from `files_md5` rather than from a list here, so a card that starts declaring a new sibling is checked without
 * anyone remembering to update this file. `$comment` is a documentation key, not an artifact.
 */
function declaredArtifacts(packageDir: string): string[] {
	const cardPath = resolve(packageDir, "model-card.json")

	if (!existsSync(cardPath)) return []

	try {
		const card = parseJSONStrict<{ files_md5?: Record<string, unknown> }>(readFileSync(cardPath, "utf8"))

		return Object.keys(card.files_md5 ?? {}).filter((key) => !key.startsWith("$"))
	} catch {
		return []
	}
}

/**
 * Check that a `--weights-cache` root has the layout the gate expects, and say what is missing when it does not.
 *
 * The gate's own failure here is deliberate and stays in place: `promotion-gate.ts` names the package directory rather
 * than calling `resolveWeights({cacheRoot})` precisely so a mis-staged candidate dies on an ENOENT instead of falling
 * through to the installed workspace package — which in this repo always resolves, and would grade the SHIPPED model
 * under the candidate's label. This check runs BEFORE the spawn only so the reader learns the expected shape from a
 * sentence rather than from a stack trace; it never substitutes for that guard.
 *
 * The layout comes from `weightsCachePackageDir`, the resolver's own function, rather than a re-typed
 * `node_modules/@mailwoman/…` literal — the 2026-08-06 triage lesson recorded at the gate's own call site.
 *
 * @returns `kind` distinguishes a wrong-shaped root from a correctly-shaped one that is under-staged; the two need
 *   different fixes and one message for both sends the reader to the wrong place. `paths` is empty when well-formed.
 */
export function missingWeightsCacheArtifacts(
	cacheRoot: string,
	locale = "en-us"
): { kind: "ok" | "wrong-shape" | "under-staged"; paths: string[] } {
	const packageDir = weightsCachePackageDir(cacheRoot, locale)
	const required = ["model.onnx", "tokenizer.model", "model-card.json"]
	const missingRequired = required.map((artifact) => resolve(packageDir, artifact)).filter((path) => !existsSync(path))

	// Without a card there is nothing to check the rest against, and the caller already has a fatal answer.
	if (missingRequired.length) return { kind: "wrong-shape", paths: missingRequired }

	// A cache that has the three required files but is missing what its OWN card declares is the #1516 failure with no
	// signal of its own: the channel resolves off, the run scores several cases lower, and the operator reads a model
	// regression. Measured here on 2026-08-16 — a hand-staged three-file cache graded to completion and reported
	// `us.country_homograph_f1` at 0.0 against a 64.8 floor, which reads exactly like a collapsed country channel.
	const undeclared = declaredArtifacts(packageDir)
		.map((artifact) => resolve(packageDir, artifact))
		.filter((path) => !existsSync(path))

	return undeclared.length ? { kind: "under-staged", paths: undeclared } : { kind: "ok", paths: [] }
}
