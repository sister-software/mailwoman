/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every region and locality name `defaultHoldouts()` declares is still written by a train row of a built corpus.
 *
 *   A name with 0 train rows is a holdout that removes a word from training rather than a place (#2777).
 *   The corpus is the manifest `MAILWOMAN_HOLDOUT_CHECK_MANIFEST` names, or with `default` the latest base corpus
 *   under the data root. That corpus was split by the policy it was built with, so a name this tree adds is
 *   measured against rows the new policy may later hold out. The check is exact at the rebuild that
 *   applies the current table.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { describe, expect, it } from "vitest"

import { $public } from "#env"
import { countHeldOutNameTrainRows } from "#tools/overlay/held-out-names"
import { defaultHoldouts } from "#utils/split"

// The scan reads every train row of the corpus, 50 minutes on the lab host for v0.8.0's
// 653 million rows of declared countries, beyond the 25-minute `lexicon-full` job.
// It runs when the variable holds a manifest path (`MAILWOMAN_HOLDOUT_CHECK_MANIFEST=default`
// reads the path below), before a holdout change is committed.
const requested = $public.MAILWOMAN_HOLDOUT_CHECK_MANIFEST

const manifest =
	requested && requested !== "default"
		? requested
		: dataRootPath("corpus", "versioned", "v0.8.0", "corpus-v0.8.0", "MANIFEST.json").toString()

describe.skipIf(!requested || !(await pathExists(manifest)))(`held-out names in the train split of ${manifest}`, () => {
	it(
		"finds a train row writing every declared region and locality name",
		async () => {
			const result = await countHeldOutNameTrainRows(manifest, defaultHoldouts(), {
				memoryLimitBytes: 3 * 1024 ** 3,
				threads: 2,
			})

			const removed = result.counts.filter((count) => count.trainRows === 0)

			expect(result.filesRead).toBeGreaterThan(0)

			expect(
				removed.map((count) => `${count.country} ${count.kind} ${count.name}`),
				"names no train row writes; hold the place out by a key whose removal leaves the word in training"
			).toEqual([])
		},
		90 * 60 * 1000
	)
})
