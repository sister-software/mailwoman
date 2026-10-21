/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A built corpus holds out `defaultHoldouts()` places without removing a region label from training.
 *
 *   Two-sided: the table declares no region key and the train split holds no row with a declared locality or postcode
 *   prefix, while every region
 *   of a declared-holdout country keeps a train share near its country's median, in all rows and in rows with no
 *   postcode (#2777). The corpus is the manifest `MAILWOMAN_HOLDOUT_CHECK_MANIFEST` names, or with `default` the
 *   latest base corpus under the data root. That corpus was split by the policy it was built with, so the check is
 *   exact once the corpus is split by the current table.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { describe, expect, it } from "vitest"

import { $public } from "#env"
import { countHoldoutSpans, holdoutSpanFindings } from "#tools/overlay/held-out-spans"
import { defaultHoldouts } from "#utils/split"

// The scan reads every row of every declared country in the corpus.
// It runs when the variable holds a manifest path (`MAILWOMAN_HOLDOUT_CHECK_MANIFEST=default`
// reads the path below), before a holdout change is committed.
const requested = $public.MAILWOMAN_HOLDOUT_CHECK_MANIFEST

const manifest =
	requested && requested !== "default"
		? requested
		: dataRootPath("corpus", "versioned", "v0.8.0", "corpus-v0.8.0", "MANIFEST.json").toString()

describe.skipIf(!requested || !(await pathExists(manifest)))(`held-out spans in the train split of ${manifest}`, () => {
	it(
		"holds every declared place out of train and keeps every region's train supply",
		async () => {
			const holdouts = defaultHoldouts()

			const result = await countHoldoutSpans(manifest, holdouts, {
				memoryLimitBytes: 3 * 1024 ** 3,
				threads: 2,
			})

			expect(result.filesRead).toBeGreaterThan(0)

			expect(
				holdoutSpanFindings(result, holdouts).map(
					(finding) => `${finding.country} ${finding.reason} ${finding.key} (${finding.trainRows} train)`
				),
				"hold out a place below the region by a postcode district or locality, and never by a region"
			).toEqual([])
		},
		90 * 60 * 1000
	)
})
