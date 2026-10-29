/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The deterministic halves of the DeepSeek generator: the batch ids a checkpoint stores, the two batch plans,
 *   the response parser, the surface-form validator, the seed loader and the canonical rows.
 *
 *   The request path stays in `corpus-python/src/mailwoman_train/corpora/deepseek/` (`client.py`, `run.py` and the
 *   workers in `transliteration.py` and `kryptonite.py`): it calls a paid API, so it moves when it can be verified
 *   against a recorded transport. Each function here reproduces the Python one that the batch ids and row ids
 *   depend on, because a changed derivation invalidates every checkpoint on disk.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { sha256Hex } from "@mailwoman/core/hash"
import { tryParsingJSON } from "@mailwoman/core/json"
import { pyRound, pySum } from "@mailwoman/core/numeric"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import { pythonSplitLines, pythonStrip } from "@mailwoman/core/strings/python-text"
import { JSONSpliterator } from "spliterator"

import { codePointLength } from "#cjk/builder"
import {
	KRYPTONITE_CATEGORIES,
	type KryptoniteCategory,
	TRANSLIT_SCRIPTS,
	type TranslitSeed,
} from "#recipes/deepseek/prompts"
import { pythonRepr } from "#training/config/python-yaml"

/**
 * The license note each generated row carries until a writer stamps the register's license id.
 */
export const DEEPSEEK_LICENSE_LABEL = "Synthetic (DeepSeek-v4-flash, AGPL-compatible)"

const ID_HEX_CHARS = 16

/**
 * `<prefix>-<the first 16 hex characters of the payload's SHA-256>`.
 */
export function deterministicID(prefix: string, payload: string): string {
	return `${prefix}-${sha256Hex(payload).slice(0, ID_HEX_CHARS)}`
}

/**
 * The JSON object lines of a completion.
 *
 * A fence line, a line that does not begin with `{` and a line that does not parse are dropped.
 */
export function parseJSONLResponse(content: string | null | undefined): unknown[] {
	const out: unknown[] = []

	for (const line of pythonSplitLines(content || "")) {
		const text = pythonStrip(line)

		if (!text || text.startsWith("```") || !text.startsWith("{")) continue

		// A line that begins with `{` parses to an object or not at all, so a null answer is a failed parse.
		const parsed = tryParsingJSON(text)

		if (parsed != null) {
			out.push(parsed)
		}
	}

	return out
}

const MAX_RAW_CHARS = 250

/**
 * Whether every component value is a non-empty substring of `raw`, with the reason when one is not.
 */
export function validateComponents(raw: string, components: unknown): readonly [boolean, string | null] {
	if (typeof components !== "object" || components === null || Array.isArray(components)) {
		return [false, "no-components"]
	}

	const entries = Object.entries(components)

	if (!entries.length) return [false, "no-components"]

	for (const [tag, value] of entries) {
		if (typeof value !== "string" || !value) return [false, `empty-component:${tag}`]

		if (!raw.includes(value)) return [false, `not-in-raw:${tag}`]
	}

	if (!raw || codePointLength(raw) > MAX_RAW_CHARS) return [false, "raw-length"]

	return [true, null]
}

/**
 * One transliteration request: a chunk of seeds and the script it renders them into.
 */
export interface TranslitBatch {
	batchID: string
	scriptLabel: string
	scriptSlug: string
	surfaceLanguage: string
	surfaceScript: string
	seeds: TranslitSeed[]
}

/**
 * Every (script, seed chunk) pair in script order, each with the id the checkpoint stores.
 */
export function planTranslitBatches(
	seeds: readonly TranslitSeed[],
	batchSize: number,
	scripts: readonly string[] | null
): TranslitBatch[] {
	const batches: TranslitBatch[] = []

	for (const [scriptLabel, surfaceLanguage, surfaceScript, slug] of TRANSLIT_SCRIPTS) {
		if (scripts?.length && !scripts.includes(slug)) continue

		for (let start = 0; start < seeds.length; start += batchSize) {
			const chunk = seeds.slice(start, start + batchSize)
			const payload = `${pythonJSONDumps(chunk.map((seed) => seed.source_id))}|${slug}`

			batches.push({
				batchID: deterministicID(`translit-${slug}`, payload),
				scriptLabel,
				scriptSlug: slug,
				surfaceLanguage,
				surfaceScript,
				seeds: chunk,
			})
		}
	}

	return batches
}

/**
 * The least row budget a category receives, however small its weight.
 */
export const MINIMUM_PER_CATEGORY = 50

/**
 * One adversarial-case request.
 */
export interface KryptoniteBatch {
	batchID: string
	category: KryptoniteCategory
	n: number
	index: number
}

/**
 * Splits `targetCount` across the categories by weight, each at least {@linkcode MINIMUM_PER_CATEGORY}
 * with Python's half-to-even rounding, then divides each share into batches of `batchSize`.
 */
