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
import { scriptEntryPath } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"
import { TextSpliterator } from "spliterator"

/**
 * A Vale `--output line` record: `path:line:col:Rule:message`.
 */
const HIT_PATTERN = /^(.*?):(\d+):(\d+):Mailwoman\.AmbiguousShorthand:'([^']+)'/

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

		const family = hit.word.toLowerCase().startsWith("gat")
			? "gate"
			: hit.word.toLowerCase().startsWith("seam")
				? "seam"
				: hit.word.toLowerCase().startsWith("cut")
					? "cut"
					: "shard"

		byWord.set(family, (byWord.get(family) ?? 0) + 1)
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
		.filter((line) => line.includes("Mailwoman.AmbiguousShorthand"))
}

/**
 * A file this repository is certain to hit, because it necessarily contains the words it counts: `repo-health.ts`
 * states the banned vocabulary as a constant and describes the checks around it. If the census reports nothing here,
 * the run resolved no files and its zero means "not measured", not "clean".
 */
const POSITIVE_CONTROL = "scripts/repo-health.ts"

if (import.meta.filename === scriptEntryPath()) {
	const root = String(repoRootPath())
	const hitLines = await collectHits(root)

	if (!hitLines.some((line) => line.startsWith(POSITIVE_CONTROL))) {
		throw new Error(
			`vocab-census: the positive control ${POSITIVE_CONTROL} reported no hits, so Vale resolved no files — this run measured nothing and its count is not an absence`
		)
	}

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

	console.log(report(classify(hitLines, sources)))
}
