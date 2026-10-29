/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Audits script transitions inside gold address components.
 *
 *   Row-level script diversity differs from a mixed-script component. `Rinrin, 高山市` holds several scripts across
 *   components. A venue such as `Four Seasons Inn四季酒家` changes script inside one span. The audit keeps the two
 *   populations apart and reports the second by component tag, country and source.
 *
 *   It reads the train mixture the trainer samples, with the configured affix relabel. Augmentations create no new
 *   writing system, so they are left off. A letter's script is read from CPython 3.12's Unicode names through the
 *   `mtf-node` addon, because Node has no character-name table.
 */

import { countInto } from "@mailwoman/core/stats"
import { asPythonFloat } from "@mailwoman/core/strings/python-json"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { MTFNode, PythonText, SampledRow } from "@mailwoman/mtf/tools/sampler/native"

import { openRawRows } from "../sampler.ts"
import { sortedByKey } from "./receipt.ts"

/**
 * Whether a UTF-16 offset of `text` falls between two characters.
 */
function isBoundary(text: string, offset: number): boolean {
	if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false

	const before = text.charCodeAt(offset - 1)
	const after = text.charCodeAt(offset)

	return !(before >= 0xd8_00 && before <= 0xdb_ff && after >= 0xdc_00 && after <= 0xdf_ff)
}

/**
 * Each gold component of a row as `[tag, surface]`: from its span triple,
 * whose offsets are UTF-16 code units, or else from its BIO token runs.
 *
 * @throws When a span offset does not fall on a character boundary.
 */
export function* goldComponents(row: SampledRow): Generator<[string, string]> {
	const { spanStarts, spanEnds, spanTags } = row

	if (spanStarts != null && spanEnds != null && spanTags != null) {
		if (spanStarts.length !== spanEnds.length || spanStarts.length !== spanTags.length) {
			throw new Error(`the span triple of ${row.raw} differs in length`)
		}

		const misplaced = [...new Set([...spanStarts, ...spanEnds])]
			.filter((offset) => !isBoundary(row.raw, offset))
			.toSorted((a, b) => a - b)

		if (misplaced.length) {
			throw new Error(`span offsets are not UTF-16 boundaries for ${row.raw}: ${misplaced.join(", ")}`)
		}

		for (const [i, start] of spanStarts.entries()) {
			yield [spanTags[i]!, row.raw.slice(start, spanEnds[i])]
		}

		return
	}

	const { tokens, labels } = row
	let index = 0

	while (index < labels.length) {
		const label = labels[index]!

		if (!label.startsWith("B-")) {
			index++

			continue
		}

		const tag = label.slice(2)
		let end = index + 1

		while (end < labels.length && labels[end] === `I-${tag}`) {
			end++
		}

		yield [tag, tokens.slice(index, end).join(" ")]
		index = end
	}
}

/**
 * A counter's entries in key order, then the share of scripted components that mix scripts.
 */
function finalizeCounts(counts: ReadonlyMap<string, number>): Map<string, unknown> {
	const out = new Map<string, unknown>(sortedByKey(counts))
	const scripted = counts.get("scripted_components") ?? 0

	out.set("mixed_rate", asPythonFloat(scripted ? (counts.get("mixed_components") ?? 0) / scripted : 0))

	return out
}

function counterOf(map: Map<string, Map<string, number>>, key: string): Map<string, number> {
	let counter = map.get(key)

	if (!counter) {
		map.set(key, (counter = new Map()))
	}

	return counter
}

/**
 * The audit keeps a mixed component as an example in this shape.
 */
export interface MixedScriptExample {
	raw: string
	surface: string
	scripts: string[]
	country: string | null
	source: string
}

/**
 * Summarizes mixed-script gold components over rows, keeping up to `examplesPerTag` examples per tag.
 */
