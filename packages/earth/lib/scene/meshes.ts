/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * A triangle mesh in meters, with z up, in the attribute layout deck.gl's `SimpleMeshLayer` reads.
 *
 * `colors` holds linear RGB in 0–1.
 * The layer multiplies it by each instance's color.
 */
export interface SceneMesh {
	attributes: {
		positions: { value: Float32Array; size: 3 }
		normals: { value: Float32Array; size: 3 }
		colors: { value: Float32Array; size: 3 }
	}
	indices: { value: Uint32Array; size: 1 }
}

type RGB = readonly [number, number, number]

/**
 * Accumulates flat-shaded triangles, each with its own three vertices so its normal is the face normal.
 */
class MeshBuilder {
	positions: number[] = []
	normals: number[] = []
	colors: number[] = []

	triangle(a: RGB, b: RGB, c: RGB, color: RGB): void {
		const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
		const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
		const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
		const length = Math.hypot(nx, ny, nz) || 1

		for (const p of [a, b, c]) {
			this.positions.push(p[0], p[1], p[2])
			this.normals.push(nx / length, ny / length, nz / length)
			this.colors.push(color[0], color[1], color[2])
		}
	}

	quad(a: RGB, b: RGB, c: RGB, d: RGB, color: RGB): void {
		this.triangle(a, b, c, color)
		this.triangle(a, c, d, color)
	}

	build(): SceneMesh {
		const count = this.positions.length / 3

		return {
			attributes: {
				positions: { value: new Float32Array(this.positions), size: 3 },
				normals: { value: new Float32Array(this.normals), size: 3 },
				colors: { value: new Float32Array(this.colors), size: 3 },
			},
			indices: { value: Uint32Array.from({ length: count }, (_, i) => i), size: 1 },
		}
	}
}

/**
 * One horizontal cross-section of a lofted mesh.
 *
 * `ring` lists the outline's vertices counterclockwise, in meters from the mesh's axis.
 * Every ring of one loft has the same vertex count.
 */
export interface LoftRing {
	z: number
	ring: ReadonlyArray<readonly [number, number]>
	/**
	 * Color of the wall from this ring up to the next one.
	 */
	color: RGB
}

/**
 * Builds walls between consecutive rings and caps the top and bottom.
 */
export function loft(rings: readonly LoftRing[], builder = new MeshBuilder()): MeshBuilder {
	for (let level = 0; level < rings.length - 1; level++) {
		const lower = rings[level]!
		const upper = rings[level + 1]!
		const n = lower.ring.length

		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n
			const a: RGB = [lower.ring[i]![0], lower.ring[i]![1], lower.z]
			const b: RGB = [lower.ring[j]![0], lower.ring[j]![1], lower.z]
			const c: RGB = [upper.ring[j]![0], upper.ring[j]![1], upper.z]
			const d: RGB = [upper.ring[i]![0], upper.ring[i]![1], upper.z]
			builder.quad(a, b, c, d, lower.color)
		}
	}

	const cap = (section: LoftRing, up: boolean) => {
		const n = section.ring.length

		// The fan starts at the ring's centroid, so a ring offset from the mesh axis, such as a tower leg, caps correctly.
		const center: RGB = [
			section.ring.reduce((sum, [x]) => sum + x, 0) / n,
			section.ring.reduce((sum, [, y]) => sum + y, 0) / n,
			section.z,
		]

		for (let i = 0; i < n; i++) {
			const p = section.ring[i]!
			const q = section.ring[(i + 1) % n]!
			const a: RGB = [p[0], p[1], section.z]
			const b: RGB = [q[0], q[1], section.z]

			if (up) {
				builder.triangle(center, a, b, section.color)
			} else {
				builder.triangle(center, b, a, section.color)
			}
		}
	}

	cap(rings[0]!, false)
	cap(rings.at(-1)!, true)

	return builder
}

/**
 * A regular polygon's outline with `sides` vertices at `radius` meters,
 * the first vertex at `rotation` radians.
 */
export function regularRing(sides: number, radius: number, rotation = 0): Array<[number, number]> {
	return Array.from({ length: sides }, (_, i) => {
		const angle = rotation + (2 * Math.PI * i) / sides

		return [radius * Math.cos(angle), radius * Math.sin(angle)]
	})
}

/**
 * Converts an sRGB hex color to the linear 0–1 triple a mesh's `colors` attribute holds.
 */
