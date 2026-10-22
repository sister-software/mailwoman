/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { tokyoSkytreeMesh, tokyoTowerMesh, type SceneMesh } from "./meshes.ts"

function vertices(mesh: SceneMesh): Array<[number, number, number]> {
	const values = mesh.attributes.positions.value
	const out: Array<[number, number, number]> = []

	for (let i = 0; i < values.length; i += 3) {
		out.push([values[i]!, values[i + 1]!, values[i + 2]!])
	}

	return out
}

describe("tokyoTowerMesh", () => {
	test("spans the 80 m base and the 333 m height", () => {
		const points = vertices(tokyoTowerMesh())

		expect(Math.max(...points.map((point) => point[2]))).toBe(333)
		expect(Math.min(...points.map((point) => point[2]))).toBe(0)
		expect(Math.max(...points.map(([x]) => x))).toBeCloseTo(40)
	})

	test("leaves the ground open between the legs", () => {
		// No vertex at ground level lies inside the arch, the square within 25 m of the axis.
		const ground = vertices(tokyoTowerMesh()).filter((point) => point[2] === 0)

		expect(ground.length).toBeGreaterThan(0)
		expect(ground.every(([x, y]) => Math.max(Math.abs(x), Math.abs(y)) >= 26)).toBe(true)
	})
})

describe("tokyoSkytreeMesh", () => {
	test("reaches 634 m", () => {
		expect(Math.max(...vertices(tokyoSkytreeMesh()).map((point) => point[2]))).toBe(634)
	})
})
