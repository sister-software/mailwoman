/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Classifies every `Mailwoman.AmbiguousShorthand` hit by the action it needs and reports each as a diagnostic.
 *
 *   The three actions rise in cost. An interface-tied name keeps its spelling and needs only backticks, because Vale
 *   skips inline code. A modified reference has the check's real name in the preceding word, so `street-context gate`
 *   becomes "the street-context check". A bare reference needs a reader to work out the meaning from the surrounding
 *   paragraph.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { valeCommand } from "@mailwoman/core/vale"
import { relative, resolvePath } from "path-ts"
import { TextSpliterator } from "spliterator"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * Matches one Vale `--output line` record of the form `path:line:col:Rule:message`.
 */
const HIT_PATTERN = /^(.*?):(\d+):(\d+):Mailwoman\.AmbiguousShorthand(?:Code)?:'([^']+)'/

/**
 * Matches a line that contains an interface-tied name, which keeps its spelling and needs only backticks.
 *
 * The pattern matches nothing because no interface-tied identifier currently contains a banned word.
 * A new name added here needs its reason recorded in `AmbiguousShorthandCode.yml`.
 */
const INTERFACE_TOKEN = /(?!)/

/**
 * The action that a hit needs.
 */
export const Remedy = {
	backtick: "backtick",
	renameCheck: "rename-check",
	readContext: "read-context",
} as const

/**
 * One action from the constant above.
 */
export type Remedy = (typeof Remedy)[keyof typeof Remedy]

/**
 * One classified Vale hit.
 */
export interface Hit {
	path: string
	line: number
	word: string
	remedy: Remedy
	/**
	 * The word immediately before the hit.
	 * It identifies the intended check when it carries meaning.
	 */
	modifier: string
}

/**
 * Preceding words that carry no meaning, such as articles, pronouns and comment markers.
 * A hit after one of them is a bare reference.
 */
const EMPTY_MODIFIERS = new Set([
	"the",
	"a",
	"an",
	"this",
	"that",
	"these",
	"those",
	"its",
	"their",
	"every",
	"each",
	"both",
	"is",
	"as",
	"at",
	"to",
	"of",
	"and",
	"or",
	"no",
	"not",
	"one",
	"two",
	"three",
	"s",
	"it",
	"//",
	"/",
	"*",
	"`",
	".",
	",",
	"-",
	"",
	"per",
])

/**
 * The number of lines on each side of Vale's reported line to search for the matched word.
 *
 * Empty `//` comment lines shift Vale's reported line numbers.
 * The census searches this window to find the real line for the modifier and the diagnostic.
 */
const LINE_DRIFT_WINDOW = 3

/**
 * Finds the line nearest to Vale's reported line that contains `word`.
 *
 * It falls back to the reported line when the window does not contain the word, so no hit is dropped.
 */
function locate(
	lines: readonly string[],
	reported: number,
	column: number,
	word: string
): { line: number; source: string; index: number } {
	const needle = word.toLowerCase()

	for (let offset = 0; offset <= LINE_DRIFT_WINDOW; offset++) {
		for (const candidate of offset === 0 ? [reported] : [reported - offset, reported + offset]) {
			const source = lines[candidate - 1] ?? ""
			const from = candidate === reported ? Math.max(0, column - 3) : 0
			let index = source.toLowerCase().indexOf(needle, from)

			if (index === -1 && candidate === reported) {
				index = source.toLowerCase().indexOf(needle)
			}

			if (index !== -1) return { line: candidate, source, index }
		}
	}

	return { line: reported, source: lines[reported - 1] ?? "", index: -1 }
}

/**
 * Classifies each Vale `--output line` record against `sources`, a map from each path to its lines.
 *
 * The function is pure, so tests pass their cases inline.
 * A wrong line offset can mislabel a hit's action, but it cannot drop the hit.
 */
