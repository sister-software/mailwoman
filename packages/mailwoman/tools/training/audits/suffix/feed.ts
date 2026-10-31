/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Audits how the suffix-boundary feed labels a street's terminal suffix after the affix relabel.
 *
 *   A street group is a `B-street` run with the `B-street_suffix` run after it. The classify lexicon sorts a group
 *   by its last two words: `terminal-contrast` when the last word is a name-prone suffix, and `terminal-only` when the
 *   last word is a suffix and the word before it a name-prone one. Each classified group is correct when, after the
 *   relabel lexicon's pass, its last word reads `street_suffix` and the word before it `street`. The rows of the
 *   suffix-boundary sources are counted apart from every other source's.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { MTFNode } from "@mailwoman/mtf/tools/sampler/native"

import { openRawRows } from "../../sampler.ts"

/**
 * Both spellings of the suffix-boundary source.
 *
 * `packages/corpus/lib/recipes/sources.ts` records the pair, and a corpus stores
 * the spelling of the build that assembled it.
 */
export const TARGET_SOURCES = ["synth-suffix-boundary", "spliced-suffix-boundary"] as const

/**
 * The affix lexicon's fields the classification reads.
 */
export interface AffixLexicon {
	version: string
	suffixes: Record<string, string>
	directionals: Record<string, string>
	nameProne: ReadonlySet<string>
}

/**
 * Reads an affix relabel lexicon, refusing one without its vocabularies,
 * as `AffixRelabelLexicon.load` does.
 */
export async function readAffixLexicon(path: string): Promise<AffixLexicon> {
	const data = await readLocalJSONFile<Record<string, unknown>>(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") throw new Error(`affix relabel lexicon not found: ${path}`)

		throw error
	})

	for (const key of ["directionals", "suffixes", "version"]) {
		if (!(key in data)) throw new Error(`affix relabel lexicon missing key '${key}': ${path}`)
	}

	const directionals = data.directionals as Record<string, string>
	const suffixes = data.suffixes as Record<string, string>

	if (!Object.keys(directionals).length || !Object.keys(suffixes).length) {
		throw new Error(`affix relabel lexicon has empty vocab: ${path}`)
	}

	return {
		version: String(data.version),
		suffixes,
		directionals,
		nameProne: new Set(data.name_prone as string[] | undefined),
	}
}

/**
 * The words a `terminal-only` group holds at least: a name, then a name-prone
 * suffix word, then the terminal suffix.
 */
const TERMINAL_ONLY_MIN_WORDS = 3

function component(label: string | undefined): string | null {
	return label != null && (label.startsWith("B-") || label.startsWith("I-")) ? label.slice(2) : null
}

/**
 * The token indexes of each street group: a `B-street` run and the `B-street_suffix` run right after it.
 */
export function streetFamilyGroups(labels: readonly string[]): number[][] {
	const groups: number[][] = []
	let i = 0

	while (i < labels.length) {
		if (labels[i] !== "B-street") {
			i++

			continue
		}

		const group = [i++]

		while (i < labels.length && labels[i] === "I-street") {
			group.push(i++)
		}

		if (i < labels.length && labels[i] === "B-street_suffix") {
			group.push(i++)

			while (i < labels.length && labels[i] === "I-street_suffix") {
				group.push(i++)
			}
		}

		groups.push(group)
	}

	return groups
}

/**
 * A street group's class from its words, or `null` for a group the audit leaves out.
 */
export function classifyStreetGroup(words: readonly string[], lexicon: AffixLexicon): string | null {
	if (words.length < 2) return null

	const terminal = lexicon.suffixes[words.at(-1)!.toLowerCase()]

	if (terminal == null) return null

	if (lexicon.nameProne.has(terminal)) return "terminal-contrast"

	// A terminal-only group needs a name word before the two suffix words.
	if (words.length < TERMINAL_ONLY_MIN_WORDS) return null

	const penultimate = lexicon.suffixes[words.at(-2)!.toLowerCase()]

	return penultimate != null && lexicon.nameProne.has(penultimate) ? "terminal-only" : null
}

/**
 * Each classified street group of a row with whether the relabeled labels read it correctly.
 */
export function evaluateRow(
	tokens: readonly string[],
	labels: readonly string[],
	relabeled: readonly string[],
	lexicon: AffixLexicon
): Array<[string, boolean]> {
	const out: Array<[string, boolean]> = []

	for (const group of streetFamilyGroups(labels)) {
		const cls = classifyStreetGroup(
			group.map((j) => tokens[j]!),
			lexicon
		)

		if (cls == null) continue

		const correct =
			group.length >= 2 &&
			component(relabeled[group.at(-1)!]) === "street_suffix" &&
			component(relabeled[group.at(-2)!]) === "street"

		out.push([cls, correct])
	}

	return out
}

