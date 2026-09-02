/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Classifies every `Mailwoman.AmbiguousShorthand` hit by the REMEDY it needs.
 *
 *   The sweep that removes these words is only safe if each site's replacement is decided by a
 *   rule rather than guessed at, one comment at a time — a careless reword drops the invariant or
 *   the measured number the comment existed to state. `shard` reached zero from 3,481 the same
 *   way: its four concepts were named first, so every site had one agreed replacement.
 *
 *   Three remedies, in ascending cost. A CONTRACT-BEARING name keeps its spelling and only needs
 *   backticks, because Vale skips inline code. A MODIFIED reference carries the check's real name
 *   in the word before it, so `street-context gate` becomes `the street-context check`. A BARE
 *   reference says only "the gate", and which check that is can be learned solely by reading the
 *   surrounding paragraph.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { parseArguments, scriptEntryPath } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"
import { TextSpliterator } from "spliterator"

/**
 * A Vale `--output line` record: `path:line:col:Rule:message`.
 */
const HIT_PATTERN = /^(.*?):(\d+):(\d+):Mailwoman\.AmbiguousShorthand(?:Code)?:'([^']+)'/

/**
 * Names that keep their spelling — `AGENTS.md` lists them as contract-bearing. A hit naming one of these is a
 * formatting fix, not a rewrite.
 */
const CONTRACT_BEARING =
	/@mailwoman\/locale[- ]gate|locale[- ]gate|promotion[- ]gate|promote[- ]gate|mailwoman eval gate|eval[- ]gate|mwdev_gate|gate\.test|gate\.ts|v1-parse-gate/i

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
 * Classifies each Vale `--output line` record against `sources`, a map from path to that file's lines. Pure, so the
 * fixture test states its cases inline rather than writing files.
 *
 * A reported line number is Vale's, and it was right in every case measured — a run of line comments, a block
 * docstring, and the first line of a file. One file (`packages/neural/test/integration/weights.test.ts`) reported two
 * lines past the match and the cause was not found: it carries no CR, no U+2028 or U+2029, and its line count agrees
 * with `splitlines()`. The COUNT is unaffected either way. Only the MODIFIER a hit is bucketed by comes from the
 * indexed line, so a stray offset mislabels a bucket rather than losing a site — read the line before editing it.
 */
