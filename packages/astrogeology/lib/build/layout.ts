/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Output directory and artifact file names for a body's build. Build, verify and publish all read them here.
 */

import { dataRootPath } from "@mailwoman/core/data-root"

import type { BuildableBodyID } from "#bodies"

/**
 * File names of a body's build artifacts.
 */
export interface BuildOutputNames {
	nomenclature: string
	hillshade: string
	search: string
	manifest: string
}

/**
 * Return the file names that a body's build writes, relative to its output directory.
 *
 * The `hillshade` archive is named `<body>-terrain` because it holds terrarium-encoded elevation.
 * An earlier archive with the `-hillshade` name held shaded images.
 *
 * A cache could serve those stale images to a client that reads elevation,
 * so the new content needs a new name.
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
 * The output directory for a body's build.
 * The `--out` flag overrides the default.
 */
export function buildDirectory(body: BuildableBodyID, out: string | undefined): string {
	return out ?? dataRootPath("astrogeology", body, "build").toString()
}
