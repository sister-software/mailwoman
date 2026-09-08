// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { PlanetaryMapConfig } from "#bodies/config"
import { MARS } from "#bodies/mars"
import { MOON } from "#bodies/moon"
import type { PlanetaryBody } from "#body"

export type { PlanetaryMapConfig, PlanetaryView } from "#bodies/config"

/**
 * One config per body, keyed by the body the build is for.
 */
export const BODY_CONFIGS: Readonly<Record<PlanetaryBody, PlanetaryMapConfig>> = {
	moon: MOON,
	mars: MARS,
}
