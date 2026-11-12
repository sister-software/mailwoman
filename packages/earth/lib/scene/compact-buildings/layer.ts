// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A MapLibre custom layer that extrudes compact building tiles on the GPU.
 *
 *   Each z14 tile uploads two buffers once: one instance per footprint edge,
 *   drawn as a wall quad, and the roof triangles.
 *   The layer keeps no CPU copy after the upload, draws a z14 tile at every zoom from 13 up,
 *   and evicts tiles out of view by their GPU bytes.
 *
 *   Positions go through MapLibre's own projectTileFor3D shader function, so the layer
 *   follows the globe and mercator projections and shares the map's depth buffer.
 */

import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl"

import { mercatorWorld } from "../mercator-world.ts"
import { decodeBuildingTile, FacadeClass, ROOF_STRIDE, TILE_ZOOM, unitMeters, WALL_STRIDE } from "./decode.ts"

/**
 * The lowest map zoom the layer draws at.
 */
export const COMPACT_BUILDINGS_MIN_ZOOM = 13

const MIN_ZOOM = COMPACT_BUILDINGS_MIN_ZOOM

/**
 * Meters the storey grid starts above a building's base.
 *
 * The ground storey is that much taller than the storeys above.
 * The value is Arnis's `GROUND_FLOOR_BONUS`, two rows of one meter.
 */
