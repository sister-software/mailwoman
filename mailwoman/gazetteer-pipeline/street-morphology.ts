/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Street-morphology FST artifact build (`mailwoman gazetteer build street-morphology`) — the
 *   sealed `fst-street-morphology.bin` behind the #1315 street-context gate.
 *
 *   THE MOVE (static-index survey candidate 1, 2026-07-26): the street-type affix matcher was built
 *   from the libpostal `street_types.txt` dictionaries per process at three duplicate node call
 *   sites, and never in the browser — the demo silently ran without the street-context gate the node
 *   runtimes apply by default (SCOPE invariant 2 violation). Serializing the matcher once, at build
 *   time, through the EXISTING FST wire format gives every runtime — node and web — the same sealed
 *   artifact to deserialize, and the per-process builds become the degrade path
 *   (`street-morphology-fst-loader.ts`), not the default.
 *
 *   The artifact is locale-GENERAL: one binary covering every locale that ships a
 *   `street_types.txt`, entries mapped to the synthetic `street_affix` placetype (see
 *   `resolver-wof-sqlite/street-morphology-fst-builder.ts` for the trie construction + the
 *   `minVariantLength` collision guard). Build provenance (locales ingested, counts, source dir)
 *   rides the artifact trailer via `serializeFST`, readable back with `readFSTProvenance` /
 *   `readFSTProvenanceWeb`.
 *
 *   Output defaults to `$MAILWOMAN_DATA_ROOT/wof/fst-street-morphology.bin` — staged BESIDE the
 *   per-locale FST dir (`fst-per-locale/`), never inside it. Sealed-artifact discipline: write to a
 *   staging sibling, rename into place (a previously-sealed 0444 file can't be overwritten
 *   in-place), then seal read-only.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { dataRootPath, resourceDictionaryPath } from "@mailwoman/core/utils"
import { serializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import { buildStreetMorphologyFST } from "@mailwoman/resolver-wof-sqlite/street-morphology-fst-builder"
import { STREET_MORPHOLOGY_ARTIFACT_FILENAME } from "@mailwoman/resolver-wof-sqlite/street-morphology-fst-loader"

export interface BuildStreetMorphologyArtifactOpts {
	/**
	 * Libpostal dictionaries root (default: core's bundled `data/libpostal/dictionaries`).
	 */
	dictionariesDir?: string
	/**
	 * Locale-subfolder filter (default: every locale shipping a `street_types.txt`).
	 */
	locales?: string[]
	/**
	 * Minimum post-normalization variant length (default: the builder's 3 — the state-abbreviation collision guard).
	 */
	minVariantLength?: number
	/**
	 * Output path (default: `$MAILWOMAN_DATA_ROOT/wof/fst-street-morphology.bin`).
	 */
	output?: string
	onProgress?: (line: string) => void
}

export interface BuiltStreetMorphologyArtifact {
	path: string
	bytes: number
	canonicalCount: number
	variantCount: number
	localeCount: number
}

/**
 * Build + seal the street-morphology FST artifact. Returns the written path and build counts.
 */
export function buildStreetMorphologyArtifact(
	opts: BuildStreetMorphologyArtifactOpts = {}
): BuiltStreetMorphologyArtifact {
	const progress = opts.onProgress ?? (() => {})
	const dictionariesDir = opts.dictionariesDir ?? resourceDictionaryPath("libpostal")
	const outPath = resolve(opts.output ?? String(dataRootPath("wof", STREET_MORPHOLOGY_ARTIFACT_FILENAME)))

	progress(`building street-morphology FST from ${dictionariesDir}`)

	const result = buildStreetMorphologyFST({
		dictionariesDir,
		...(opts.locales && opts.locales.length ? { locales: opts.locales } : {}),
		...(opts.minVariantLength !== undefined ? { minVariantLength: opts.minVariantLength } : {}),
		onProgress: (phase, detail) => progress(`  [${phase}] ${detail ?? ""}`),
	})

	// Provenance rides the artifact trailer (locales-as-countries, counts, sourceDB = the dictionaries dir).
	const bytes = serializeFST(result.matcher, result.provenance)

	mkdirSync(dirname(outPath), { recursive: true })
	const staging = `${outPath}.staging-${Date.now()}`
	writeFileSync(staging, bytes)
	renameSync(staging, outPath)
	chmodSync(outPath, 0o444)

	progress(
		`  wrote ${outPath} (${(bytes.length / 1e3).toFixed(0)} kB, ${result.canonicalCount} canonicals, ${result.variantCount} variants, ${result.locales.length} locales) — sealed 0444`
	)

	return {
		path: outPath,
		bytes: bytes.length,
		canonicalCount: result.canonicalCount,
		variantCount: result.variantCount,
		localeCount: result.locales.length,
	}
}
