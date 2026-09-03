#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the en-au overlay's dev artifacts. The steps live in
 *   `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`; this file is the manifest.
 *
 *   #1179 OVERLAY FORM: en-au declares `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"`, so
 *   `resolveWeights` falls through to the en-us package for `model.onnx` / `tokenizer.model`. This overlay links no
 *   model or tokenizer — it REMOVES any leftover local pair so the base fallback engages (a stale local file would
 *   SHADOW the base fallback and silently serve outdated bytes; the fr-fr manifest's header records the incident).
 *
 *   What en-au owns locally: `country-surface-lexicon-v1.json`, a checked-in repo file the country channel loads to
 *   constrain the resolver, plus the evidence lexicons its card names (the same pair the `files` array ships). en-au is INITIAL: NO postcode-au.bin (no WOF AU postcode extract exists), NO
 *   pair-index-au.bin (PIX1 not yet calibrated for AU), NO anchor-lexicon (anchor channel OFF). The overlay exists so
 *   `--locale en-AU` resolves and the resolver's country scope constrains the candidate lookup — that alone fixes the
 *   WA→Washington-State homonym class the FIRST-PASS benchmark diagnosed.
 *
 *   FRESHNESS GUARD: none needed — no derived artifacts are built, and a checked-in lexicon symlinked in place cannot
 *   go stale.
 */

import {
	COUNTRY_SURFACE_LEXICON_LINK,
	materializeDevOverlay,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "en-au",
	model: { kind: "inherit" },
	softFeed: [COUNTRY_SURFACE_LEXICON_LINK],
	evidenceLexiconsFromCard: true,
	streetMorphologyFST: true,
})
