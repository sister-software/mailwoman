/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unified runtime loader for the street-morphology FST — the #1315 street-context gate's signal
 *   source, previously rebuilt from the libpostal dictionaries per process at three duplicate call
 *   sites (runtime pipeline / parity eval / neural harness). The sealed artifact
 *   (`fst-street-morphology.bin`, built by `mailwoman gazetteer build street-morphology`) replaces
 *   those per-process builds; this loader is the ONE resolution ladder every node call site shares:
 *
 *   1. An explicit `artifactPath` (e.g. the weights-package sibling surfaced by
 *      `NeuralAddressClassifier.streetMorphologyPath`). When given, it is the only artifact probed.
 *   2. Otherwise the staged sealed artifact at `$MAILWOMAN_DATA_ROOT/wof/fst-street-morphology.bin`.
 *   3. Build-from-dictionaries fallback: `buildStreetMorphologyFST` over core's bundled libpostal
 *      `street_types.txt` files — the pre-artifact behavior, kept so a missing artifact degrades to
 *      a per-process build rather than a crash.
 *
 *   A present-but-unreadable artifact reports through `onWarn` and falls through to the build rung.
 *   Browsers can't take the fallback (no fs) — they deserialize the same artifact via
 *   `fst-deserialize-web.ts` (see the docs demo loader).
 */

import { existsSync, readFileSync } from "node:fs"

import { dataRootPath, resourceDictionaryPath } from "@mailwoman/core/utils"

import type { FSTMatcher } from "./fst-matcher.ts"
import { deserializeFST, readFSTProvenance } from "./fst-serialize.ts"
import type { FSTProvenance } from "./fst-types.ts"
import { buildStreetMorphologyFST } from "./street-morphology-fst-builder.ts"

/** The sealed artifact's canonical filename — identical in the data-root staging dir and as a weights-package sibling. */
export const STREET_MORPHOLOGY_ARTIFACT_FILENAME = "fst-street-morphology.bin"

/** The staged artifact's default location: `$MAILWOMAN_DATA_ROOT/wof/fst-street-morphology.bin`. */
export function defaultStreetMorphologyArtifactPath(): string {
	return String(dataRootPath("wof", STREET_MORPHOLOGY_ARTIFACT_FILENAME))
}

export interface LoadStreetMorphologyFSTOpts {
	/**
	 * Explicit artifact path (e.g. a weights-package sibling). When given it is the ONLY artifact probed — missing or
	 * unreadable degrades straight to the dictionary build, never a throw.
	 */
	artifactPath?: string
	/** Dictionaries dir for the build fallback. Defaults to core's bundled libpostal dictionaries. */
	dictionariesDir?: string
	/** Unreadable-artifact diagnostics. Defaults to silent (the caller owns its warn channel). */
	onWarn?: (message: string) => void
}

export interface LoadedStreetMorphologyFST {
	matcher: FSTMatcher
	/** Which rung produced the matcher: a sealed-artifact deserialize, or the per-process dictionary build. */
	source: "artifact" | "built"
	/** The artifact path when `source === "artifact"`. */
	path?: string
	/** Build provenance — read from the artifact trailer, or carried fresh off the fallback build. */
	provenance?: FSTProvenance
}

/** Load the street-morphology matcher: sealed artifact first, per-process dictionary build as the degrade path. */
export function loadStreetMorphologyFST(opts: LoadStreetMorphologyFSTOpts = {}): LoadedStreetMorphologyFST {
	const warn = opts.onWarn ?? (() => {})
	const artifactPath = opts.artifactPath ?? defaultStreetMorphologyArtifactPath()

	if (existsSync(artifactPath)) {
		try {
			const buf = readFileSync(artifactPath)
			const matcher = deserializeFST(buf)
			const provenance = readFSTProvenance(buf)

			return { matcher, source: "artifact", path: artifactPath, ...(provenance ? { provenance } : {}) }
		} catch (error) {
			warn(
				`street-morphology artifact at ${artifactPath} unreadable (${(error as Error).message}) — falling back to the dictionary build`
			)
		}
	}

	const built = buildStreetMorphologyFST({
		dictionariesDir: opts.dictionariesDir ?? resourceDictionaryPath("libpostal"),
	})

	return { matcher: built.matcher, source: "built", provenance: built.provenance }
}
