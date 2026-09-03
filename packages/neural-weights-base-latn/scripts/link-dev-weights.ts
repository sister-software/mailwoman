#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the base-latn overlay's dev artifacts (FST-distribution arc precedent — the same shape as the locale
 *   weights packages, but it carries only the shared model + tokenizer + calibration + lexicons; locale-specific data
 *   stays in each overlay). The steps live in `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`; this file is
 *   the manifest.
 *
 *   The model pair is the same source en-us links (`$MAILWOMAN_DEV_MODEL` / `$MAILWOMAN_DEV_TOKENIZER` override it),
 *   without a digest card: this workspace is parked and unpublished (#1177). The shared metadata (en-us's committed
 *   card and calibration pair) rides the soft-feed list with the same warn-and-continue miss semantics — each
 *   consequence line says which channel or metadata just resolved OFF for this overlay.
 */

import { workspacePath } from "@mailwoman/core/paths"
import {
	ANCHOR_LEXICON_LINK,
	COUNTRY_SURFACE_LEXICON_LINK,
	materializeDevOverlay,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "base-latn",
	model: { kind: "link" },
	softFeed: [
		ANCHOR_LEXICON_LINK,
		COUNTRY_SURFACE_LEXICON_LINK,
		{
			source: String(workspacePath("neural-weights-en-us", "model-card.json")),
			name: "model-card.json",
			consequenceIfMissing:
				"the base-latn overlay carries no model card (labels fall back to the compile-time default).",
		},
		{
			source: String(workspacePath("neural-weights-en-us", "calibration.json")),
			name: "calibration.json",
			consequenceIfMissing: "confidence calibration will resolve OFF for this overlay.",
		},
		{
			source: String(workspacePath("neural-weights-en-us", "calibration-per-locale.json")),
			name: "calibration-per-locale.json",
			consequenceIfMissing: "per-locale confidence calibration will resolve OFF for this overlay.",
		},
	],
})
