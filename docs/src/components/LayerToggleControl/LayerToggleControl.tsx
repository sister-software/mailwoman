import type { IControl, Map as MapLibreMap } from "maplibre-gl"

import styles from "./styles.module.css"

/**
 * MapLibre custom control: per-group checkboxes that toggle layer visibility. Useful while
 * debugging cartography iterations — the protomaps basemap stacks ~70 layers, many of which (POI
 * labels, hillshade, building outlines) get in the way of seeing what's underneath.
 *
 * Groups are derived heuristically from the layer-ID prefix the protomaps theme uses (`roads_*`,
 * `places_*`, `landuse_*`, `buildings_*`, `boundaries`, …) so the control adapts to whatever layers
 * the current style happens to carry. Layers not matched by any prefix pattern fall into a
 * catch-all "other" group rather than getting silently dropped.
 *
 * Future-proofing for the dashboard: if/when TIGER tracts/blocks land in the demo's style, their
 * `tiger-tracts/*` and `tiger-blocks/*` IDs get their own groups automatically.
 */
// Order matters: first match wins. Labels go first so road-label / earth-label / address-label
// don't get pulled into the Roads / Landuse buckets.
export const LAYER_GROUP_PATTERNS: ReadonlyArray<{ name: string; match: RegExp }> = [
	{ name: "Labels", match: /(?:_label|^places_|^address_label|^country)/ },
	{ name: "Background", match: /^background/ },
	{ name: "Roads", match: /^(?:roads_|bridges_|tunnel_)/ },
	{ name: "Buildings", match: /^(?:buildings|basemap-buildings)/ },
	{ name: "Boundaries", match: /^boundaries/ },
	{ name: "Water", match: /^(?:water|.*water-outline)/ },
	{ name: "Landuse / parks", match: /^(?:landuse_|landcover_|earth|park)/ },
	{ name: "POI symbols", match: /^pois?_/ },
	{ name: "Hillshade", match: /^hillshade(?:\/|$|-)/ },
	{ name: "TIGER (tracts)", match: /^tiger-tracts/ },
	{ name: "TIGER (blocks)", match: /^tiger-blocks/ },
]

export class LayerToggleControl implements IControl {
	private map: MapLibreMap | null = null
	private container: HTMLDivElement | null = null
	private styleListener: (() => void) | null = null

	onAdd(map: MapLibreMap): HTMLElement {
		this.map = map
		this.container = document.createElement("div")
		this.container.className = `maplibregl-ctrl maplibregl-ctrl-group ${styles.layerToggleCtrl}`
		// Render a placeholder so the panel is visible immediately; replace once layers land.
		this.renderPlaceholder()
		// Re-render whenever the style swaps (theme toggle, etc.) AND when sources finish
		// loading — styledata can fire before any layers are populated. Guard against the
		// empty-layers race by skipping renders that would produce 0 buckets.
		this.styleListener = () => {
			if (!this.map?.isStyleLoaded()) return
			const layers = this.map.getStyle()?.layers ?? []
			if (layers.length === 0) return
			this.render()
		}
		map.on("styledata", this.styleListener)
		map.on("idle", this.styleListener)
		return this.container
	}

	private renderPlaceholder(): void {
		if (!this.container) return
		this.container.replaceChildren()
		const heading = document.createElement("div")
		heading.className = styles.layerToggleHeading
		heading.textContent = "Layers"
		this.container.appendChild(heading)
		const spinner = document.createElement("div")
		spinner.className = styles.layerToggleLabel
		spinner.textContent = "loading…"
		this.container.appendChild(spinner)
	}

	onRemove(): void {
		if (this.map && this.styleListener) {
			this.map.off("styledata", this.styleListener)
			this.map.off("idle", this.styleListener)
		}
		this.container?.remove()
		this.container = null
		this.map = null
	}

	private render(): void {
		if (!this.map || !this.container) return
		const style = this.map.getStyle()
		if (!style?.layers) return

		// Bucket every layer into a group (catch-all → "Other"). Skip mailwoman-bbox + marker
		// layers — they're transient resolver output, not part of the basemap.
		type Bucket = { name: string; layerIds: string[]; visible: boolean }
		const buckets = new Map<string, Bucket>()
		for (const layer of style.layers) {
			const id = layer.id
			if (id.startsWith("mailwoman-")) continue
			const group = LAYER_GROUP_PATTERNS.find((g) => g.match.test(id))?.name ?? "Other"
			if (!buckets.has(group)) buckets.set(group, { name: group, layerIds: [], visible: true })
			const bucket = buckets.get(group)!
			bucket.layerIds.push(id)
			// Group is "visible" if at least one of its layers is visible (default vs explicit none).
			const vis = layer.layout && "visibility" in layer.layout ? layer.layout["visibility"] : "visible"
			if (vis === "none") {
				// keep bucket.visible if any other layer in the group is visible; flip later
			} else {
				bucket.visible = true
			}
		}
		// Re-compute bucket.visible — a group is visible iff ANY of its layers is currently
		// visible. (Above loop's logic was lossy on the no-layout-visibility case; redo cleanly.)
		for (const bucket of buckets.values()) {
			bucket.visible = bucket.layerIds.some((id) => {
				const lyr = style.layers.find((l) => l.id === id)
				const v = lyr?.layout && "visibility" in lyr.layout ? lyr.layout["visibility"] : "visible"
				return v !== "none"
			})
		}

		this.container.replaceChildren()
		const heading = document.createElement("div")
		heading.className = styles.layerToggleHeading
		heading.textContent = "Layers"
		this.container.appendChild(heading)

		// Stable display order: pattern order first, then "Other".
		const orderedNames = [...LAYER_GROUP_PATTERNS.map((g) => g.name), "Other"]
		for (const name of orderedNames) {
			const bucket = buckets.get(name)
			if (!bucket) continue
			const row = document.createElement("label")
			row.className = styles.layerToggleRow
			const cb = document.createElement("input")
			cb.type = "checkbox"
			cb.checked = bucket.visible
			cb.addEventListener("change", () => {
				const visibility = cb.checked ? "visible" : "none"
				for (const layerId of bucket.layerIds) {
					try {
						this.map?.setLayoutProperty(layerId, "visibility", visibility)
					} catch {
						// layer disappeared between render and toggle; ignore
					}
				}
			})
			row.appendChild(cb)
			const label = document.createElement("span")
			label.className = styles.layerToggleLabel
			label.textContent = `${name} (${bucket.layerIds.length})`
			row.appendChild(label)
			this.container.appendChild(row)
		}
	}
}
