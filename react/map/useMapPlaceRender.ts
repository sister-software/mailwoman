/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useMapPlaceRender` — the thin React memo wrapper over the pure {@link computeMapPlaceRenderSpec}. It
 *   recomputes the render spec only when the resolved place changes, so the declarative overlays render a
 *   stable spec object. The MATH lives in `place-render.ts` (pure, node-tested); this file adds nothing
 *   but memoization, so it stays trivially correct. A `null` place (no result yet, or a result with no
 *   candidate) yields `null` — the overlays render nothing.
 */

import { useMemo } from "react"

import { computeMapPlaceRenderSpec } from "./place-render.ts"
import type { MapPlaceRenderSpec, ResolvedMapPlace } from "./place-render.ts"

/** Memoize the render spec for a resolved place; `null` in → `null` out (nothing to draw). */
export function useMapPlaceRender(place: ResolvedMapPlace | null | undefined): MapPlaceRenderSpec | null {
	return useMemo(() => (place ? computeMapPlaceRenderSpec(place) : null), [place])
}
