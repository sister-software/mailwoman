/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A MapLibre custom layer that extrudes compact building tiles on the GPU.
 *
 *   Each z14 tile uploads two buffers once: one instance per footprint edge, drawn as a wall quad, and the roof
 *   triangles. The layer keeps no CPU copy after the upload, draws a z14 tile at every zoom from 13 up, and evicts
 *   tiles out of view by their GPU bytes. Positions go through MapLibre's own projectTileFor3D shader function, so the layer
 *   follows the globe and mercator projections and shares the map's depth buffer.
 */

import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl"

import { mercatorWorld } from "../mercator-world.ts"
import { decodeBuildingTile, ROOF_STRIDE, TILE_ZOOM, unitMeters, WALL_STRIDE } from "./decode.ts"

/**
 * The lowest map zoom the layer draws at.
 */
const MIN_ZOOM = 13

/**
 * The GPU bytes the layer keeps before it evicts tiles out of view, least recently drawn first.
 */
const GPU_BUDGET_BYTES = 48 * 1024 * 1024

/**
 * Tile requests the layer keeps in flight at once.
 */
const MAX_REQUESTS = 6

/**
 * The tile worker's answer for a coordinate its archive holds no tile for.
 */
const HTTP_NO_CONTENT = 204

/**
 * The tile worker's answer for a zoom outside the archive.
 */
const HTTP_NOT_FOUND = 404

/**
 * Tile load times kept in {@link CompactBuildingsStats.tileReadyMs}.
 */
const TILE_TIMES_KEPT = 200

/**
 * GPU frame times kept in {@link CompactBuildingsStats.gpuFrameMs}: ten seconds at 60 frames per second.
 */
const FRAME_TIMES_KEPT = 600

/**
 * Timer queries waiting for their results at once.
 * A query's result arrives a few frames after it ends.
 */
const MAX_TIMER_QUERIES = 4

/**
 * Statistics the layer publishes on `globalThis.__mailwomanBuildings3d` for measurement.
 */
export interface CompactBuildingsStats {
	tilesResident: number
	gpuBytes: number
	buildings: number
	requests: number
	/**
	 * Milliseconds from the layer's creation to the first frame that drew a building, or `null` before one.
	 */
	firstDrawMs: number | null
	/**
	 * Milliseconds from each tile request to its upload, newest last,
	 * for the time from a camera move to buildings.
	 */
	tileReadyMs: number[]
	/**
	 * GPU milliseconds of the layer's draws in recent frames, from
	 * `EXT_disjoint_timer_query_webgl2` when the context has it.
	 */
	gpuFrameMs: number[]
}

interface ResidentTile {
	key: string
	wallVAO: WebGLVertexArrayObject
	roofVAO: WebGLVertexArrayObject
	buffers: WebGLBuffer[]
	wallCount: number
	roofIndexCount: number
	bytes: number
	lastDrawn: number
	unitMeters: number
}

/**
 * The most hidden areas the shaders test, one per city model drawn in place of these buildings.
 */
const MAX_HIDDEN_AREAS = 32

/**
 * GLSL shared by both vertex shaders: whether a tile position lies in an area another layer draws.
 */
const HIDDEN_AREA_TEST = `
uniform vec4 u_hidden[${MAX_HIDDEN_AREAS}];
uniform int u_hidden_count;
// The tile's mercator offset and scale. MapLibre's prelude declares its own copy only in the globe variant.
uniform vec4 u_tile_mercator;

bool hidden(vec2 position) {
	vec2 mercator = u_tile_mercator.xy + position * u_tile_mercator.zw;
	for (int index = 0; index < ${MAX_HIDDEN_AREAS}; index++) {
		if (index >= u_hidden_count) break;
		vec4 area = u_hidden[index];
		if (mercator.x >= area.x && mercator.x <= area.z && mercator.y >= area.y && mercator.y <= area.w) return true;
	}
	return false;
}`

/**
 * A clip-space position outside the view volume.
 * The GPU drops the triangles of a vertex placed there.
 */
const CULLED = "vec4(2.0, 2.0, 2.0, 1.0)"

