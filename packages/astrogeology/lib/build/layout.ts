/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where a body's build lives and what it is called: the one place the artifact names are spelled, read by the
 *   build, the verify and the publish.
 */

import { dataRootPath } from "@mailwoman/core/data-root"

import type { BuildableBodyID } from "#bodies"

export interface BuildOutputNames {
	nomenclature: string
	hillshade: string
	search: string
	manifest: string
}

/**
 * The artifact names a body's build writes, relative to its output directory.
 */
export function buildOutputs(body: BuildableBodyID): BuildOutputNames {
	return {
		nomenclature: `${body}.pmtiles`,
		hillshade: `${body}-hillshade.pmtiles`,
		search: `${body}-search.ancestrie`,
		manifest: "manifest.json",
	}
}

/**
 * The output directory a body builds into, unless `--out` names another.
 */
export function buildDirectory(body: BuildableBodyID, out: string | undefined): string {
	return out ?? String(dataRootPath("astrogeology", body, "build"))
}