export function hexRGB(hex: string): RGB {
	const value = Number.parseInt(hex.slice(1), 16)

	return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

/**
 * A unit broad-leaved tree: 1 m tall with a 1 m crown, scaled per instance by crown diameter and height.
 *
 * The trunk rises to 0.4 of the height.
 * The crown is a faceted ellipsoid from 0.35 to the top, so the trunk's top sits inside it.
 */
export function broadleafTreeMesh(trunk: string, crown: string): SceneMesh {
	const builder = new MeshBuilder()
	const trunkColor = hexRGB(trunk)
	const crownColor = hexRGB(crown)
	const trunkRing = regularRing(6, 0.06)

	loft(
		[
			{ z: 0, ring: trunkRing, color: trunkColor },
			{ z: 0.4, ring: trunkRing, color: trunkColor },
		],
		builder
	)

	const rings: LoftRing[] = []
	const bands = 6
	const center = 0.675
	const halfHeight = 0.325

	for (let band = 0; band <= bands; band++) {
		const phi = -Math.PI / 2 + (Math.PI * band) / bands
		// A near-zero radius at the poles keeps every ring the same vertex count.
		const radius = Math.max(0.5 * Math.cos(phi), 0.01)
		rings.push({ z: center + halfHeight * Math.sin(phi), ring: regularRing(10, radius, band * 0.3), color: crownColor })
	}

	loft(rings, builder)

	return builder.build()
}

/**
 * A unit needle-leaved tree: a short trunk under a stack of three cones,
 * scaled like {@link broadleafTreeMesh}.
 */
export function coniferTreeMesh(trunk: string, crown: string): SceneMesh {
	const builder = new MeshBuilder()
	const trunkColor = hexRGB(trunk)
	const crownColor = hexRGB(crown)
	const trunkRing = regularRing(6, 0.06)

	loft(
		[
			{ z: 0, ring: trunkRing, color: trunkColor },
			{ z: 0.3, ring: trunkRing, color: trunkColor },
		],
		builder
	)

	const tiers = [
		[0.2, 0.6, 0.5],
		[0.45, 0.8, 0.38],
		[0.65, 1, 0.26],
	] as const

	for (const [base, top, radius] of tiers) {
		loft(
			[
				{ z: base, ring: regularRing(8, radius), color: crownColor },
				{ z: top, ring: regularRing(8, 0.01), color: crownColor },
			],
			builder
		)
	}

	return builder.build()
}

/**
 * Tokyo Tower: a tapering square lattice tower, 333 m, in international orange with white bands.
 *
 * The lattice is drawn as solid tapering walls.
 * The main deck spans 145–150 m and the top deck 223–250 m.
 */
export function tokyoTowerMesh(): SceneMesh {
	const orange = hexRGB("#f2551d")
	const white = hexRGB("#f4f1ea")
	const deck = hexRGB("#c9ced3")

	const square = (half: number, cx = 0, cy = 0): Array<[number, number]> =>
		regularRing(4, half * Math.SQRT2, Math.PI / 4).map(([x, y]) => [x + cx, y + cy])

	const builder = new MeshBuilder()

	// Four legs stand at the corners of the 80 m base and lean in to meet the body at 55 m,
	// leaving the open arches between them.
	for (const [sx, sy] of [
		[1, 1],
		[-1, 1],
		[-1, -1],
		[1, -1],
	] as const) {
		loft(
			[
				{ z: 0, ring: square(7, 33 * sx, 33 * sy), color: orange },
				{ z: 30, ring: square(5.5, 25 * sx, 25 * sy), color: orange },
				{ z: 55, ring: square(4.5, 17 * sx, 17 * sy), color: orange },
			],
			builder
		)
	}

	// Approximate half-width of the square body at each height.
	// The 80 m base and 333 m height are published.
	// The bands above the top deck alternate orange and white, about 15 m each.
	const profile: Array<[z: number, half: number, color: RGB]> = [
		[50, 21.5, orange],
		[100, 15, orange],
		[125, 12, deck],
		[145, 11, deck],
		[150, 9, white],
		[165, 8, orange],
		[180, 7.2, white],
		[195, 6.4, orange],
		[210, 5.6, white],
		[223, 5, deck],
		[250, 4, orange],
		[265, 3.2, white],
		[280, 2.5, orange],
		[295, 2, white],
		[310, 1.4, orange],
		[333, 0.3, orange],
	]

	return loft(
		profile.map(([z, half, color]) => ({ z, ring: square(half), color })),
		builder
	).build()
}

/**
 * Tokyo Skytree: 634 m, a triangular base of 68 m sides that becomes a circle by 300 m.
 *
 * The Tembo Deck sits at 340–355 m and the Tembo Galleria at 445–450 m.
 * The antenna mast runs from 495 m.
 */
export function tokyoSkytreeMesh(): SceneMesh {
	const steel = hexRGB("#dfe7ee")
	const glass = hexRGB("#8fa5b8")
	const sides = 24
	// Circumradius of a triangle with 68 m sides.
	const triangle = 68 / Math.sqrt(3)

	const section = (radius: number, roundness: number): Array<[number, number]> =>
		regularRing(sides, 1).map(([x, y]) => {
			const angle = Math.atan2(y, x)
			// Distance to the triangle's edge along this angle, for a triangle with its vertices at circumradius 1.
			const sector = (((angle + Math.PI / 2) % ((2 * Math.PI) / 3)) + (2 * Math.PI) / 3) % ((2 * Math.PI) / 3)
			const edge = Math.cos(Math.PI / 3) / Math.cos(sector - Math.PI / 3)
			const r = radius * (edge + (1 - edge) * roundness)

			return [r * Math.cos(angle), r * Math.sin(angle)]
		})

	const profile: Array<[z: number, radius: number, roundness: number, color: RGB]> = [
		[0, triangle, 0, steel],
		[100, 30, 0.35, steel],
		[200, 22, 0.75, steel],
		[300, 17, 1, steel],
		[335, 16, 1, glass],
		[340, 26, 1, glass],
		[355, 26, 1, steel],
		[360, 14, 1, steel],
		[440, 11, 1, glass],
		[445, 13, 1, glass],
		[450, 13, 1, steel],
		[455, 9, 1, steel],
		[495, 6, 1, steel],
		[600, 3, 1, steel],
		[634, 0.5, 1, steel],
	]

	return loft(profile.map(([z, radius, roundness, color]) => ({ z, ring: section(radius, roundness), color }))).build()
}