const WALL_VERTEX_SHADER = `
${HIDDEN_AREA_TEST}
in vec2 a_corner;
in vec4 a_edge;
in vec2 a_height;
in vec4 a_color;
uniform float u_unit_meters;
out vec3 v_color;
out vec2 v_wall;
out float v_shade;
flat out float v_floor_height;
flat out float v_wall_height;

void main() {
	vec2 position = mix(a_edge.xy, a_edge.zw, a_corner.x);
	float base = a_height.x * 0.1;
	float top = a_height.y * 0.1;
	// A whole edge drops when its first corner lies in a hidden area.
	gl_Position = hidden(a_edge.xy) ? ${CULLED} : projectTileFor3D(position, mix(base, top, a_corner.y));

	vec2 along = a_edge.zw - a_edge.xy;
	float meters = length(along) * u_unit_meters;
	vec2 normal = normalize(vec2(along.y, -along.x) + vec2(1e-6));
	// Light from the north-west; both faces of a wall take the same shade, so ring winding does not matter.
	v_shade = 0.70 + 0.30 * abs(dot(normal, normalize(vec2(-0.6, -0.8))));
	v_wall = vec2(a_corner.x * meters, a_corner.y * (top - base));
	float floors = a_color.w * 255.0;
	v_wall_height = top - base;
	v_floor_height = floors > 0.0 ? (top - base) / floors : 3.2;
	v_color = a_color.rgb;
}`

const WALL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_color;
in vec2 v_wall;
in float v_shade;
flat in float v_floor_height;
flat in float v_wall_height;
out vec4 fragColor;

void main() {
	// A window grid: one band per floor, a window every 3 m along the wall. The ground floor and walls under 2 m stay
	// blank. Towers over 30 m take larger blue-gray glass, lower buildings smaller warm-gray windows.
	float tower = step(30.0, v_wall_height);
	vec2 cell = vec2(v_wall.x / mix(3.0, 2.0, tower), v_wall.y / v_floor_height);
	float floorY = fract(cell.y);
	float bayX = fract(cell.x);
	float inBand = step(mix(0.35, 0.18, tower), floorY) * step(floorY, mix(0.78, 0.9, tower));
	float inBay = step(mix(0.2, 0.08, tower), bayX) * step(bayX, mix(0.8, 0.92, tower));
	float aboveGround = step(v_floor_height, v_wall.y) * step(2.0, v_wall_height);
	// Where a floor or bay shrinks toward a pixel, the grid would alias into noise, so it fades to its average.
	vec2 cellsPerPixel = fwidth(cell);
	float detail = 1.0 - smoothstep(0.25, 0.6, max(cellsPerPixel.x, cellsPerPixel.y));
	float coverage = mix(0.25, 0.6, tower);
	float window = mix(coverage, inBand * inBay, detail) * aboveGround;
	vec3 glass = mix(vec3(0.62, 0.62, 0.62), vec3(0.50, 0.58, 0.68), tower);
	vec3 wall = v_color * v_shade;
	fragColor = vec4(mix(wall, glass * v_shade, window * mix(0.4, 0.65, tower)), 1.0);
}`

const ROOF_VERTEX_SHADER = `
${HIDDEN_AREA_TEST}
in vec2 a_position;
in float a_z;
in vec4 a_color;
out vec3 v_color;

void main() {
	gl_Position = hidden(a_position) ? ${CULLED} : projectTileFor3D(a_position, a_z * 0.1);
	v_color = a_color.rgb * a_color.a;
}`

const ROOF_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 fragColor;

void main() {
	fragColor = vec4(v_color, 1.0);
}`

const PROJECTION_UNIFORMS = [
	"u_projection_matrix",
	"u_projection_tile_mercator_coords",
	"u_projection_clipping_plane",
	"u_projection_transition",
	"u_projection_fallback_matrix",
] as const

interface Program {
	program: WebGLProgram
	uniforms: Map<string, WebGLUniformLocation | null>
	attributes: Map<string, number>
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
	const shader = gl.createShader(type)!

