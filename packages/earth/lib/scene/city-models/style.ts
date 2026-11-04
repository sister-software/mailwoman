/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The map's own building style for city models: each building takes a district color from the guide-map palette, and
 *   its walls take the window grid the compact building layer draws.
 *
 *   A converted city tile holds geometry and a feature id per vertex. When a tile loads, {@link styleCityModel} adds
 *   three vertex attributes from them, and {@link createCityModelMaterial} draws every tile with one shader.
 */

import { GuideMapPalette } from "@mailwoman/cartographer/base/theme"
import { BufferAttribute, DoubleSide, GLSL3, Matrix4, Mesh, type Object3D, ShaderMaterial, Vector3 } from "three"

import { byteRGB } from "../compact-buildings/decode.ts"

/**
 * The side of a district cell in meters.
 * The buildings in one cell share a palette entry.
 */
const DISTRICT_CELL_METERS = 128

const DISTRICT_COUNT = 16n

const MASK_64 = (1n << 64n) - 1n

/**
 * The palette index, 0 to 15, of the 128 m district cell holding a point.
 *
 * It is the hash `hrt` writes into each compact building tile, so a city model
 * and the compact buildings around it share district colors.
 */
export function districtIndex(longitude: number, latitude: number): number {
	const cellX = BigInt(Math.floor((longitude * 111_320 * Math.cos((latitude * Math.PI) / 180)) / DISTRICT_CELL_METERS))

	const cellY = BigInt(Math.floor((latitude * 110_540) / DISTRICT_CELL_METERS))
	let hash = ((cellX * 0x9e_37_79_b9_7f_4a_7c_15n) & MASK_64) ^ ((cellY * 0xc2_b2_ae_3d_27_d4_eb_4fn) & MASK_64)

	hash ^= hash >> 31n
	hash = (hash * 0xbf_58_47_6d_1c_e4_e5_b9n) & MASK_64
	hash ^= hash >> 29n

	// Rust's rem_euclid on the signed 64-bit value: the low four bits of the two's complement pattern.
	return Number(hash & (DISTRICT_COUNT - 1n))
}

const DISTRICT_COLORS = GuideMapPalette.buildingDistricts.map(byteRGB)

/**
 * A city's local frame: east, north and up unit vectors at its center, and the center in ECEF meters.
 */
export interface CityFrame {
	origin: Vector3
	east: Vector3
	north: Vector3
	up: Vector3
	longitude: number
	latitude: number
}

const WGS84_A = 6_378_137
const WGS84_E2 = 6.69437999014e-3

/**
 * The east-north-up frame at a point on the WGS84 ellipsoid.
 */
export function cityFrame(longitude: number, latitude: number, height = 0): CityFrame {
	const lambda = (longitude * Math.PI) / 180
	const phi = (latitude * Math.PI) / 180
	const radius = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(phi) ** 2)

	return {
		origin: new Vector3(
			(radius + height) * Math.cos(phi) * Math.cos(lambda),
			(radius + height) * Math.cos(phi) * Math.sin(lambda),
			(radius * (1 - WGS84_E2) + height) * Math.sin(phi)
		),
		east: new Vector3(-Math.sin(lambda), Math.cos(lambda), 0),
		north: new Vector3(-Math.sin(phi) * Math.cos(lambda), -Math.sin(phi) * Math.sin(lambda), Math.cos(phi)),
		up: new Vector3(Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)),
		longitude,
		latitude,
	}
}

/**
 * The glTF loader's name for the `_FEATURE_ID_0` vertex attribute.
 */
const FEATURE_ID_ATTRIBUTE = "_feature_id_0"

interface BuildingExtent {
	sumEast: number
	sumNorth: number
	count: number
	base: number
	top: number
}

/**
 * Adds the style's vertex attributes to every mesh of a loaded city tile and gives each mesh `material`.
 *
 * - `a_local`: the vertex in meters east, north and up of the city's center.
 *   Small values keep float precision.
 * - `a_building`: the building's base height and its height above that base, in meters.
 * - `a_district`: the building's district color, normalized bytes.
 *
 * A mesh without feature ids is treated as one building.
 */