export function planKryptoniteBatches(targetCount: number, batchSize: number): KryptoniteBatch[] {
	const totalWeight = pySum(KRYPTONITE_CATEGORIES.map((category) => category.weight))
	const batches: KryptoniteBatch[] = []

	for (const category of KRYPTONITE_CATEGORIES) {
		const need = Math.max(MINIMUM_PER_CATEGORY, pyRound((targetCount * category.weight) / totalWeight))

		for (let index = 0; index < Math.ceil(need / batchSize); index++) {
			const n = Math.min(batchSize, need - index * batchSize)

			batches.push({ batchID: deterministicID(`krypt-${category.category}`, `${index}|${n}`), category, n, index })
		}
	}

	return batches
}

/**
 * The categories whose addresses are French.
 * The others are US.
 */
const FRENCH_CATEGORIES: ReadonlySet<string> = new Set(["french-saint"])

/**
 * One generated canonical row, in the key order the Python generator wrote.
 */
export type DeepSeekRow = Record<string, unknown>

/**
 * A seed's own value for a field a transliterated row cannot be written without.
 *
 * @throws When the seed has none, because no default is the address's own country or locale.
 */
function requiredSeedField(seed: TranslitSeed, field: "country" | "locale"): string {
	const value = seed[field]

	if (typeof value !== "string" || !value) {
		throw new Error(
			`seed ${pythonRepr(seed.source_id ?? "<no source_id>")} carries no ${pythonRepr(field)}; ` +
				"a transliterated row takes its country and locale from the address being rendered, " +
				"so a seed without them cannot be transliterated"
		)
	}

	return value
}

/**
 * One transliterated row, carrying the seed's country and locale and naming the script it is written in.
 */
export function canonicalTranslitRow(
	batch: TranslitBatch,
	seed: TranslitSeed,
	raw: string,
	components: Readonly<Record<string, string>>
): DeepSeekRow {
	const source = `deepseek-translit-${batch.scriptSlug}`

	return {
		raw,
		components,
		country: requiredSeedField(seed, "country"),
		locale: requiredSeedField(seed, "locale"),
		surface_script: batch.surfaceScript,
		surface_language: batch.surfaceLanguage,
		source,
		source_id: deterministicID(source, `${seed.source_id}|${raw}`),
		license: DEEPSEEK_LICENSE_LABEL,
		synth: { method: `deepseek-translit:${batch.scriptSlug}`, base_source_id: seed.source_id },
		_seed_raw: seed.raw,
	}
}

/**
 * One adversarial row: French for a French category, else US.
 */
export function canonicalKryptoniteRow(
	category: KryptoniteCategory,
	index: number,
	raw: string,
	components: Readonly<Record<string, string>>,
	kind: string
): DeepSeekRow {
	const [country, locale] = FRENCH_CATEGORIES.has(category.category) ? ["FR", "fr-FR"] : ["US", "en-US"]

	return {
		raw,
		components,
		country,
		locale,
		source: "deepseek-kryptonite",
		source_id: deterministicID("deepseek-kryptonite", `${category.category}|${index}|${raw}`),
		license: DEEPSEEK_LICENSE_LABEL,
		synth: {
			method: `deepseek-kryptonite:${category.category}`,
			base_source_id: `kryptonite-seed:${category.category}`,
		},
		_kryptonite_kind: kind,
	}
}

/**
 * Every seed row of `paths`, the first `limit` when it is set, each checked for
 * the country and locale its transliterations take.
 *
 * @throws When a file is missing, naming it, or a seed has no country or locale.
 */
export async function loadTranslitSeeds(paths: readonly string[], limit: number): Promise<TranslitSeed[]> {
	let seeds: TranslitSeed[] = []

	for (const path of paths) {
		if (!(await pathExists(path))) throw new Error(`No seed JSONL file at ${path}`)

		seeds.push(...(await Array.fromAsync(JSONSpliterator.fromAsync<TranslitSeed>(path))))
	}

	if (limit) {
		seeds = seeds.slice(0, limit)
	}

	for (const seed of seeds) {
		requiredSeedField(seed, "country")
		requiredSeedField(seed, "locale")
	}

	return seeds
}

/**
 * The corpus sources a run writes: `deepseek-kryptonite`, or one `deepseek-translit-<slug>` per script.
 */
export function emittedDeepSeekSources(
	mode: "kryptonite" | "transliteration",
	scripts: readonly string[] | null
): string[] {
	if (mode === "kryptonite") return ["deepseek-kryptonite"]

	const slugs = scripts?.length ? scripts : TRANSLIT_SCRIPTS.map((script) => script[3])

	return slugs.map((slug) => `deepseek-translit-${slug}`)
}