export function auditMixedScriptRows(
	text: PythonText,
	rows: Iterable<SampledRow>,
	examplesPerTag = 10
): Map<string, unknown> {
	const totals = new Map<string, number>()
	const byTag = new Map<string, Map<string, number>>()
	const byCountry = new Map<string, Map<string, number>>()
	const bySource = new Map<string, Map<string, number>>()
	const examples = new Map<string, MixedScriptExample[]>()

	for (const row of rows) {
		countInto(totals, "rows")

		const hasSpans = row.spanStarts != null && row.spanEnds != null && row.spanTags != null

		countInto(totals, hasSpans ? "span_truth_rows" : "legacy_bio_rows")

		if (new Set(text.scriptRuns(row.raw)).size > 1) {
			countInto(totals, "rows_with_multiple_scripts")
		}

		const country = row.country ?? "null"
		let rowHasMixedComponent = false

		for (const [tag, surface] of goldComponents(row)) {
			const tagCounts = counterOf(byTag, tag)

			countInto(totals, "components")
			countInto(tagCounts, "components")

			const runs = text.scriptRuns(surface)

			if (!runs.length) continue

			countInto(totals, "scripted_components")
			countInto(tagCounts, "scripted_components")
			countInto(counterOf(byCountry, country), "scripted_components")
			countInto(counterOf(bySource, row.source), "scripted_components")

			const scripts = new Set(runs)

			for (const script of scripts) {
				countInto(tagCounts, `script:${script}`)
			}

			if (scripts.size <= 1) continue

			rowHasMixedComponent = true

			const transitions = runs.length - 1

			countInto(totals, "mixed_components")
			countInto(totals, "script_transitions", transitions)
			countInto(tagCounts, "mixed_components")
			countInto(tagCounts, "script_transitions", transitions)
			countInto(counterOf(byCountry, country), "mixed_components")
			countInto(counterOf(bySource, row.source), "mixed_components")

			for (let i = 1; i < runs.length; i++) {
				countInto(tagCounts, `transition:${runs[i - 1]}->${runs[i]}`)
			}

			const kept = examples.get(tag) ?? []

			if (kept.length < examplesPerTag) {
				kept.push({ raw: row.raw, surface, scripts: runs, country: row.country, source: row.source })
				examples.set(tag, kept)
			}
		}

		if (rowHasMixedComponent) {
			countInto(totals, "rows_with_mixed_component")
		}
	}

	totals.set(
		"rows_cross_component_only",
		(totals.get("rows_with_multiple_scripts") ?? 0) - (totals.get("rows_with_mixed_component") ?? 0)
	)

	const finalized = (map: Map<string, Map<string, number>>) =>
		new Map(sortedByKey(map).map(([key, counts]) => [key, finalizeCounts(counts)]))

	return new Map<string, unknown>([
		["totals", finalizeCounts(totals)],
		["by_tag", finalized(byTag)],
		["by_country", finalized(byCountry)],
		["by_source", finalized(bySource)],
		["examples", new Map(sortedByKey(examples))],
	])
}

/**
 * What one mixed-script audit reads.
 */
export interface MixedScriptOptions {
	rows: number
	seed: number
	examplesPerTag?: number
	corpusDir?: string
	/**
	 * Replaces the config's affix relabel lexicon.
	 */
	affixRelabelLexiconPath?: string
}

/**
 * The first `rows` rows the train mixture draws at `seed`, each after the affix
 * relabel, as the audit reads them.
 */
export function* relabeledDraws(mtf: MTFNode, config: TrainingConfig, options: MixedScriptOptions) {
	// With every augmentation off, the emit step runs only the relabel, which draws no value from the generator.
	const stream = openRawRows(mtf, config, "train", options.seed, {
		corpusDir: options.corpusDir,
		augment: {},
		...(options.affixRelabelLexiconPath == null ? {} : { affixRelabelLexiconPath: options.affixRelabelLexiconPath }),
	})

	let remaining = options.rows

	while (remaining > 0) {
		const draws = stream.nextEmitted(Math.min(remaining, 1024))

		if (!draws.length) return

		remaining -= draws.length

		for (const { drawn, emitted } of draws) {
			yield emitted[0] ?? drawn
		}
	}
}