	gl.shaderSource(shader, source)
	gl.compileShader(shader)

	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		throw new Error(`building shader failed to compile: ${gl.getShaderInfoLog(shader)}`)
	}

	return shader
}

function link(
	gl: WebGL2RenderingContext,
	vertex: string,
	fragment: string,
	attributes: readonly string[],
	uniforms: readonly string[]
): Program {
	const program = gl.createProgram()!

	gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex))
	gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment))
	gl.linkProgram(program)

	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(`building shader failed to link: ${gl.getProgramInfoLog(program)}`)
	}

	return {
		program,
		uniforms: new Map(
			[...PROJECTION_UNIFORMS, ...uniforms].map((name) => [name, gl.getUniformLocation(program, name)])
		),
		attributes: new Map(attributes.map((name) => [name, gl.getAttribLocation(program, name)])),
	}
}

/**
 * The layer's id in the map style.
 */
export const COMPACT_BUILDINGS_LAYER_ID = "compact-buildings"

export class CompactBuildingsLayer implements CustomLayerInterface {
	readonly id = COMPACT_BUILDINGS_LAYER_ID
	readonly type = "custom"
	readonly renderingMode = "3d"

	readonly stats: CompactBuildingsStats = {
		tilesResident: 0,
		gpuBytes: 0,
		buildings: 0,
		requests: 0,
		firstDrawMs: null,
		tileReadyMs: [],
		gpuFrameMs: [],
	}

	#tileURL: (x: number, y: number) => string
	#hidden = new Float32Array(MAX_HIDDEN_AREAS * 4)
	#hiddenCount = 0
	#map: MapLibreMap | null = null
	#gl: WebGL2RenderingContext | null = null
	#variant = ""
	#wallProgram: Program | null = null
	#roofProgram: Program | null = null
	#cornerBuffer: WebGLBuffer | null = null
	#tiles = new Map<string, ResidentTile>()
	#empty = new Set<string>()
	#pending = new Map<string, AbortController>()
	#frame = 0
	#created = performance.now()
	#timer: { extension: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }; queries: WebGLQuery[] } | null = null

	/**
	 * @param tileURL The URL of z14 tile `(x, y)`, such as the tile worker's `<tileset>/14/<x>/<y>.bin`.
	 */
	constructor(tileURL: (x: number, y: number) => string) {
		this.#tileURL = tileURL
	}

	onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
		this.#map = map
		this.#gl = gl
		this.#cornerBuffer = gl.createBuffer()
		gl.bindBuffer(gl.ARRAY_BUFFER, this.#cornerBuffer)
		// The four corners of a wall quad as (along the edge, up the wall), drawn as a triangle strip.
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)

		const extension = gl.getExtension("EXT_disjoint_timer_query_webgl2") as {
			TIME_ELAPSED_EXT: number
			GPU_DISJOINT_EXT: number
		} | null

		if (extension) {
			this.#timer = { extension, queries: [] }
		}

