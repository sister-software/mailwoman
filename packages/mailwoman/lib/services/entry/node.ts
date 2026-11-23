// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The data layers a geocode session composes on Node, one contribution per layer.
 *
 *   A new layer adds its contribution here and to {@link NODE_LAYER_CONTRIBUTIONS}.
 *   The session and `#geocode/session/services` read the list and import no layer opener themselves.
 */

import { createToken, type ServiceToken } from "async-init"
import { resolvePath } from "path-ts"

import { openBANRegionDatabases } from "#geocode/layers/ban"
import type { LayerContribution, NationalDatabaseSource } from "#geocode/layers/contributions"
import { OvertureNationalDatabaseProvider } from "#geocode/layers/national-overture"
import { openOSMRegionDatabases } from "#geocode/layers/osm"
import { createRegionDatabaseProvider } from "#geocode/layers/regions"
import { loadForkEntityDeps, loadLayerRoutes } from "#geocode/session/layers"
import { GenerationServices } from "#geocode/session/services"
import { defineUnlessProvided } from "#services/define"
import { ResolverModuleService } from "#services/resolver-module"

const S = GenerationServices

function disposeHandle(handle: Disposable | null | undefined): void {
	handle?.[Symbol.dispose]()
}

/**
 * The token of the national open-register (BAN) extracts.
 *
 * @public
 */
export const BANLayerService: ServiceToken<NationalDatabaseSource> = createToken("ban")

/**
 * The token of the national Overture address-point extracts.
 *
 * @public
 */
export const OvertureLayerService: ServiceToken<NationalDatabaseSource> = createToken("overture")

/**
 * The national open registers, such as France's BAN, as a national rooftop source.
 */
export const banLayer: LayerContribution = ({ registry, options, nationalSource }) => {
	defineUnlessProvided(registry, BANLayerService, {
		needs: { selection: S.selection },
		build: ({ selection }) => openBANRegionDatabases(options.dataRoot, selection.catalog),
	})

	nationalSource(BANLayerService)
}

const overtureLayer: LayerContribution = ({ registry, options, nationalSource }) => {
	defineUnlessProvided(registry, OvertureLayerService, {
		needs: { selection: S.selection },
		build: ({ selection }) => OvertureNationalDatabaseProvider.create(resolvePath(options.dataRoot), selection.catalog),
	})

	nationalSource(OvertureLayerService)
}

/**
 * The OpenStreetMap extracts, consulted after every national source.
 *
 * A refusal under `MAILWOMAN_REFUSE_OBLIGATIONS` isn't caught: it stops the session.
 * Each extract the provider found on disk and left unattached prints its path and reason to stderr.
 */
export const osmLayer: LayerContribution = ({ registry, options }) => {
	defineUnlessProvided(registry, S.osm, {
		needs: { selection: S.selection },
		build: async ({ selection }) => {
			const osm = await openOSMRegionDatabases(options.dataRoot, selection.catalog)

			for (const { path, reason } of osm?.unreadExtracts ?? []) {
				console.error(`  refused: ${path}, because ${reason}`)
			}

			return osm
		},
	})
}

/**
 * The address-point and interpolation databases of each region: the address layer of every
 * country that has a manifest, then the older per-state files of the United States.
 */
export const regionDatabases: LayerContribution = ({ registry, options }) => {
	defineUnlessProvided(registry, S.regionDatabases, {
		needs: { mod: ResolverModuleService, selection: S.selection },
		build: ({ mod, selection }) => createRegionDatabaseProvider(mod, options.dataRoot, selection.catalog),
	})
}

/**
 * The fork-to-entity probe over `poi.db` and the station, structure and landmark layers beside it.
 */
export const forkEntityProbe: LayerContribution = ({ registry, options }) => {
	defineUnlessProvided(registry, S.forkEntity, {
		needs: { selection: S.selection },
		build: ({ selection }) => loadForkEntityDeps(options, selection.catalog),
		release: (probe) => disposeHandle(probe.handle),
	})
}

/**
 * The observation routes over the sealed flood, soil, coastal and zoning layers.
 */
export const observationRoutes: LayerContribution = ({ registry, options }) => {
	defineUnlessProvided(registry, S.layerRoutes, {
		needs: { selection: S.selection },
		build: ({ selection }) => loadLayerRoutes(options, selection.catalog),
		release: (routes) => {
			for (const route of Object.values(routes)) {
				disposeHandle(route)
			}
		},
	})
}

/**
 * Every layer a Node session composes.
 *
 * The national sources are consulted in this order: the open registers, then Overture.
 */
export const NODE_LAYER_CONTRIBUTIONS: readonly LayerContribution[] = [
	banLayer,
	overtureLayer,
	osmLayer,
	regionDatabases,
	forkEntityProbe,
	observationRoutes,
]
