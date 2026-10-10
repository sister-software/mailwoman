// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The thin React memo wrapper over the pure {@link computeMapPlaceRenderSpec}; a `null` place yields `null`.
 */

import { useMemo } from "react"

import { computeMapPlaceRenderSpec } from "#map/place-render"
import type { MapPlaceRenderSpec, ResolvedMapPlace } from "#map/place-render"

/**
 * Memoize the render spec for a resolved place; `null` in → `null` out (no geometry to draw).
 */
export function useMapPlaceRender(place: ResolvedMapPlace | null): MapPlaceRenderSpec | null {
	return useMemo(() => (place ? computeMapPlaceRenderSpec(place) : null), [place])
}
