/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `parallelMapWorkers` handler behind `parseRowsWithWorkers`. Each worker thread loads one classifier per locale
 *   package from the weights cache in its `userData`, refusing a package whose loader reports an unfed required
 *   channel. It parses the rows dispatched to it with the held-out inference options (`HELDOUT_INFERENCE_RULE`) and
 *   returns each row's id with every parsed span in input order.
 */

import { workerUserData } from "@mailwoman/core/workers"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import type { BatterySpan } from "#tools/eval-harness/battery/classify"
import type { ParseRow } from "#tools/eval-harness/battery/parse/rows"
import {
	assertFedClassifier,
	heldoutWeightsLocale,
	readHeldoutLocalePackages,
	treeSpans,
} from "#tools/eval-harness/heldout/per/country"

const { cacheRoot, intraOpNumThreads } = workerUserData<{ cacheRoot: string; intraOpNumThreads: number }>()

const packages = await readHeldoutLocalePackages()
const classifiers = new Map<string, Promise<NeuralAddressClassifier>>()

/**
 * Parses one row.
 */
export async function handleItem(row: ParseRow): Promise<{ id: string; spans: BatterySpan[] }> {
	const locale = heldoutWeightsLocale(row.country, packages)
	let classifier = classifiers.get(locale)

	if (!classifier) {
		classifier = NeuralAddressClassifier.loadFromWeights({ locale, cacheRoot, intraOpNumThreads }).then((loaded) =>
			assertFedClassifier(loaded, locale, cacheRoot)
		)

		classifiers.set(locale, classifier)
	}

	const tree = await (
		await classifier
	).parse(row.raw, {
		postcodeRepair: true,
		...(row.country ? { localeHint: row.country } : {}),
	})

	return {
		id: row.id,
		spans: treeSpans(tree).toSorted((a, b) => a[1] - b[1]),
	}
}
