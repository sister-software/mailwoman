// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The default read-time WOF reverse geocoder for POI ancestry.
 *
 *   `createRuntimePipeline({ poiQueryKind: { poiDatabasePath } })` reads it from its scope
 *   and wires a synchronous adapter into `createPOIExecutor`'s `reverseGeocode` dependency.
 *   The executor is called synchronously, so the adapter calls `WOFReverseGeocoder.reverseGeocodeSync`.
 *
 *   `@mailwoman/resolver-wof-sqlite` is an optional peer, and the admin gazetteer
 *   with its `place_bbox` R*Tree (`mailwoman gazetteer build fts`) is a build
 *   artifact of several gigabytes that may be absent.
 *   Either gap yields `null`, and POI results then have no `ancestry` key.
 *
 *   The polygon database (`wof-polygons.db`) is optional too.
 *   Without it every ancestry chain still resolves, as `containment: "approximate"`.
 *
 *   The admin database is the first one `existingWOFDatabasePaths()` returns,
 *   the default the Photon and Nominatim servers use for their own reverse geocoder.
 *   The polygon database is read from `$MAILWOMAN_WOF_POLYGONS_DB`, as `mailwoman reverse` reads it.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { WOFReverseGeocoder } from "@mailwoman/resolver-wof-sqlite"
import { createToken, optional, type ServiceRegistry, type ServiceToken } from "async-init"

import { existingWOFDatabasePaths } from "#engine/resolver-backend"
import { $public } from "#env"
import { defineUnlessProvided } from "#services/define"
import { registerResolverModuleService, ResolverModuleService } from "#services/resolver-module"

/**
 * The token of the default reverse geocoder.
 *
 * It is `null` when no admin database is on disk or `@mailwoman/resolver-wof-sqlite` can't be resolved.
 *
 * @public
 */
export const ReverseGeocoderService: ServiceToken<WOFReverseGeocoder | null> = createToken("reverse-geocoder")

/**
 * Registers the default reverse geocoder on `registry`, with the resolver module it is built from.
 *
 * The databases open when a caller first needs the service, and the scope closes them.
 */
export function registerReverseGeocoderService(registry: ServiceRegistry): void {
	registerResolverModuleService(registry)

	defineUnlessProvided(registry, ReverseGeocoderService, {
		needs: { mod: optional(ResolverModuleService) },
		build: async ({ mod }) => {
			if (!mod) return null

			try {
				const [adminDBPath] = await existingWOFDatabasePaths()

				if (!adminDBPath) return null

				const polygonDBPath = $public.MAILWOMAN_WOF_POLYGONS_DB

				return new mod.WOFReverseGeocoder({
					adminDBPath,
					...(polygonDBPath && (await pathExists(polygonDBPath)) ? { polygonDBPath } : {}),
				})
			} catch {
				return null
			}
		},
	})
}
