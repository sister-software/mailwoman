// Copyright 2024 Sister Software, Inc. dba mailwoman
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from "node:fs"

import { $public } from "@mailwoman/core/env"
import { dataRootPath } from "@mailwoman/core/utils"

/**
 * --tiles flag → $MAILWOMAN_TILES → dataRootPath("tiles", "planet.pmtiles") if it exists → null (degrade).
 */
export function resolveTilesPath(flagValue?: string): string | null {
	if (flagValue) return flagValue

	if ($public.MAILWOMAN_TILES) return $public.MAILWOMAN_TILES

	const fallback = String(dataRootPath("tiles", "planet.pmtiles"))

	return existsSync(fallback) ? fallback : null
}
