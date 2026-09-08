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
 *
 * The elevation archive is `<body>-terrain`, not `<body>-hillshade`, and the rename is the point rather than a tidy-up.
 * Its CONTENT changed — from a shaded greyscale picture to terrarium-encoded height — and the two are indistinguishable
 * to a cache. Publishing the new bytes under the old name would leave the edge free to serve a cached picture to a
 * client that reads it as elevation, which renders as relief that is wrong rather than absent. A new name also leaves
 * the old archive in place to roll back to.
 */
export function buildOutputs(body: BuildableBodyID): BuildOutputNames {
	return {
		nomenclature: `${body}.pmtiles`,
		hillshade: `${body}-terrain.pmtiles`,
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
