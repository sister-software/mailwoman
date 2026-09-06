/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Classifies every `Mailwoman.AmbiguousShorthand` hit by the REMEDY it needs, and reports each as a diagnostic.
 *
 *   The sweep that removes these words is only safe if each site's replacement is decided by a rule rather than guessed
 *   at, one comment at a time — a careless reword drops the invariant or the measured number the comment existed to
 *   state. `shard` reached zero from 3,481 the same way: its four concepts were named first, so every site had one
 *   agreed replacement.
 *
 *   Three remedies, in ascending cost. A CONTRACT-BEARING name keeps its spelling and only needs backticks, because Vale
 *   skips inline code. A MODIFIED reference carries the check's real name in the word before it, so `street-context
 *   gate` becomes `the street-context check`. A BARE reference says only "the gate", and which check that is can be
 *   learned solely by reading the surrounding paragraph.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { valeCommand } from "@mailwoman/core/vale"
import { relative, resolvePath } from "path-ts"
import { TextSpliterator } from "spliterator"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck, type RepoContext } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * A Vale `--output line` record: `path:line:col:Rule:message`.
 */
const HIT_PATTERN = /^(.*?):(\d+):(\d+):Mailwoman\.AmbiguousShorthand(?:Code)?:'([^']+)'/

/**
 * Names that keep their spelling — `AGENTS.md` lists them as contract-bearing. A hit naming one of these is a
 * formatting fix, not a rewrite. Empty: every contract-bearing identifier that carried a banned word has been renamed;
 * add a name here only when a new one must carry one, and record why in `AmbiguousShorthandCode.yml`.
 */
const CONTRACT_BEARING = /(?!)/

/**
 * The remedy a hit needs.
 */
export const Remedy = {
	backtick: "backtick",
	renameCheck: "rename-check",
	readContext: "read-context",
} as const

export type Remedy = (typeof Remedy)[keyof typeof Remedy]

export interface Hit {
	path: string
	line: number
	word: string
	remedy: Remedy
	/**
	 * The word immediately before the hit, which is what names the sense when there is one.
	 */
	modifier: string
}

/**
 * A modifier only names the check when it carries meaning. An article, a comment marker or a pronoun leaves the
 * reference bare however many words precede it.
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
 * How far from Vale's reported line to look for the matched word.
 *
 * A BARE `//` line shifts Vale's line numbers: measured on @vvago/vale 3.17.0, a hit on line 5 with two empty comment
 * lines above it is reported as line 6. The COUNT is unaffected — the hit is real either way — but the census indexes
 * source by that number to derive a modifier, and a reader following the output would be sent to the wrong line.
 *
 * Searching a window rather than trusting the number makes the instrument self-correcting. Three lines is measured, not
 * guessed: the two files in this repository that drift are each off by two.
 */
const LINE_DRIFT_WINDOW = 3

/**
 * The line that actually carries `word`, nearest to Vale's reported one. Falls back to the reported line when the word
 * is nowhere in the window, so a hit is never dropped — a missing modifier costs a bucket label, a dropped hit costs a
 * site.
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
 * Classifies each Vale `--output line` record against `sources`, a map from path to that file's lines. Pure, so the
 * fixture test states its cases inline rather than writing files.
 *
 * Only the MODIFIER a hit is bucketed by comes from the indexed line, so a stray offset mislabels a bucket rather than
 * losing a site — read the line before editing it.
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

		// A contract-bearing name is decided by the WHOLE line, not the modifier: `mailwoman eval
		// gate` and `` `promotion-eval.ts` `` put different words immediately before the hit.
		const remedy = CONTRACT_BEARING.test(source)
			? Remedy.backtick
			: EMPTY_MODIFIERS.has(modifier)
				? Remedy.readContext
				: Remedy.renameCheck

		hits.push({ path: path!, line, word: word!, remedy, modifier })
	}

	return hits
}

/**
 * Which of the four words a match belongs to. Searched ANYWHERE in the token, not at its start: the code rule matches
 * the whole compound, so `promotion-eval` is a `gate` and a prefix test files it under whichever family the
 * fall-through names.
 */
export function wordFamily(word: string): "gate" | "seam" | "shard" | "cut" {
	const lower = word.toLowerCase()

	if (lower.includes("gat")) return "gate"

	if (lower.includes("seam")) return "seam"

	if (lower.includes("shard")) return "shard"

	return "cut"
}

/**
 * The tracked surfaces the ban covers. Dated point-in-time records are exempt by the same rule that exempts them from
 * the acronym-casing convention, and `docs/` source is included because a plugin's docstring is as much committed prose
 * as a package's.
 */
const TRACKED_GLOBS = ["*.ts", "*.tsx", "corpus-python/*.py"] as const

