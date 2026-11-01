// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `parallelMapWorkers` handler behind `parseBatteryRows`. Each worker thread loads one classifier per locale
 *   package from the weights cache in its `userData`. It parses the rows dispatched to it with the held-out inference
 *   options (`HELDOUT_INFERENCE_RULE`) and returns each row's id with every parsed span in input order.
 */

import { walkNodes } from "@mailwoman/core/decoder"
import { workerUserData } from "@mailwoman/core/workers"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import type { BatterySpan } from "#tools/eval-harness/battery/classify"
import { heldoutWeightsLocale, readHeldoutLocalePackages } from "#tools/eval-harness/heldout/per/country"

const { cacheRoot, intraOpNumThreads } = workerUserData<{ cacheRoot: string; intraOpNumThreads: number }>()

const packages = await readHeldoutLocalePackages()
const classifiers = new Map<string, Promise<NeuralAddressClassifier>>()

/**
 * Parses one suite row.
 */
export async function handleItem(row: {
	source_id: string
	raw: string
	country: string | null
}): Promise<{ id: string; spans: BatterySpan[] }> {
	const locale = heldoutWeightsLocale(row.country, packages)
	let classifier = classifiers.get(locale)

	if (!classifier) {
		classifier = NeuralAddressClassifier.loadFromWeights({ locale, cacheRoot, intraOpNumThreads })
		classifiers.set(locale, classifier)
	}

	const tree = await (
		await classifier
	).parse(row.raw, {
		postcodeRepair: true,
		...(row.country ? { localeHint: row.country } : {}),
	})

	return {
		id: row.source_id,
		// `end` comes from the tree node, since a node's value can differ from the raw text it spans.
		spans: [...walkNodes(tree.roots)]
			.toSorted((a, b) => a.start - b.start)
			.map((node) => [node.tag, node.start, node.end, node.value]),
	}
}
