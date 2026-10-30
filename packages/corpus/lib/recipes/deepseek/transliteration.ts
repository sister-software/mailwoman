/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The transliteration mode: renders US and French seed addresses into five non-Latin scripts.
 *
 *   Each batch holds seed rows and their target script. The model answers one JSONL line per seed, keyed by the
 *   seed's index in the batch, and each line is checked against the surface-form invariant before it is written.
 */

import {
	canonicalTranslitRow,
	type DeepSeekRow,
	loadTranslitSeeds,
	parseJSONLResponse,
	planTranslitBatches,
	type TranslitBatch,
	validateComponents,
} from "#recipes/deepseek/batches"
import type { DeepSeekCompleter } from "#recipes/deepseek/client"
import { buildTranslitUserPrompt, TRANSLIT_SYSTEM } from "#recipes/deepseek/prompts"
import {
	tallyOutcome,
	type DeepSeekSink,
	type DeepSeekWorker,
	loadCheckpoint,
	RETRY_PREFIX,
	runBatches,
	type Tally,
} from "#recipes/deepseek/run"

/**
 * The request settings both modes take from the command line.
 */
export interface DeepSeekRequestOptions {
	model: string
	maxTokens: number
	batchSize: number
	concurrency: number
	log?: (line: string) => void
}

/**
 * The transliteration mode's own options.
 */
export interface TranslitOptions extends DeepSeekRequestOptions {
	seedPaths: readonly string[]
	limit: number
	/**
	 * The script slugs to render, or every script when null or empty.
	 */
	scripts: readonly string[] | null
}

/**
 * The decimal digit value of a character of general category `Nd`.
 *
 * Unicode assigns decimal digits in contiguous runs of ten, zero to nine, so a digit's
 * value is its distance from the start of its contiguous `Nd` block, modulo ten.
 */
function decimalDigitValue(character: string): number {
	let start = character.codePointAt(0)!

	while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) {
		start--
	}

	return (character.codePointAt(0)! - start) % 10
}

const PYTHON_INT_TEXT = /^[+-]?\p{Nd}+(?:_\p{Nd}+)*$/u

/**
 * Python's `int(value)` for a JSON value, or null where `int` raises `TypeError` or `ValueError`.
 *
 * A number truncates toward zero and a boolean is 0 or 1.
 * A string may hold surrounding whitespace, a sign, and underscores between digits,
 * and its digits are any decimal digits.
 *
 * Node's Unicode tables are newer than CPython 3.12's, so a decimal digit assigned
 * after Unicode 15.0 is read here and refused by Python.
 */
export function pythonInt(value: unknown): number | null {
	if (typeof value === "boolean") return value ? 1 : 0

	if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null

	if (typeof value !== "string") return null

	const text = value.trim()

	if (!PYTHON_INT_TEXT.test(text)) return null

	const sign = text.startsWith("-") ? -1 : 1
	let total = 0

	for (const character of text.replace(/^[+-]/u, "")) {
		if (character !== "_") {
			total = total * 10 + decimalDigitValue(character)
		}
	}

	return sign * total
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The finish reason as Python's `str()` wrote it into the tally key.
 */
export function finishKey(finish: unknown): string {
	return `finish:${finish == null ? "None" : String(finish)}`
}

/**
 * The worker for one transliteration batch.
 *
 * A failed request and a truncated completion each leave the batch pending,
 * so the next run asks for it again.
 */
export function translitWorker(
	client: DeepSeekCompleter,
	options: DeepSeekRequestOptions,
	sink: DeepSeekSink
): DeepSeekWorker<TranslitBatch> {
	return async (batch) => {
		const body = {
			model: options.model,
			reasoning_effort: "low" as const,
			messages: [
				{ role: "system" as const, content: TRANSLIT_SYSTEM },
				{ role: "user" as const, content: buildTranslitUserPrompt(batch.scriptLabel, batch.seeds) },
			],
			max_tokens: options.maxTokens,
		}

		let response

		try {
			response = await client.complete(body)
		} catch {
			return [
				`${RETRY_PREFIX}${batch.batchID}`,
				new Map([
					["api_error", 1],
					["expected", batch.seeds.length],
				]),
			]
		}

		const [choice] = response.choices
		const content = choice?.message.content || ""
		const finish = choice?.finish_reason ?? null
		const tally: Tally = new Map()
		const rows: DeepSeekRow[] = []

		const records = parseJSONLResponse(content, () => tallyOutcome(tally, "parse-error"))

		for (const [position, record] of records.entries()) {
			if (!isRecord(record)) continue

			const index = ("i" in record ? pythonInt(record.i) : position) ?? position

			if (!(index >= 0 && index < batch.seeds.length)) {
				tallyOutcome(tally, "index-out-of-range")

				continue
			}

			const { raw, components } = record

			if (typeof raw !== "string" || !isRecord(components)) {
				tallyOutcome(tally, "bad-shape")

				continue
			}

			const [ok, reason] = validateComponents(raw, components)

			if (!ok) {
				tallyOutcome(tally, `reject:${reason}`)

				continue
			}

			rows.push(canonicalTranslitRow(batch, batch.seeds[index]!, raw, components as Record<string, string>))
			tallyOutcome(tally, "ok")
		}

		tally.set("expected", batch.seeds.length)
		tallyOutcome(tally, finishKey(finish))

		await sink.writeRows(rows)

		await sink.writeResponse({
			batch_id: batch.batchID,
			script_slug: batch.scriptSlug,
			seed_source_ids: batch.seeds.map((seed) => seed.source_id),
			model: options.model,
			finish_reason: finish,
			usage: response.usage ?? null,
			response_content: content,
		})

		return [finish === "length" ? `${RETRY_PREFIX}${batch.batchID}` : batch.batchID, tally]
	}
}

/**
 * Generates every planned transliteration batch the checkpoint does not already hold.
 */
export async function emitTransliteration(
	options: TranslitOptions,
	client: DeepSeekCompleter,
	sink: DeepSeekSink,
	checkpointPath: string
): Promise<Tally> {
	const log = options.log ?? console.log
	const seeds = await loadTranslitSeeds(options.seedPaths, options.limit)

	log(`loaded ${seeds.length} seed addresses`)

	const batches = planTranslitBatches(seeds, options.batchSize, options.scripts)

	log(`planned ${batches.length} batches across ${new Set(batches.map((batch) => batch.scriptSlug)).size} scripts`)

	const done = await loadCheckpoint(checkpointPath, log)
	const pending = batches.filter((batch) => !done.has(batch.batchID))

	log(`pending batches: ${pending.length}`)

	return runBatches(pending, translitWorker(client, options, sink), {
		done,
		checkpointPath,
		concurrency: options.concurrency,
		label: "Transliteration",
		sink,
		log,
	})
}