/**
 * Runs Vale over every tracked source file and returns its `--output line` records. Vale is resolved through the
 * workspace rather than the PATH, so the census reads the same binary `yarn lint:prose` does.
 */
async function collectHits(context: RepoContext): Promise<string[]> {
	const root = context.repoRoot

	const files = (await trackedSourcePaths(context, { globs: TRACKED_GLOBS, existingOnly: true })).map((path) =>
		relative(root, path)
	)

	// The CENSUS config, not the enforcing one: enforcement exempts the Vale fixtures, and the census
	// needs one of them to trip so its positive control still means something. `@vvago/vale` is this
	// package's devDependency for exactly this line; knip cannot see a specifier passed to a resolver,
	// so `knip.json` names the dependency as used.
	const vale = await valeCommand(import.meta.url)
	const config = resolvePath(root, "docs/.vale-code-census.ini")

	// Run from the REPO ROOT, because the paths are repo-relative. Run it from anywhere else and Vale
	// resolves none of them, reports zero alerts, and exits 0 — the reading is identical to a clean tree.
	// That is why the positive control below is not optional.
	// Vale exits non-zero when it reports alerts, which is this command's expected outcome. Only a
	// process error carries the output; a spawn failure has none and must not read as zero hits.
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
 * A file that must always trip, so a reported zero is distinguishable from a run that resolved no files. The Vale
 * fixture is the right control precisely because it is PERMANENT: every other file carrying these words is scheduled to
 * lose them, and a control the sweep eventually cleans stops proving anything on the day it matters most.
 */
const POSITIVE_CONTROL = "docs/scripts/vale-fixtures/dirty.ts"

/**
 * Paths whose hits DO NOT count, and why each is excluded. The set measured is every tracked source minus these — the
 * denominator the count is reported against.
 *
 * Each states the vocabulary as DATA rather than using it as prose, so counting them measures the instrument instead of
 * the repository and the target of zero could never be reached.
 */
const UNMEASURED: ReadonlyArray<readonly [path: string, reason: string]> = [
	["docs/scripts/vale-fixtures/", "the rule's own fixtures; the dirty one must keep failing forever"],
	["packages/repo-health/lib/checks/vocab-census.ts", "this file — its patterns have to spell the words it classifies"],
	["packages/repo-health/test/unit/vocab-census.test.ts", "its cases are lines of source quoted verbatim"],
	["packages/repo-health/lib/checks/debt.ts", "its banned-vocabulary constant has to spell the word it counts"],
	[
		"docs/scripts/check-vale-rules.ts",
		"the rule fixtures' own harness; its docstring quotes the words the rules match",
	],
]

/**
 * The `vocab-census` check: one error per ambiguous-shorthand hit Vale reports in tracked source outside the unmeasured
 * instrument files, each naming the remedy it needs.
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
				// Indexed by line number, so the whole file is resident by necessity rather than by choice.
				// `skipEmpty: false` is REQUIRED: the default drops blank lines, which shifts every line
				// number after the first one and silently classifies each hit against a different line of
				// source. Measured: the default moved 731 of 2,014 hits between remedy buckets.
				sources.set(
					path,
					TextSpliterator.from(await readLocalTextFile(resolvePath(context.repoRoot, path)), {
						skipEmpty: false,
					}).toArray()
				)
			})
		)

		const hits = classify(hitLines, sources)

		// Asserted on the CLASSIFIED hits, not on the raw Vale lines. A control that greps the raw
		// output tests a different string than the classifier parses: renaming the rule to
		// `AmbiguousShorthandCode` kept every raw line matching a substring check while the classifier's
		// pattern matched none, and the census reported a clean tree.
		if (!hits.some((hit) => hit.path === POSITIVE_CONTROL)) {
			return [
				{
					severity: DiagnosticSeverity.Error,
					message: `the positive control ${POSITIVE_CONTROL} classified no hits, so this run measured nothing — its count is not an absence`,
					file: POSITIVE_CONTROL,
				},
			]
		}

		// Excluded AFTER the control is checked, never before: the control must be measured to prove the run resolved
		// files, and excluded to keep the target of zero reachable.
		const counted = hits.filter((hit) => !UNMEASURED.some(([path]) => hit.path.startsWith(path)))

		const diagnostics: Diagnostic[] = counted.map((hit) => ({
			severity: DiagnosticSeverity.Error,
			message: `${JSON.stringify(hit.word)} (${wordFamily(hit.word)}) needs the ${hit.remedy} remedy${hit.modifier ? `; modifier ${JSON.stringify(hit.modifier)}` : ""}`,
			file: hit.path,
			line: hit.line,
		}))

		return diagnostics
	},
}