export function classify(hitLines: readonly string[], sources: ReadonlyMap<string, readonly string[]>): Hit[] {
	const hits: Hit[] = []

	for (const raw of hitLines) {
		const match = HIT_PATTERN.exec(raw)

		if (!match) continue

		const [, path, lineText, colText, word] = match
		const line = Number(lineText)
		const source = sources.get(path!)?.[line - 1] ?? ""

		let index = source.toLowerCase().indexOf(word!.toLowerCase(), Math.max(0, Number(colText) - 3))

		if (index === -1) {
			index = source.toLowerCase().indexOf(word!.toLowerCase())
		}

		const before = index === -1 ? "" : source.slice(0, index)
		const modifier = (/([A-Za-z0-9_.`§/-]+)[\s-]*$/.exec(before.trimEnd())?.[1] ?? "").toLowerCase()

		// A contract-bearing name is decided by the WHOLE line, not the modifier: `mailwoman eval
		// gate` and `` `promotion-gate.ts` `` put different words immediately before the hit.
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
 * the whole compound, so `promotion-gate` is a `gate` and a prefix test files it under whichever family the
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
 * Counts by remedy, then by modifier within the rename bucket — the two numbers that size the sweep. Printed rather
 * than written to a baseline file: this is a measuring instrument for a sweep that ends at zero, not a debt counter
 * that ratchets.
 */
export function report(hits: readonly Hit[]): string {
	const byRemedy = new Map<Remedy, number>()
	const byWord = new Map<string, number>()
	const modifiers = new Map<string, number>()
	const files = new Set<string>()

	for (const hit of hits) {
		byRemedy.set(hit.remedy, (byRemedy.get(hit.remedy) ?? 0) + 1)

		byWord.set(wordFamily(hit.word), (byWord.get(wordFamily(hit.word)) ?? 0) + 1)
		files.add(hit.path)

		if (hit.remedy === Remedy.renameCheck) {
			modifiers.set(hit.modifier, (modifiers.get(hit.modifier) ?? 0) + 1)
		}
	}

	const lines = [`${hits.length} hits across ${files.size} files`, "", "by word family:"]

	for (const [family, count] of [...byWord].toSorted((left, right) => right[1] - left[1])) {
		lines.push(`  ${family.padEnd(6)} ${String(count).padStart(5)}`)
	}

	lines.push("", "by remedy:")

	for (const [remedy, count] of [...byRemedy].toSorted((left, right) => right[1] - left[1])) {
		lines.push(`  ${remedy.padEnd(14)} ${String(count).padStart(5)}`)
	}

	lines.push("", "rename-check bucket, by the modifier that names it (top 20):")

	for (const [modifier, count] of [...modifiers].toSorted((left, right) => right[1] - left[1]).slice(0, 20)) {
		lines.push(`  ${modifier.padEnd(24)} ${String(count).padStart(5)}`)
	}

	lines.push("", `distinct modifiers: ${modifiers.size}`)

	return lines.join("\n")
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
async function collectHits(root: string): Promise<string[]> {
	const tracked = await runFile("git", ["ls-files", ...TRACKED_GLOBS], { cwd: root, maxBuffer: 1 << 26 })
	const files = TextSpliterator.from(tracked.stdout, { skipEmpty: true }).toArray()

	const vale = resolveModulePath("@vvago/vale/bin/vale")
	const config = resolvePath(root, "docs/.vale-code.ini")

	// Run from the REPO ROOT, because `git ls-files` answers repo-relative paths. Run it from
	// anywhere else and Vale resolves none of them, reports zero alerts, and exits 0 — the reading
	// is identical to a clean tree. That is why the positive control below is not optional.
	// Vale exits non-zero when it reports alerts, which is this command's expected outcome. Only a
	// process error carries the output; a spawn failure has none and must not read as zero hits.
	const result = await runFile(vale, ["--config", config, "--output", "line", ...files], {
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
	["scripts/vocab-census.ts", "this file — its exceptions pattern has to spell the words it classifies"],
	["scripts/vocab-census.test.ts", "its cases are lines of source quoted verbatim"],
	["scripts/repo-health.ts", "its banned-vocabulary constant has to spell the word it counts"],
]

async function main(): Promise<void> {
	const root = String(repoRootPath())
	const hitLines = await collectHits(root)

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
				TextSpliterator.from(await readLocalTextFile(resolvePath(root, path)), { skipEmpty: false }).toArray()
			)
		})
	)

	const hits = classify(hitLines, sources)

	// Asserted on the CLASSIFIED hits, not on the raw Vale lines. A control that greps the raw
	// output tests a different string than the classifier parses: renaming the rule to
	// `AmbiguousShorthandCode` kept every raw line matching a substring check while the classifier's
	// pattern matched none, and the census reported a clean tree.
	if (!hits.some((hit) => hit.path === POSITIVE_CONTROL)) {
		throw new Error(
			`vocab-census: the positive control ${POSITIVE_CONTROL} classified no hits, so this run measured nothing — its count is not an absence`
		)
	}

	// Excluded AFTER the control is checked, never before: the control must be measured to prove the run resolved
	// files, and excluded to keep the target of zero reachable.
	const counted = hits.filter((hit) => !UNMEASURED.some(([path]) => hit.path.startsWith(path)))

	const { values } = parseArguments({
		options: { remedy: { type: "string" }, modifier: { type: "string" } },
		allowPositionals: false,
	})

	if (!values.remedy && !values.modifier) {
		console.log(report(counted))

		return
	}

	// Site listing, for working one bucket at a time. Every PR in the sweep carries ONE remedy or
	// ONE sense, so a reviewer checks a single rationale rather than each edit on its own.
	const selected = counted.filter(
		(hit) => (!values.remedy || hit.remedy === values.remedy) && (!values.modifier || hit.modifier === values.modifier)
	)

	for (const hit of selected) {
		console.log(`${hit.path}:${hit.line}\t${hit.word}\t${hit.modifier}`)
	}

	console.error(`${selected.length} of ${counted.length} hits`)
}

if (import.meta.filename === scriptEntryPath()) {
	await main()
}