export function styleCityModel(model: Object3D, frame: CityFrame, material: ShaderMaterial): void {
	model.updateMatrixWorld(true)
	const world = new Vector3()
	const relative = new Vector3()

	model.traverse((object) => {
		if (!(object instanceof Mesh)) return

		const geometry = object.geometry
		const position = geometry.getAttribute("position")
		const featureIDs = geometry.getAttribute(FEATURE_ID_ATTRIBUTE)
		const count = position.count
		const local = new Float32Array(count * 3)
		const featureOf = new Uint32Array(count)
		const extents = new Map<number, BuildingExtent>()
		const matrix = new Matrix4().copy(object.matrixWorld)

		for (let index = 0; index < count; index++) {
			// The world matrix and positions are float64 here, so the subtraction keeps sub-millimeter precision.
			world.fromBufferAttribute(position, index).applyMatrix4(matrix)
			relative.subVectors(world, frame.origin)
			const east = relative.dot(frame.east)
			const north = relative.dot(frame.north)
			const up = relative.dot(frame.up)
			const feature = featureIDs ? featureIDs.getX(index) : 0

			local[index * 3] = east
			local[index * 3 + 1] = north
			local[index * 3 + 2] = up
			featureOf[index] = feature

			const extent = extents.get(feature)

			if (extent) {
				extent.sumEast += east
				extent.sumNorth += north

				extent.count++
				extent.base = Math.min(extent.base, up)
				extent.top = Math.max(extent.top, up)
			} else {
				extents.set(feature, { sumEast: east, sumNorth: north, count: 1, base: up, top: up })
			}
		}

		const metersPerDegreeLongitude = 111_320 * Math.cos((frame.latitude * Math.PI) / 180)
		const colors = new Map<number, readonly [number, number, number]>()

		for (const [feature, extent] of extents) {
			const longitude = frame.longitude + extent.sumEast / extent.count / metersPerDegreeLongitude
			const latitude = frame.latitude + extent.sumNorth / extent.count / 110_540

			colors.set(feature, DISTRICT_COLORS[districtIndex(longitude, latitude)]!)
		}

		const building = new Float32Array(count * 2)
		const district = new Uint8Array(count * 3)

		for (let index = 0; index < count; index++) {
			const extent = extents.get(featureOf[index]!)!
			const color = colors.get(featureOf[index]!)!

			building[index * 2] = extent.base
			building[index * 2 + 1] = extent.top - extent.base
			district.set(color, index * 3)
		}

		geometry.setAttribute("a_local", new BufferAttribute(local, 3))
		geometry.setAttribute("a_building", new BufferAttribute(building, 2))
		geometry.setAttribute("a_district", new BufferAttribute(district, 3, true))
		object.material = material
	})
}

const VERTEX_SHADER = `
in vec3 a_local;
in vec2 a_building;
in vec3 a_district;
out vec3 v_local;
out vec3 v_color;
flat out vec2 v_building;

void main() {
	v_local = a_local;
	v_color = a_district;
	v_building = a_building;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

/**
 * The fragment shader.
 *
 * Its wall branch is the compact building layer's window grid, with the wall coordinate
 * taken along the facade's horizontal direction and the floor height fixed at 3.2 m.
 */
const FRAGMENT_SHADER = `
precision highp float;
in vec3 v_local;
in vec3 v_color;
flat in vec2 v_building;
out vec4 fragColor;

void main() {
	// The face normal in the local east-north-up frame, from the screen-space change in position.
	vec3 normal = normalize(cross(dFdx(v_local), dFdy(v_local)));
	float upness = abs(normal.z);

	if (upness > 0.7) {
		// Roofs take the district color a little lighter than the walls.
		fragColor = vec4(min(v_color * 1.04, vec3(1.0)), 1.0);
		return;
	}

	vec2 facing = normalize(normal.xy + vec2(1e-6));
	// Light from the north-west; both faces of a wall take the same shade.
	float shade = 0.70 + 0.30 * abs(dot(facing, normalize(vec2(-0.6, 0.8))));
	vec2 along = vec2(-facing.y, facing.x);
	float height = v_building.y;
	float floorHeight = 3.2;
	vec2 wall = vec2(dot(v_local.xy, along), v_local.z - v_building.x);

	float tower = step(30.0, height);
	vec2 cell = vec2(wall.x / mix(3.0, 2.0, tower), wall.y / floorHeight);
	float floorY = fract(cell.y);
	float bayX = fract(cell.x);
	float inBand = step(mix(0.35, 0.18, tower), floorY) * step(floorY, mix(0.78, 0.9, tower));
	float inBay = step(mix(0.2, 0.08, tower), bayX) * step(bayX, mix(0.8, 0.92, tower));
	float aboveGround = step(floorHeight, wall.y) * step(2.0, height);
	vec2 cellsPerPixel = fwidth(cell);
	float detail = 1.0 - smoothstep(0.25, 0.6, max(cellsPerPixel.x, cellsPerPixel.y));
	float coverage = mix(0.25, 0.6, tower);
	float window = mix(coverage, inBand * inBay, detail) * aboveGround;
	vec3 glass = mix(vec3(0.62, 0.62, 0.62), vec3(0.50, 0.58, 0.68), tower);
	vec3 color = v_color * shade;
	fragColor = vec4(mix(color, glass * shade, window * mix(0.4, 0.65, tower)), 1.0);
}`

/**
 * The material every city model mesh draws with.
 *
 * It reads its colors and window grid from the attributes {@link styleCityModel} adds,
 * so one instance serves every tile of every city.
 * Both faces draw, because the map's frame mirrors one axis and reverses triangle winding.
 */
export function createCityModelMaterial(): ShaderMaterial {
	return new ShaderMaterial({
		glslVersion: GLSL3,
		vertexShader: VERTEX_SHADER,
		fragmentShader: FRAGMENT_SHADER,
		side: DoubleSide,
	})
}