export function classify(hitLines: readonly string[], sources: ReadonlyMap<string, readonly string[]>): Hit[] {
	const hits: Hit[] = []

	for (const raw of hitLines) {
		const match = HIT_PATTERN.exec(raw)

		if (!match) continue

		const [, path, lineText, colText, word] = match
		const lines = sources.get(path!) ?? []
		const { line, source, index } = locate(lines, Number(lineText), Number(colText), word!)

		const before = index === -1 ? "" : source.slice(0, index)
		const modifier = (/([A-Za-z0-9_.`§/-]+)[\s-]*$/.exec(before.trimEnd())?.[1] ?? "").toLowerCase()

		// An interface-tied name is detected from the whole line, because the word before the hit varies.
		const remedy = INTERFACE_TOKEN.test(source)
			? Remedy.backtick
			: EMPTY_MODIFIERS.has(modifier)
				? Remedy.readContext
				: Remedy.renameCheck

		hits.push({ path: path!, line, word: word!, remedy, modifier })
	}

	return hits
}

/**
 * Returns the banned word that a match belongs to.
 *
 * The search covers the whole token because the code rule matches whole compounds,
 * where the banned word may not come first.
 */
export function wordFamily(word: string): "gate" | "seam" | "shard" | "cut" {
	const lower = word.toLowerCase()

	if (lower.includes("gat")) return "gate"

	if (lower.includes("seam")) return "seam"

	if (lower.includes("shard")) return "shard"

	return "cut"
}

/**
 * The tracked source files that the census covers.
 */
const TRACKED_GLOBS = ["*.ts", "*.tsx", "corpus-python/*.py"] as const

/**
 * Runs Vale over every tracked source file and returns its `--output line` records.
 *
 * The census resolves Vale through the workspace, so it runs the same binary as `yarn lint:prose`.
 */
async function collectHits(context: RepoContext): Promise<string[]> {
	const root = context.repoRoot

	const files = (await trackedSourcePaths(context, { globs: TRACKED_GLOBS, existingOnly: true })).map((path) =>
		relative(root, path)
	)

	// The enforcing config exempts the Vale fixtures.
	// The census config includes them so the positive control can trip.
	// Knip cannot see the `@vvago/vale` specifier passed to the resolver,
	// so `knip.json` marks that devDependency as used.
	const vale = await valeCommand(import.meta.url)
	const config = resolvePath(root, "config/vale/.vale-code-census.ini")

	// Vale must run from the repo root because the paths are repo-relative.
	// From another directory it resolves no files and exits 0.
	// Vale exits non-zero when it reports alerts, so a process error carries the expected output.
	// Any other error is rethrown so it cannot read as zero hits.
	const result = await runFile(vale.file, [...vale.argv, "--config", config, "--output", "line", ...files], {
		cwd: root,
		maxBuffer: 1 << 28,
	}).catch((error: unknown) => {
		if (isProcessError(error)) return { stdout: error.stdout, stderr: error.stderr }

		throw error
	})

	return TextSpliterator.from(result.stdout)
		.toArray()
		.filter((line) => HIT_PATTERN.test(line))
}

/**
 * A permanent fixture that must always produce hits.
 *
 * It distinguishes a clean tree from a run that resolved no files.
 */
const POSITIVE_CONTROL = "config/vale/fixtures/dirty.ts"

/**
 * Path prefixes whose hits do not count, each with the reason.
 * These files spell the banned words as data.
 */
const UNMEASURED: ReadonlyArray<readonly [path: string, reason: string]> = [
	["config/vale/fixtures/", "the rule's own fixtures; the dirty one must keep failing forever"],
	["packages/repo-health/lib/checks/vocab-census.ts", "this file — its patterns have to spell the words it classifies"],
	["packages/repo-health/test/unit/vocab-census.test.ts", "its cases are lines of source quoted verbatim"],
	["packages/repo-health/lib/checks/debt.ts", "its banned-vocabulary constant has to spell the word it counts"],
	["config/vale/check-rules.ts", "the rule fixtures' own harness; its docstring quotes the words the rules match"],
]

/**
 * The `vocab-census` check.
 *
 * It reports one error for each ambiguous-shorthand hit outside {@link UNMEASURED},
 * with the action the hit needs.
 */
export const vocabCensusCheck: RepoCheck = {
	id: "vocab-census",
	description:
		"Every ambiguous-shorthand hit Vale finds in tracked source, classified by the remedy it needs; the target is zero.",
	async run(context) {
		const hitLines = await collectHits(context)
		const paths = new Set<string>()

		for (const raw of hitLines) {
			const match = HIT_PATTERN.exec(raw)

			if (match) {
				paths.add(match[1]!)
			}
		}

		const sources = new Map<string, readonly string[]>()

		await Promise.all(
			[...paths].map(async (path) => {
				// The classifier indexes lines by number, so `skipEmpty: false` must keep blank lines.
				sources.set(
					path,
					TextSpliterator.from(await readLocalTextFile(resolvePath(context.repoRoot, path)), {
						skipEmpty: false,
					}).toArray()
				)
			})
		)

		const hits = classify(hitLines, sources)

		// The control checks the classified hits, so it fails when the classifier's
		// pattern stops matching Vale's output.
		if (!hits.some((hit) => hit.path === POSITIVE_CONTROL)) {
			return [
				{
					severity: DiagnosticSeverity.Error,
					message: `the positive control ${POSITIVE_CONTROL} classified no hits, so this run measured nothing — its count is not an absence`,
					file: POSITIVE_CONTROL,
				},
			]
		}

		// The exclusions apply after the control check, because the control file is itself excluded.
		const counted = hits.filter((hit) => !UNMEASURED.some(([path]) => hit.path.startsWith(path)))

		const diagnostics: Diagnostic[] = counted.map((hit) => ({
			severity: DiagnosticSeverity.Error,
			message: `${stringifyJSON(hit.word)} (${wordFamily(hit.word)}) needs the ${hit.remedy} remedy${hit.modifier ? `; modifier ${stringifyJSON(hit.modifier)}` : ""}`,
			file: hit.path,
			line: hit.line,
		}))

		return diagnostics
	},
}
