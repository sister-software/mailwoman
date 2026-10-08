/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Street-morphology FST artifact build (`mailwoman gazetteer build street-morphology`), the
 *   sealed `fst-street-morphology.bin` behind the street-context check.
 *
 *   The street-type affix matcher is serialized once at build time in the existing FST wire format,
 *   so every runtime (node and web) deserializes the same sealed artifact. The per-process builds
 *   become the degrade path (`street-morphology-fst-loader.ts`).
 *
 *   The artifact is locale-general: one binary covering every locale that ships a
 *   `street_types.txt`, with entries mapped to the synthetic `street_affix` placetype (see
 *   `resolver-wof-sqlite/street-morphology-fst-builder.ts` for the trie construction and the
 *   `minVariantLength` collision guard). Build provenance (locales ingested, counts, source dir)
 *   appears in the artifact trailer via `serializeFST`, readable back with `readFSTProvenance` and
 *   `readFSTProvenanceWeb`.
 *
 *   Output defaults to `$MAILWOMAN_DATA_ROOT/db/wof/fst-street-morphology.bin`, staged beside the
 *   per-locale FST dir (`fst-per-locale/`) rather than inside it. The artifact is written to a
 *   staging sibling, renamed into place (a previously sealed 0444 file cannot be overwritten in
 *   place), then sealed read-only.
 */

import { changeMode, makeDirectories, movePath, writeLocalFile } from "@mailwoman/core/fs/writers"
import { resourceDictionaryPath } from "@mailwoman/core/paths"
import { serializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { buildStreetMorphologyFST, STREET_MORPHOLOGY_ARTIFACT_FILENAME } from "@mailwoman/resolver-wof-sqlite/street"
import { dirname, resolvePath } from "path-ts"

export interface BuildStreetMorphologyArtifactOpts {
	/**
	 * Libpostal dictionaries root.
	 *
	 * @defaultValue core's bundled `data/libpostal/dictionaries`
	 */
	dictionariesDir?: string
	/**
	 * Locale-subfolder filter.
	 *
	 * @defaultValue every locale shipping a `street_types.txt`
	 */
	locales?: string[]
	/**
	 * Minimum post-normalization variant length.
	 *
	 * @defaultValue the builder's 3, the state-abbreviation collision guard
	 */
	minVariantLength?: number
	/**
	 * Output path.
	 *
	 * @defaultValue `$MAILWOMAN_DATA_ROOT/db/wof/fst-street-morphology.bin`
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
 * Build + seal the street-morphology FST artifact.
 *
 * @returns The written path and build counts.
 */
export async function buildStreetMorphologyArtifact(
	opts: BuildStreetMorphologyArtifactOpts = {}
): Promise<BuiltStreetMorphologyArtifact> {
	const progress = opts.onProgress ?? (() => {})
	const dictionariesDir = opts.dictionariesDir ?? resourceDictionaryPath("libpostal")
	const outPath = resolvePath(opts.output ?? wofDatabasePath(STREET_MORPHOLOGY_ARTIFACT_FILENAME))

	progress(`building street-morphology FST from ${dictionariesDir}`)

	const result = await buildStreetMorphologyFST({
		dictionariesDir,
		...(opts.locales && opts.locales.length ? { locales: opts.locales } : {}),
		...(opts.minVariantLength !== undefined ? { minVariantLength: opts.minVariantLength } : {}),
		onProgress: (phase, detail) => progress(`  [${phase}] ${detail ?? ""}`),
	})

	// Provenance appears in the artifact trailer (locales-as-countries, counts, sourceDB = the dictionaries dir).
	const bytes = serializeFST(result.matcher, result.provenance)

	await makeDirectories(dirname(outPath))
	const staging = `${outPath}.staging-${Date.now()}`
	await writeLocalFile(bytes, staging)
	await movePath(staging, outPath)
	await changeMode(outPath, 0o444)

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
