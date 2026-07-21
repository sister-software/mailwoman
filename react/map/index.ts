/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/react/map` — the geocoder-demo map surface, kept behind its OWN subpath so `maplibre-gl`
 *   / `react-map-gl` (WebGL + DOM at import) never enter the package-root graph. Importing this subpath
 *   pulls the map deps; importing `@mailwoman/react` (root) does not. Consumers who only want the
 *   parse/POI explorers never pay for maplibre.
 *
 *   The host must supply `maplibre-gl` + `react-map-gl` (peer deps) and import
 *   `maplibre-gl/dist/maplibre-gl.css` + `@mailwoman/react/styles.css` itself.
 */

export { DemoMap } from "./DemoMap.tsx"
export type { DemoMapExtraProps, DemoMapProps, DemoMapStyle } from "./DemoMap.tsx"
export type {
	DemoBackend,
	DemoRuntime,
	DemoVersionOption,
	LngLatTuple,
	MapBias,
	OverlaySpec,
	Suggestion,
} from "./types.ts"
