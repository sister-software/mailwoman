/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The kryptonite mode: deliberately confusing addresses, one adversarial category at a time.
 *
 *   The row budget is split across the categories by weight (`planKryptoniteBatches`), and each returned line is
 *   checked against the surface-form invariant before it is written.
 *
 *   A failed request leaves its batch pending. The Python worker marked it complete, so a rerun never asked for
 *   that category's rows again. No row of such a batch was written. A truncated completion still completes its
 *   batch, as in Python, because a kryptonite row's id includes its line position and a second request would
 *   generate other rows.
 */

import {
	canonicalKryptoniteRow,
	type DeepSeekRow,
	type KryptoniteBatch,
	parseJSONLResponse,
	planKryptoniteBatches,
	validateComponents,
} from "#recipes/deepseek/batches"
import type { DeepSeekCompleter } from "#recipes/deepseek/client"
import { buildKryptoniteUserPrompt, KRYPTONITE_SYSTEM } from "#recipes/deepseek/prompts"
import {
	tallyOutcome,
	type DeepSeekSink,
	type DeepSeekWorker,
	loadCheckpoint,
	RETRY_PREFIX,
	runBatches,
	type Tally,
} from "#recipes/deepseek/run"
import { type DeepSeekRequestOptions, finishKey } from "#recipes/deepseek/transliteration"

/**
 * The kryptonite mode's own options.
 */
export interface KryptoniteOptions extends DeepSeekRequestOptions {
	/**
	 * The total row budget across the categories.
	 */
	targetCount: number
}

/**
 * The worker for one kryptonite batch.
 */
export function kryptoniteWorker(
	client: DeepSeekCompleter,
	options: DeepSeekRequestOptions,
	sink: DeepSeekSink
): DeepSeekWorker<KryptoniteBatch> {
	return async (batch) => {
		const { category } = batch

		const body = {
			model: options.model,
			reasoning_effort: "low" as const,
			messages: [
				{ role: "system" as const, content: KRYPTONITE_SYSTEM },
				{ role: "user" as const, content: buildKryptoniteUserPrompt(category, batch.n) },
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
					["expected", batch.n],
				]),
			]
		}

		const [choice] = response.choices
		const content = choice?.message.content || ""
		const finish = choice?.finish_reason ?? null
		const tally: Tally = new Map()
		const rows: DeepSeekRow[] = []

		for (const [position, record] of parseJSONLResponse(content).entries()) {
			const fields = record as Record<string, unknown>
			const { raw, components } = fields
			const kind = (fields.kind as string | null | undefined) || category.category

			if (
				typeof raw !== "string" ||
				typeof components !== "object" ||
				components === null ||
				Array.isArray(components)
			) {
				tallyOutcome(tally, "bad-shape")

				continue
			}

			const [ok, reason] = validateComponents(raw, components)

			if (!ok) {
				tallyOutcome(tally, `reject:${reason}`)

				continue
			}

			rows.push(canonicalKryptoniteRow(category, position, raw, components as Record<string, string>, kind))
			tallyOutcome(tally, "ok")
		}

		tally.set("expected", batch.n)
		tallyOutcome(tally, finishKey(finish))

		await sink.writeRows(rows)

		await sink.writeResponse({
			batch_id: batch.batchID,
			category: category.category,
			n_requested: batch.n,
			model: options.model,
			finish_reason: finish,
			usage: response.usage ?? null,
			response_content: content,
		})

		return [batch.batchID, tally]
	}
}

/**
 * Generates every planned kryptonite batch the checkpoint does not already hold.
 */
export async function emitKryptonite(
	options: KryptoniteOptions,
	client: DeepSeekCompleter,
	sink: DeepSeekSink,
	checkpointPath: string
): Promise<Tally> {
	const log = options.log ?? console.log
	const batches = planKryptoniteBatches(options.targetCount, options.batchSize)

	log(`planned ${batches.length} kryptonite batches`)

	const done = await loadCheckpoint(checkpointPath, log)
	const pending = batches.filter((batch) => !done.has(batch.batchID))

	log(`pending batches: ${pending.length}`)

	return runBatches(pending, kryptoniteWorker(client, options, sink), {
		done,
		checkpointPath,
		concurrency: options.concurrency,
		label: "Kryptonite",
		sink,
		log,
	})
}