		;(globalThis as { __mailwomanBuildings3d?: CompactBuildingsStats }).__mailwomanBuildings3d = this.stats
	}

	onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
		for (const controller of this.#pending.values()) {
			controller.abort()
		}

		for (const tile of this.#tiles.values()) {
			this.#release(gl, tile)
		}

		this.#tiles.clear()

		if (this.#cornerBuffer) {
			gl.deleteBuffer(this.#cornerBuffer)
		}

		for (const program of [this.#wallProgram, this.#roofProgram])
			if (program) {
				gl.deleteProgram(program.program)
			}

		this.#map = null
		this.#gl = null
	}

	#ensurePrograms(gl: WebGL2RenderingContext, shaderData: CustomRenderMethodInput["shaderData"]): void {
		if (this.#variant === shaderData.variantName && this.#wallProgram && this.#roofProgram) return

		for (const program of [this.#wallProgram, this.#roofProgram])
			if (program) {
				gl.deleteProgram(program.program)
			}

		const prelude = `#version 300 es\n${shaderData.vertexShaderPrelude}\n${shaderData.define}\n`

		this.#wallProgram = link(
			gl,
			prelude + WALL_VERTEX_SHADER,
			WALL_FRAGMENT_SHADER,
			["a_corner", "a_edge", "a_height", "a_color"],
			["u_unit_meters", "u_hidden", "u_hidden_count", "u_tile_mercator"]
		)

		this.#roofProgram = link(
			gl,
			prelude + ROOF_VERTEX_SHADER,
			ROOF_FRAGMENT_SHADER,
			["a_position", "a_z", "a_color"],
			["u_hidden", "u_hidden_count", "u_tile_mercator"]
		)

		this.#variant = shaderData.variantName

		// The vertex arrays bind attribute locations.
		// A new program may place them elsewhere, so the tiles upload again.
		for (const tile of this.#tiles.values()) {
			this.#release(gl, tile)
			this.#tiles.delete(tile.key)
		}
	}

	/**
	 * The z14 tiles the view needs, as `[x, y, wrap]`.
	 */
	#visibleTiles(): Array<[number, number, number]> {
		const map = this.#map!

		if (map.getZoom() < MIN_ZOOM) return []

		const seen = new Set<string>()
		const tiles: Array<[number, number, number]> = []

		for (const id of map.coveringTiles({ tileSize: 256, minzoom: TILE_ZOOM, maxzoom: TILE_ZOOM })) {
			const { x, y, z } = id.canonical

			if (z !== TILE_ZOOM) continue
			const key = `${x}/${y}/${id.wrap}`

			if (seen.has(key)) continue
			seen.add(key)
			tiles.push([x, y, id.wrap])
		}

		return tiles
	}

	#request(x: number, y: number): void {
		const key = `${x}/${y}`

		if (this.#pending.has(key) || this.#pending.size >= MAX_REQUESTS) return

		const controller = new AbortController()
		this.#pending.set(key, controller)

		this.stats.requests++

		const started = performance.now()

		void (async () => {
			try {
				const response = await fetch(this.#tileURL(x, y), { signal: controller.signal })

				if (response.status === HTTP_NO_CONTENT || response.status === HTTP_NOT_FOUND) {
					this.#empty.add(key)

					return
				}

				if (!response.ok || !response.body) throw new Error(`building tile ${key} answered ${response.status}`)

				const bytes = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
				const decoded = decodeBuildingTile(bytes, y)
				this.#upload(key, y, decoded)
				this.stats.tileReadyMs.push(Math.round(performance.now() - started))

				if (this.stats.tileReadyMs.length > TILE_TIMES_KEPT) {
					this.stats.tileReadyMs.shift()
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					console.warn(`[mailwoman earth] building tile ${key} failed`, error)
				}
			} finally {
				this.#pending.delete(key)
				this.#map?.triggerRepaint()
			}
		})()
	}

	#upload(key: string, y: number, decoded: ReturnType<typeof decodeBuildingTile>): void {
		const gl = this.#gl
		const walls = this.#wallProgram
		const roofs = this.#roofProgram

		if (!gl || !walls || !roofs) return

		if (decoded.buildings === 0) {
			this.#empty.add(key)

			return
		}

		const buffers: WebGLBuffer[] = []

		const buffer = (target: number, data: AllowSharedBufferSource) => {
			const created = gl.createBuffer()!
			gl.bindBuffer(target, created)
			gl.bufferData(target, data, gl.STATIC_DRAW)
			buffers.push(created)

			return created
		}

		const attribute = (program: Program, name: string) => program.attributes.get(name) ?? -1

		const wallVAO = gl.createVertexArray()!
		gl.bindVertexArray(wallVAO)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.#cornerBuffer)
		const corner = attribute(walls, "a_corner")
		gl.enableVertexAttribArray(corner)
		gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)
		buffer(gl.ARRAY_BUFFER, decoded.walls)
		const edge = attribute(walls, "a_edge")
		const height = attribute(walls, "a_height")
		const color = attribute(walls, "a_color")
		gl.enableVertexAttribArray(edge)
		gl.vertexAttribPointer(edge, 4, gl.SHORT, false, WALL_STRIDE, 0)
		gl.vertexAttribDivisor(edge, 1)
		gl.enableVertexAttribArray(height)
		gl.vertexAttribPointer(height, 2, gl.UNSIGNED_SHORT, false, WALL_STRIDE, 8)
		gl.vertexAttribDivisor(height, 1)
		gl.enableVertexAttribArray(color)
		gl.vertexAttribPointer(color, 4, gl.UNSIGNED_BYTE, true, WALL_STRIDE, 12)
		gl.vertexAttribDivisor(color, 1)

		const roofVAO = gl.createVertexArray()!
		gl.bindVertexArray(roofVAO)
		buffer(gl.ARRAY_BUFFER, decoded.roofVertices)
		const position = attribute(roofs, "a_position")
		const z = attribute(roofs, "a_z")
		const roofColor = attribute(roofs, "a_color")
		gl.enableVertexAttribArray(position)
		gl.vertexAttribPointer(position, 2, gl.SHORT, false, ROOF_STRIDE, 0)
		gl.enableVertexAttribArray(z)
		gl.vertexAttribPointer(z, 1, gl.UNSIGNED_SHORT, false, ROOF_STRIDE, 4)
		gl.enableVertexAttribArray(roofColor)
		gl.vertexAttribPointer(roofColor, 4, gl.UNSIGNED_BYTE, true, ROOF_STRIDE, 8)
		buffer(gl.ELEMENT_ARRAY_BUFFER, decoded.roofIndices)
		gl.bindVertexArray(null)

		const bytes = decoded.walls.byteLength + decoded.roofVertices.byteLength + decoded.roofIndices.byteLength

		this.#tiles.set(key, {
			key,
			wallVAO,
			roofVAO,
			buffers,
			wallCount: decoded.wallCount,
			roofIndexCount: decoded.roofIndices.length,
			bytes,
			lastDrawn: this.#frame,
			unitMeters: unitMeters(y),
		})

		this.stats.gpuBytes += bytes
		this.stats.buildings += decoded.buildings
		this.stats.tilesResident = this.#tiles.size
	}

	#release(gl: WebGL2RenderingContext, tile: ResidentTile): void {
		gl.deleteVertexArray(tile.wallVAO)
		gl.deleteVertexArray(tile.roofVAO)

		for (const buffer of tile.buffers) {
			gl.deleteBuffer(buffer)
		}

		this.stats.gpuBytes -= tile.bytes
	}

	/**
	 * Evicts the least recently drawn tiles that the current frame did not draw,
	 * until the layer is within its budget.
	 */
	#evict(gl: WebGL2RenderingContext): void {
		if (this.stats.gpuBytes <= GPU_BUDGET_BYTES) return

		const candidates = [...this.#tiles.values()]
			.filter((tile) => tile.lastDrawn !== this.#frame)
			.toSorted((a, b) => a.lastDrawn - b.lastDrawn)

		for (const tile of candidates) {
			if (this.stats.gpuBytes <= GPU_BUDGET_BYTES) break
			this.#release(gl, tile)
			this.#tiles.delete(tile.key)
		}

		this.stats.tilesResident = this.#tiles.size
	}

	#setProjection(
		gl: WebGL2RenderingContext,
		program: Program,
		args: CustomRenderMethodInput,
		x: number,
		y: number,
		wrap: number
	): void {
		const data = args.getProjectionData({ tileID: { wrap, canonical: { x, y, z: TILE_ZOOM } }, applyGlobeMatrix: true })
		const uniform = (name: string) => program.uniforms.get(name) ?? null

		gl.uniformMatrix4fv(uniform("u_projection_matrix"), false, Float32Array.from(data.mainMatrix))
		gl.uniform4fv(uniform("u_projection_tile_mercator_coords"), data.tileMercatorCoords)
		gl.uniform4fv(uniform("u_projection_clipping_plane"), data.clippingPlane)
		gl.uniform1f(uniform("u_projection_transition"), data.projectionTransition)
		gl.uniformMatrix4fv(uniform("u_projection_fallback_matrix"), false, Float32Array.from(data.fallbackMatrix))
		gl.uniform4fv(uniform("u_hidden"), this.#hidden)
		gl.uniform1i(uniform("u_hidden_count"), this.#hiddenCount)
		gl.uniform4fv(uniform("u_tile_mercator"), data.tileMercatorCoords)
	}

	/**
	 * Stops drawing the buildings inside each `[west, south, east, north]` area,
	 * where another layer draws a city model in their place.
	 * At most {@link MAX_HIDDEN_AREAS} areas count.
	 */
	setHiddenAreas(areas: ReadonlyArray<readonly [number, number, number, number]>): void {
		this.#hidden.fill(0)
		this.#hiddenCount = Math.min(areas.length, MAX_HIDDEN_AREAS)

		areas.slice(0, MAX_HIDDEN_AREAS).forEach(([west, south, east, north], index) => {
			// The area's north-west corner has the smaller mercator y.
			this.#hidden.set([...mercatorWorld(west, north), ...mercatorWorld(east, south)], index * 4)
		})

		this.#map?.triggerRepaint()
	}

	#readTimer(gl: WebGL2RenderingContext): void {
		const timer = this.#timer

		if (!timer) return

		while (timer.queries.length) {
			const query = timer.queries[0]!

			if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break
			timer.queries.shift()
			const disjoint = gl.getParameter(timer.extension.GPU_DISJOINT_EXT) as boolean

			if (!disjoint) {
				this.stats.gpuFrameMs.push((gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6)

				if (this.stats.gpuFrameMs.length > FRAME_TIMES_KEPT) {
					this.stats.gpuFrameMs.shift()
				}
			}

			gl.deleteQuery(query)
		}
	}

	render(gl: WebGL2RenderingContext | WebGLRenderingContext, args: CustomRenderMethodInput): void {
		if (!(gl instanceof WebGL2RenderingContext) || !this.#map) return

		this.#frame++
		this.#ensurePrograms(gl, args.shaderData)
		const walls = this.#wallProgram!
		const roofs = this.#roofProgram!
		const visible = this.#visibleTiles()

		if (!visible.length) return

		this.#readTimer(gl)
		const query = this.#timer && this.#timer.queries.length < MAX_TIMER_QUERIES ? gl.createQuery() : null

		if (query) {
			gl.beginQuery(this.#timer!.extension.TIME_ELAPSED_EXT, query)
		}

		gl.enable(gl.DEPTH_TEST)
		gl.depthFunc(gl.LEQUAL)
		gl.depthMask(true)
		gl.disable(gl.CULL_FACE)
		gl.disable(gl.BLEND)

		let drew = false
		const missing: Array<[number, number]> = []

		for (const [x, y, wrap] of visible) {
			const key = `${x}/${y}`
			const tile = this.#tiles.get(key)

			if (!tile) {
				if (!this.#empty.has(key)) {
					missing.push([x, y])
				}

				continue
			}

			tile.lastDrawn = this.#frame

			gl.useProgram(walls.program)
			this.#setProjection(gl, walls, args, x, y, wrap)
			gl.uniform1f(walls.uniforms.get("u_unit_meters") ?? null, tile.unitMeters)
			gl.bindVertexArray(tile.wallVAO)
			gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, tile.wallCount)

			gl.useProgram(roofs.program)
			this.#setProjection(gl, roofs, args, x, y, wrap)
			gl.bindVertexArray(tile.roofVAO)
			gl.drawElements(gl.TRIANGLES, tile.roofIndexCount, gl.UNSIGNED_INT, 0)
			drew = true
		}

		gl.bindVertexArray(null)

		if (query) {
			gl.endQuery(this.#timer!.extension.TIME_ELAPSED_EXT)
			this.#timer!.queries.push(query)
		}

		if (drew && this.stats.firstDrawMs === null) {
			this.stats.firstDrawMs = Math.round(performance.now() - this.#created)
			performance.mark("buildings3d:first-draw")
		}

		// Nearest first: coveringTiles lists the tiles nearest the camera first.
		for (const [x, y] of missing) {
			this.#request(x, y)
		}

		// Each finished request repaints the map.
		// That frame requests the next missing tiles.
		// The layer never repaints on its own, so the map can go idle.
		// Timer results are read on whichever frame comes next.
		this.#evict(gl)
	}
}
