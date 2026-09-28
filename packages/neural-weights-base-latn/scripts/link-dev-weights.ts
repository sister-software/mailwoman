#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the base-latn overlay's dev artifacts. The overlay carries only the shared model,
 *   tokenizer, calibration and lexicons, while locale-specific data stays in each locale overlay.
 *
 *   The model pair is the same source en-us links, and `$MAILWOMAN_DEV_MODEL` or
 *   `$MAILWOMAN_DEV_TOKENIZER` overrides it. This workspace is parked and unpublished, so it
 *   carries no digest card. The shared metadata from en-us rides the soft-feed list, where a
 *   missing source warns and continues.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { committedSoftFeedLinks, materializeDevOverlay } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "base-latn",
	model: { kind: "link" },
	softFeed: [
		softFeed.anchor,
		softFeed.country,
		{
			source: workspacePath("neural-weights-en-us", "model-card.json"),
			name: "model-card.json",
			consequenceIfMissing:
				"the base-latn overlay carries no model card (labels fall back to the compile-time default).",
		},
		{
			source: workspacePath("neural-weights-en-us", "calibration.json"),
			name: "calibration.json",
			consequenceIfMissing: "confidence calibration will resolve OFF for this overlay.",
		},
		{
			source: workspacePath("neural-weights-en-us", "calibration-per-locale.json"),
			name: "calibration-per-locale.json",
			consequenceIfMissing: "per-locale confidence calibration will resolve OFF for this overlay.",
		},
	],
})
