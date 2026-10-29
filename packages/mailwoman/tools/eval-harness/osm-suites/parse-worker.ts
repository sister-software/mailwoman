/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker module `gradeOSMSuite` runs under `parallelMapWorkers`. Each worker loads the classifier of a
 *   row's weights locale once, from the weights cache `workerData.userData` names, and scores every row it is
 *   handed as the held-out grader scores it: exact parse correctness under the country's street convention.
 */

import { workerData } from "node:worker_threads"

import {
	type HeldoutClassifier,
	type HeldoutRowOutcome,
	heldoutWeightsLocale,
	scoreHeldoutRow,
} from "#tools/eval-harness/heldout/per/country"
import type { OSMSuiteRow } from "#tools/eval-harness/osm-suites/extract"

/**
 * What every worker receives.
 */
export interface SuiteParseWorkerData {
	/**
	 * A package-shaped weights cache, as `mwdev_arc` writes one.
	 */
	cacheRoot: string
	/**
	 * Country to weights locale, as `readHeldoutLocalePackages` reads the release configuration.
	 */
	packages: ReadonlyArray<[string, string]>
}

const { cacheRoot, packages } = (workerData?.userData ?? {}) as SuiteParseWorkerData
// A worker started without `userData` has no packages, and every row then reads the base locale.
const localePackages = packages ? new Map(packages) : new Map<string, string>()
const classifiers = new Map<string, Promise<HeldoutClassifier>>()

async function classifierFor(locale: string): Promise<HeldoutClassifier> {
	let pending = classifiers.get(locale)

	if (!pending) {
		const { NeuralAddressClassifier } = await import("@mailwoman/neural")

		pending = NeuralAddressClassifier.loadFromWeights({ locale, cacheRoot })
		classifiers.set(locale, pending)
	}

	return pending
}

/**
 * Parse one suite row with its country's locale and score it.
 */
export async function handleItem(row: OSMSuiteRow): Promise<HeldoutRowOutcome> {
	const classifier = await classifierFor(heldoutWeightsLocale(row.country, localePackages))

	const tree = await classifier.parse(row.raw, {
		postcodeRepair: true,
		...(row.country ? { localeHint: row.country } : {}),
	})

	return scoreHeldoutRow(row, tree)
}