/**
 * Options for {@linkcode suffixFeedAudit}.
 */
export interface SuffixFeedOptions {
	seed: number
	rows: number
	classifyLexicon: AffixLexicon
	relabelLexiconPath: string
	relabelLexiconVersion: string
	corpusDir?: string
}

/**
 * Audits `rows` drawn rows of the train mixture.
 *
 * @throws When no sampled row comes from a target source, because every target cell would
 * then read zero against a populated ordinary bucket, the report of a feed with no target rows.
 */
export function suffixFeedAudit(mtf: MTFNode, config: TrainingConfig, options: SuffixFeedOptions) {
	const corpusDir = options.corpusDir ?? config.data.corpus_dir

	// The emit step runs only the relabel when every augmentation is off,
	// and the generator's state stays where the mixture left it.
	const stream = openRawRows(mtf, config, "train", options.seed, {
		corpusDir,
		augment: {},
		affixRelabelLexiconPath: options.relabelLexiconPath,
	})

	const carriers = new Map<string, number>()
	const correct = new Map<string, number>()
	const perSourceCarriers = new Map<string, number>()
	const perSourceCorrect = new Map<string, number>()
	const add = (map: Map<string, number>, key: string, by: number) => map.set(key, (map.get(key) ?? 0) + by)
	let sampled = 0

	while (sampled < options.rows) {
		const draws = stream.nextEmitted(Math.min(options.rows - sampled, 1024))

		if (!draws.length) break

		for (const { drawn, emitted } of draws) {
			sampled++

			const relabeled = emitted[0]?.labels ?? drawn.labels

			for (const [cls, ok] of evaluateRow(drawn.tokens, drawn.labels, relabeled, options.classifyLexicon)) {
				const bucket = (TARGET_SOURCES as readonly string[]).includes(drawn.source) ? "target" : "ordinary"

				add(carriers, `${cls}\u0000${bucket}`, 1)
				add(correct, `${cls}\u0000${bucket}`, Number(ok))
				add(perSourceCarriers, `${cls}\u0000${drawn.source}`, 1)
				add(perSourceCorrect, `${cls}\u0000${drawn.source}`, Number(ok))
			}
		}
	}

	if (sampled && ![...carriers.keys()].some((key) => key.endsWith("\u0000target"))) {
		const seen = [...new Set([...perSourceCarriers.keys()].map((key) => key.split("\u0000")[1]!))].toSorted()

		throw new Error(
			`no row of the ${sampled.toLocaleString("en-US")} sampled carries any of ('${TARGET_SOURCES.join("', '")}'), ` +
				"so every target cell in this report would read 0 carriers against a populated ordinary bucket. " +
				`Sources seen: ${seen.length ? seen.join(", ") : "none carried a classified span"}.`
		)
	}

	const cell = (cls: string, bucket: string) => {
		const n = carriers.get(`${cls}\u0000${bucket}`) ?? 0
		const k = correct.get(`${cls}\u0000${bucket}`) ?? 0

		return { carriers: n, correct: k, rate: n ? k / n : null }
	}

	// Python sorts the `(class, source)` pairs as tuples.
	// It orders by class, then by source.
	const pairs = [...perSourceCarriers.keys()]
		.map((key) => key.split("\u0000") as [string, string])
		.toSorted(([a1, a2], [b1, b2]) => (a1 < b1 ? -1 : a1 > b1 ? 1 : a2 < b2 ? -1 : a2 > b2 ? 1 : 0))

	return {
		meta: {
			rows_sampled: sampled,
			seed: options.seed,
			corpus_dir: corpusDir,
			classify_lexicon: options.classifyLexicon.version,
			relabel_lexicon: options.relabelLexiconVersion,
		},
		terminal_only: {
			total: cell("terminal-only", "target").carriers + cell("terminal-only", "ordinary").carriers,
			target: cell("terminal-only", "target"),
			ordinary: cell("terminal-only", "ordinary"),
		},
		terminal_contrast: {
			target: cell("terminal-contrast", "target"),
			ordinary: cell("terminal-contrast", "ordinary"),
		},
		per_source: Object.fromEntries(
			pairs.map(([cls, source]) => [
				`${cls}/${source}`,
				{
					carriers: perSourceCarriers.get(`${cls}\u0000${source}`) ?? 0,
					correct: perSourceCorrect.get(`${cls}\u0000${source}`) ?? 0,
				},
			])
		),
	}
}