const GROUND_FLOOR_BONUS = 2

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
in vec2 a_run;
in vec4 a_flags;
in vec4 a_glass;
in vec4 a_trim;
in vec4 a_bays;
uniform float u_unit_meters;
out vec3 v_color;
out vec2 v_wall;
out float v_shade;
flat out float v_floor_height;
flat out float v_wall_height;
flat out float v_run_length;
flat out vec4 v_flags;
flat out vec3 v_glass;
flat out vec4 v_trim;
flat out vec4 v_bays;

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
	// Along the wall run rather than the edge, so a vertex part way along a facade does not break its bays.
	v_wall = vec2(a_run.y * 0.1 + a_corner.x * meters, a_corner.y * (top - base));
	v_run_length = a_run.x * 0.1;
	v_flags = a_flags;
	float floors = a_color.w * 255.0;
	v_wall_height = top - base;
	// A resolved style gives the storey height in meters; 255 means the build resolved none.
	v_floor_height = a_glass.w < 255.0 ? max(a_glass.w, 2.0) : (floors > 0.0 ? (top - base) / floors : 3.2);
	v_color = a_color.rgb;
	v_glass = a_glass.rgb / 255.0;
	v_trim = vec4(a_trim.rgb / 255.0, a_trim.w);
	v_bays = a_bays;
}`

const WALL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_color;
in vec2 v_wall;
in float v_shade;
flat in float v_floor_height;
flat in float v_wall_height;
flat in float v_run_length;
flat in vec4 v_flags;
flat in vec3 v_glass;
flat in vec4 v_trim;
flat in vec4 v_bays;
out vec4 fragColor;

// Whether column i of a straight wall run len columns long is glass, as Arnis's BayLayout::plan and slot lay a run
// out: as many windows as fit between corner piers, the spare columns split between the two ends, and an odd spare
// column widening the middle pier (an even count) or the middle window (an odd count). A run of single windows with
// five or more drops one window for a wider middle pier instead.
bool bayWindow(int len, int i, int window, int pier, int cornerWidth) {
	int corner = len < 3 * (window + pier) ? 1 : max(cornerWidth, 1);
	int count = len - 2 * corner >= window ? (len - 2 * corner + pier) / (window + pier) : 0;
	if (count == 0) return false;
	int spare = len - count * window - (count - 1) * pier;
	bool wideWindow = false;
	bool widePier = false;
	if (spare % 2 == 1) {
		if (count % 2 == 0) {
			widePier = true;
		} else if (window == 1 && count >= 5) {
			// Arnis plans again with one window fewer; the count is then even, so an odd spare widens the middle pier.
			count -= 1;
			spare += window + pier;
			widePier = spare % 2 == 1;
		} else {
			wideWindow = true;
		}
	}
	int lead = spare / 2;
	if (i < lead || i >= len - lead) return false;
	int period = window + pier;
	int mid = count / 2;
	int x = i - lead;
	// Bays before the middle one, with the pier after the last of them widened.
	int before = mid * period + (widePier ? 1 : 0);
	if (x < before) return x < mid * period && x % period < window;
	int y = x - before;
	int middle = window + (wideWindow ? 1 : 0);
	if (y < middle) return true;
	return (y - middle) % period >= pier;
}

// Whether row \`row\` (meters above the storey's floor, 0 the band between storeys) of a storey \`cycle\` rows tall is
// glass under a window archetype, as Arnis's archetype_allows_window decides. The archetype indexes follow
// hrt_facade's WindowArchetype: 2 Spaced and 0 Sash keep two-row sashes, 4 Ribbon keeps a two-row spandrel and
// 9 DecoPiers keeps a spandrel under its windows on storeys of four rows or more.
bool archetypeRow(int archetype, int row, int cycle) {
	if (archetype == 4 && cycle >= 4) return row >= 2;
	if (archetype == 9 && cycle >= 4) return row >= 1 && row < cycle - 1;
	if (archetype == 2 || archetype == 0) return row >= 1 && row <= 2;
	return row >= 1;
}

void main() {
	int edgeClass = int(v_flags.x) % 4;
	int archetype = int(v_flags.z);
	int ground = int(v_flags.w);
	int styleFlags = int(v_trim.w);
	bool resolved = styleFlags != 255;
	bool hasWindows = !resolved || (styleFlags & 1) != 0;
	bool parapet = resolved && (styleFlags & 2) != 0;
	bool ribbon = resolved && (styleFlags & 4) != 0;
	bool floorLines = resolved && (styleFlags & 8) != 0;
	bool roofLine = resolved && (styleFlags & 16) != 0;
	// Bay widths in meters; a building without a resolved style takes 2 m windows, 1 m piers and 1 m corners.
	int bayWindowWidth = resolved ? int(v_bays.x) : 2;
	int bayPier = resolved ? int(v_bays.y) : 1;
	int bayCorner = resolved ? int(v_bays.z) : 1;

	// Storeys as Arnis's floor_row counts them: the grid starts ${GROUND_FLOOR_BONUS} m up, so the ground storey is
	// that much taller, and row 0 of each storey is the band between storeys.
	float cycle = v_floor_height;
	float anchored = v_wall.y - ${GROUND_FLOOR_BONUS}.0;
	float storey = floor(anchored / cycle);
	int row = int(floor(anchored - storey * cycle));
	int column = int(floor(v_wall.x));
	int len = int(v_run_length);
	float groundTop = min(${GROUND_FLOOR_BONUS}.0 + cycle, v_wall_height);
	bool groundStorey = v_wall.y < groundTop;
	// Arnis builds a wall to a whole number of storeys, so its top storey ends at the roof. An Overture height ends
	// anywhere, so a window row glazes only where it ends half a meter or more below the wall top, rather than
	// running up into the roof.
	bool wholeStorey = ${GROUND_FLOOR_BONUS}.0 + storey * cycle + float(row) + 1.0 <= v_wall_height - 0.5;
	bool street = edgeClass == ${FacadeClass.Street};
	bool party = edgeClass == ${FacadeClass.Party};

	float glassAmount = 0.0;
	if (hasWindows && !party && v_wall_height >= 2.0) {
		if (groundStorey) {
			// A shopfront (1) or lobby (2) on a street wall: display glass from the pavement up between piers, under a
			// sign band, on Arnis's shop rhythm of 3 m windows and 1 m piers.
			if (street && (ground == 1 || ground == 2)) {
				bool display = bayWindow(len, column, 3, 1, 1);
				glassAmount = display && v_wall.y < groundTop - 1.0 ? 1.0 : 0.0;
			} else if (resolved) {
				// A plain ground floor glazes like the floors above it, from the second row of the anchored grid up.
				bool glazed = v_wall.y >= ${GROUND_FLOOR_BONUS}.0 && archetypeRow(archetype, row, int(cycle));
				glassAmount = glazed && wholeStorey && bayWindow(len, column, bayWindowWidth, bayPier, bayCorner) ? 1.0 : 0.0;
			}
		} else if (wholeStorey) {
			bool inRow = archetypeRow(archetype, row, int(cycle));
			bool inBay = ribbon ? (column >= bayCorner && column < len - bayCorner) : bayWindow(len, column, bayWindowWidth, bayPier, bayCorner);
			glassAmount = inRow && inBay ? 1.0 : 0.0;
		}
	}
	// Where a storey or bay shrinks toward a pixel, the pattern would alias into noise, so it fades to its average.
	vec2 cell = vec2(v_wall.x / float(bayWindowWidth + bayPier), v_wall.y / cycle);
	vec2 cellsPerPixel = fwidth(cell);
	float detail = 1.0 - smoothstep(0.25, 0.6, max(cellsPerPixel.x, cellsPerPixel.y));
	float average = hasWindows && !party ? float(bayWindowWidth) / float(bayWindowWidth + bayPier) * 0.6 : 0.0;
	float window = mix(average, glassAmount, detail);

	vec3 wall = v_color;
	// Trim: a band at each floor line when the style draws accent lines, and a cornice along the top of a wall with a
	// parapet or an accent roof line.
	float trim = 0.0;
	// Arnis lays the accent band on row 0 of each storey, a whole meter.
	if (floorLines && !groundStorey && row == 0) trim = 1.0;
	if ((parapet || roofLine) && v_wall.y > v_wall_height - 0.6) trim = 1.0;
	if (street && (ground == 1 || ground == 2) && groundStorey && v_wall.y >= groundTop - 1.0) trim = 1.0;
	wall = mix(wall, v_trim.rgb, trim * detail);
	vec3 glass = resolved ? v_glass : vec3(0.62);
	fragColor = vec4(mix(wall, glass, window) * v_shade, 1.0);
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
	#fetching = true
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
			["a_corner", "a_edge", "a_height", "a_color", "a_run", "a_flags", "a_glass", "a_trim", "a_bays"],
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
		const run = attribute(walls, "a_run")
		gl.enableVertexAttribArray(run)
		gl.vertexAttribPointer(run, 2, gl.UNSIGNED_SHORT, false, WALL_STRIDE, 16)
		gl.vertexAttribDivisor(run, 1)
		const flags = attribute(walls, "a_flags")
		gl.enableVertexAttribArray(flags)
		gl.vertexAttribPointer(flags, 4, gl.UNSIGNED_BYTE, false, WALL_STRIDE, 20)
		gl.vertexAttribDivisor(flags, 1)

		for (const [name, at] of [
			["a_glass", 24],
			["a_trim", 28],
			["a_bays", 32],
		] as const) {
			const location = attribute(walls, name)
			gl.enableVertexAttribArray(location)
			gl.vertexAttribPointer(location, 4, gl.UNSIGNED_BYTE, false, WALL_STRIDE, at)
			gl.vertexAttribDivisor(location, 1)
		}

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
	 * Evicts the least recently drawn tiles that the current frame didn't draw,
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
	 * Pauses or resumes fetching tiles the view is missing.
	 *
	 * Resuming repaints the map, so the next frame requests what the view needs.
	 */
	setFetching(fetching: boolean): void {
		if (fetching === this.#fetching) return

		this.#fetching = fetching

		if (fetching) {
			this.#map?.triggerRepaint()
		}
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
		// While fetching is paused, the tiles already resident keep drawing and the missing ones wait.
		for (const [x, y] of this.#fetching ? missing : []) {
			this.#request(x, y)
		}

		// Each finished request repaints the map.
		// That frame requests the next missing tiles.
		// The layer never repaints on its own, so the map can go idle.
		// Timer results are read on whichever frame comes next.
		this.#evict(gl)
	}
}
