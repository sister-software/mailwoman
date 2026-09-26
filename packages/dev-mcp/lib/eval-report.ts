/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Read a promotion-eval run's own artifacts.
 *
 * Unlike the gauntlet, the eval writes structured output: `verdict.json` carries every floor with its
 * reading and `provenance.txt` records each graded artifact's md5 and dynamic-quant fingerprint, so this
 * module parses no prose for a number — the log is read only for the lore-guard refusal and the
 * pre-filled ledger command, which exist nowhere else.
 *
 * This module adds no metric and moves no floor: the eval is the release authority, and a floor relaxed
 * here would be the silent eval drift the eval discipline exists to catch.
 */

import { pathExists, readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { resolvePath, type PathBuilderLike } from "path-ts"

/**
 * One floor and what the run read against it.
 */
export interface FloorReading {
	metric: string
	floor: number
	/**
	 * The measured value, or `null` when the battery produced none.
	 *
	 * `null` is not zero and not a failure to clear the bar: it is a metric that was never measured,
	 * and the eval marks it failing precisely so an unmeasured floor cannot pass by default.
	 * Reported separately from `pass` so a reader can tell "missed the bar" from "never ran".
	 */
	observed: number | null
	/**
	 * `observed − floor`, or `null` when unmeasured; negative means the floor was missed.
	 */
	margin: number | null
	pass: boolean
	measured: boolean
}

export interface EvalReport {
	/**
	 * `pass` / `fail` from `verdict.json`, or `null` when the file is absent —
	 * a run that crashed before assembling one.
	 */
	verdict: string | null
	label: string | null
	/**
	 * Which artifact the floors were read from, verbatim from the verdict.
	 *
	 * Surfaced at the top rather than buried because it is a documented confound: a package-shaped
	 * cache's `model.onnx` is whatever the package ships — int8, in every shipped weights package —
	 * so two verdicts diffed without reading this field attribute a quantization delta to the model.
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
	 * The pre-filled `eval ledger-append` command the eval prints on a pass, or `null`.
	 *
	 * Surfaced, never RUN: appending to the ledger is a repo write and a claim about a shipped version,
	 * while the eval runs on candidates that may never ship (see {@link EvalReport.ledger_note}).
	 */
	ledger_command: string | null
	ledger_note: string
	/**
	 * The recompile-before-eval refusal, verbatim, when the eval's own lore guard fired; passed through
	 * rather than worked around, because a tool that swallowed it would grade a stale tree.
	 */
	lore_guard_refusal: string | null
	notes: string[]
}

/**
 * The `verdict.json` shape, as `promotion-eval-verdict.ts` writes it.
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
 * Why the ledger command is reported rather than run; carried on every check result
 * so the boundary travels with the command, since a reader who sees a filled-in command
 * and no note has every reason to assume it already ran.
 */
export const LEDGER_NOTE =
	"This command is REPORTED, never run. Appending to evals/scores-by-version.json is a repo write and a claim about " +
	"a shipped version, while the check runs on candidates that may never ship — so the operator runs it, with the real " +
	"npm semver, at promote time."

/**
 * Assemble a report from a finished eval run's out-dir plus its log.
 */
export async function readEvalReport(outDir: PathBuilderLike, stdout: string, stderr: string): Promise<EvalReport> {
	const notes: string[] = []
	const verdictPath = resolvePath(outDir, "verdict.json")
	const provenancePath = resolvePath(outDir, "provenance.txt")

	let raw: RawVerdict | null = null

	if (await pathExists(verdictPath)) {
		try {
			raw = await readLocalJSONFile<RawVerdict>(verdictPath)
		} catch (error) {
			notes.push(`verdict.json exists but did not parse: ${(error as Error).message}`)
		}
	} else {
		notes.push(
			`No verdict.json at ${verdictPath}. The run did not reach the verdict assembler — read the log. This is not a ` +
				"FAIL; a check that never graded and a check that graded FAIL are different outcomes."
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
				`(${unmeasured.map((floor) => floor.metric).join(", ")}). The check marks an unmeasured floor failing so it ` +
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

	if (!(await pathExists(provenancePath))) {
		notes.push(`No provenance.txt at ${provenancePath}, so the graded artifacts' md5s are unrecorded for this run.`)
	}

	return {
		verdict: raw?.verdict ?? null,
		label: raw?.label ?? null,
		graded_artifact: raw?.graded_artifact ?? null,
		floors,
		int8_vs_fp32_deltas: raw?.int8_vs_fp32_deltas ?? {},
		out_dir: outDir.toString(),
		provenance: (await pathExists(provenancePath)) ? await readLocalTextFile(provenancePath) : null,
		ledger_command: ledgerCommand,
		ledger_note: LEDGER_NOTE,
		lore_guard_refusal: loreGuardRefusal,
		notes,
	}
}

/**
 * One line for the `summary` an agent relays.
 *
 * Names `graded_artifact` before the verdict, because an eval verdict without it
 * invites the exact confound the field's own docstring records.
 */
export function summarizeEvalReport(report: EvalReport): string {
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
		`Check ${report.label ?? "(unlabelled)"} graded the ${report.graded_artifact ?? "UNRECORDED"} artifact: ` +
		`${report.verdict}.${detail}`
	)
}

/**
 * Artifacts the card itself declares, beyond the three the layout check covers.
 *
 * Read from `files_md5` rather than from a list here, so a card that starts
 * declaring a new sibling is checked without anyone remembering to update this file;
 * `$comment` is a documentation key rather than an artifact.
 */
async function declaredArtifacts(packageDir: PathBuilderLike): Promise<string[]> {
	const cardPath = resolvePath(packageDir, "model-card.json")

	if (!(await pathExists(cardPath))) return []

	try {
		const card = await readLocalJSONFile<{ files_md5?: Record<string, unknown> }>(cardPath)

		return Object.keys(card.files_md5 ?? {}).filter((key) => !key.startsWith("$"))
	} catch {
		return []
	}
}

/**
 * Check that a `--weights-cache` root has the layout the eval expects,
 * and say what is missing when it does not.
 *
 * The eval's own failure here is deliberate and stays in place: `promotion-eval.ts` names the
 * package directory rather than calling `resolveWeights({cacheRoot})` precisely so a mis-staged
 * candidate dies on an enoent instead of falling through to the installed workspace package,
 * which in this repo always resolves, and would grade the shipped model under the candidate's label.
 * This check runs before the spawn only so the reader learns the expected shape from a sentence
 * rather than from a stack trace, and never substitutes for that guard.
 *
 * The layout comes from `weightsCachePackageDir`, the resolver's own function,
 * rather than a re-typed `node_modules/@mailwoman/…` literal.
 *
 * @returns `kind` distinguishes a wrong-shaped root from a correctly-shaped one that is
 * under-staged — the two need different fixes — and `paths` is empty when well-formed.
 */
export async function missingWeightsCacheArtifacts(
	cacheRoot: PathBuilderLike,
	locale = "en-us"
): Promise<{ kind: "ok" | "wrong-shape" | "under-staged"; paths: string[] }> {
	const packageDir = weightsCachePackageDir(cacheRoot, locale)
	const required = ["model.onnx", "tokenizer.model", "model-card.json"]

	const missingRequired: string[] = []

	for (const artifact of required) {
		const path = resolvePath(packageDir, artifact)

		if (!(await pathExists(path))) {
			missingRequired.push(path)
		}
	}

	// Without a card there is no reference to check the rest against, and the caller already has a fatal answer.
	if (missingRequired.length) return { kind: "wrong-shape", paths: missingRequired }

	// A cache that has the three required files but is missing what its own card
	// declares fails with no signal of its own: the channel resolves off and the run
	// scores several cases lower, which reads like a model regression.
	const undeclared: string[] = []

	for (const artifact of await declaredArtifacts(packageDir)) {
		const path = resolvePath(packageDir, artifact)

		if (!(await pathExists(path))) {
			undeclared.push(path)
		}
	}

	return undeclared.length ? { kind: "under-staged", paths: undeclared } : { kind: "ok", paths: [] }
}
