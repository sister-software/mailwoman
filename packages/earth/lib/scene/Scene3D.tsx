/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<Scene3D>` draws trees and modeled landmarks as meshes through a deck.gl overlay interleaved with the
 *   MapLibre layers, so the meshes share the map's depth buffer with the extruded buildings.
 */

import { COORDINATE_SYSTEM } from "@deck.gl/core"
import { MapboxOverlay } from "@deck.gl/mapbox"
import { SimpleMeshLayer } from "@deck.gl/mesh-layers"
import { MailwomanBaseTileSetID } from "@mailwoman/cartographer/base/theme"
import { TreeLayers, TreePalette } from "@mailwoman/cartographer/base/trees"
import type { Map as MapInstance } from "maplibre-gl"
import type React from "react"
import { useEffect, useMemo } from "react"
import { useControl, useMap } from "react-map-gl/maplibre"

import { broadleafTreeMesh, coniferTreeMesh, tokyoSkytreeMesh, tokyoTowerMesh } from "./meshes.ts"

/**
 * A tree point from the `trees` source layer, in meters.
 */
interface TreeInstance {
	position: [number, number]
	height: number
	crownDiameter: number
}

/**
 * Landmarks the basemap leaves out of its building layer so these meshes can draw them.
 *
 * The basemap's `Buildings.MODELED_LANDMARKS` lists the same coordinates.
 */
const Landmarks = [
	{ id: "tokyo-tower", position: [139.745433, 35.658581] as [number, number], mesh: tokyoTowerMesh },
	{ id: "tokyo-skytree", position: [139.8107, 35.710063] as [number, number], mesh: tokyoSkytreeMesh },
]

const TREE_MIN_ZOOM = 15

/**
 * Exposes MapLibre 6's camera transform as `map.transform`.
 *
 * `@deck.gl/mapbox` 9.4 reads `map.transform` for the viewport size and clip planes.
 * MapLibre 6 keeps that object at `map._camera.transform`, and the overlay
 * throws on every frame without this property.
 */
function exposeTransform(map: MapInstance): void {
	if ("transform" in map) return

	Object.defineProperty(map, "transform", {
		configurable: true,
		get(this: { _camera: { transform: unknown } }) {
			return this._camera.transform
		},
	})
}

/**
 * Reads the tree points from the tiles the map has loaded, dropping the copies that adjacent tiles repeat.
 */
function readTrees(map: MapInstance): { broadleaf: TreeInstance[]; conifer: TreeInstance[] } {
	const broadleaf: TreeInstance[] = []
	const conifer: TreeInstance[] = []
	const seen = new Set<string>()

	for (const feature of map.querySourceFeatures(MailwomanBaseTileSetID, {
		sourceLayer: "trees",
		filter: ["==", ["get", "kind"], "tree"],
	})) {
		if (feature.geometry.type !== "Point") continue
		const [lon, lat] = feature.geometry.coordinates as [number, number]
		const key = `${lon.toFixed(6)},${lat.toFixed(6)}`

		if (seen.has(key)) continue
		seen.add(key)

		const height = Number(feature.properties["height"])
		const crownDiameter = Number(feature.properties["crown_diameter"])

		if (!(height > 0 && crownDiameter > 0)) continue
		const tree = { position: [lon, lat] as [number, number], height, crownDiameter }

		if (feature.properties["leaf_type"] === "needleleaved") {
			conifer.push(tree)
		} else {
			broadleaf.push(tree)
		}
	}

	return { broadleaf, conifer }
}

/**
 * Mounts the deck.gl overlay on the surrounding `<Map>`.
 *
 * The overlay draws a tree mesh at each `kind=tree` point in the loaded tiles
 * and hides the extruded tree layers.
 */
export const Scene3D: React.FC = () => {
	const { current: mapRef } = useMap()
	const map = mapRef?.getMap() ?? null

	if (map) {
		exposeTransform(map)
	}

	const overlay = useControl(() => new MapboxOverlay({ interleaved: true, layers: [] }))

	const meshes = useMemo(
		() => ({
			broadleaf: broadleafTreeMesh(TreePalette.trunk, TreePalette.crown),
			conifer: coniferTreeMesh(TreePalette.trunk, TreePalette.needleCrown),
			landmarks: Landmarks.map((landmark) => ({ ...landmark, mesh: landmark.mesh() })),
		}),
		[]
	)

	useEffect(() => {
		if (!map) return

		// The overlay draws every tree, so the extruded tree layers stay hidden while it is mounted.
		// Hiding them only when the loaded tiles held points switched them back on during tile loads.
		for (const layer of TreeLayers) {
			if (map.getLayer(layer.id)) {
				map.setLayoutProperty(layer.id, "visibility", "none")
			}
		}

		// Interleaved deck.gl layers join the end of MapLibre's layer list unless they name a `beforeId`.
		// Inserting them before the first symbol layer keeps every label drawn above the meshes.
		// `@deck.gl/mapbox` reads the prop from every layer but declares it in a type its index does
		// not export, so it is spread in from this object rather than written as a typed layer prop.
		const placement = { beforeId: map.getStyle().layers.find((layer) => layer.type === "symbol")?.id }

		const landmarkLayers = meshes.landmarks.map(
			(landmark) =>
				new SimpleMeshLayer({
					id: `landmark-${landmark.id}`,
					...placement,
					data: [landmark],
					mesh: landmark.mesh,
					getPosition: (d: typeof landmark) => d.position,
					getColor: [255, 255, 255],
					coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
					material: { ambient: 0.55, diffuse: 0.6, shininess: 24, specularColor: [40, 40, 40] },
				})
		)

		// A layer or overlay change repaints the map, and the repaint fires `idle` again.
		// An update whose tree set matches the last one returns early.
		// That early return ends the cycle.
		let lastSignature: string | null = null

		const update = () => {
			const trees = map.getZoom() >= TREE_MIN_ZOOM ? readTrees(map) : { broadleaf: [], conifer: [] }
			const first = trees.broadleaf[0] ?? trees.conifer[0]
			const signature = `${trees.broadleaf.length}:${trees.conifer.length}:${first?.position.join(",") ?? ""}`

			if (signature === lastSignature) return
			lastSignature = signature

			const treeLayer = (id: string, data: TreeInstance[], mesh: typeof meshes.broadleaf) =>
				new SimpleMeshLayer<TreeInstance>({
					id,
					...placement,
					data,
					mesh,
					getPosition: (d) => d.position,
					getScale: (d) => [d.crownDiameter, d.crownDiameter, d.height],
					// A small per-tree variation in shade keeps a row of identical meshes from reading as one block.
					getColor: (d) => {
						const shade = 230 + ((d.position[0] * 1e6 + d.position[1] * 1e6) % 25)

						return [shade, shade, shade]
					},
					material: { ambient: 0.6, diffuse: 0.55, shininess: 8, specularColor: [20, 20, 20] },
					updateTriggers: { getColor: data.length },
				})

			overlay.setProps({
				layers: [
					treeLayer("trees-broadleaf", trees.broadleaf, meshes.broadleaf),
					treeLayer("trees-conifer", trees.conifer, meshes.conifer),
					...landmarkLayers,
				],
			})
		}

		update()
		map.on("idle", update)

		return () => {
			map.off("idle", update)
		}
	}, [map, overlay, meshes])

	return null
}
