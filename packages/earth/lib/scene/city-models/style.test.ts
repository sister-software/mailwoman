/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { GuideMapPalette } from "@mailwoman/cartographer/base/theme"
import { BufferAttribute, BufferGeometry, Group, Mesh, Vector3 } from "three"
import { describe, expect, it } from "vitest"

import { cityFrame, createCityModelMaterial, districtIndex, styleCityModel } from "#scene/city-models/style"
import { byteRGB } from "#scene/compact-buildings/decode"

describe("districtIndex", () => {
	it("spreads over all sixteen palette entries and gives points in one 128 m cell one index", () => {
		const seen = new Set<number>()

		for (let step = 0; step < 400; step++) {
			seen.add(districtIndex(135.5 + step * 0.002, 34.68))
		}

		expect([...seen].toSorted((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, index) => index))
		expect(districtIndex(135.50001, 34.68001)).toBe(districtIndex(135.50002, 34.68002))
	})

	it("hashes cells west of the prime meridian and south of the equator", () => {
		for (const [longitude, latitude] of [
			[-73.984, 40.7549],
			[151.2093, -33.8688],
			[-58.3816, -34.6037],
		] as const) {
			const index = districtIndex(longitude, latitude)

			expect(index).toBeGreaterThanOrEqual(0)
			expect(index).toBeLessThan(16)
		}
	})
})

describe("cityFrame", () => {
	it("is orthonormal, with up along the origin's direction at the equator", () => {
		const frame = cityFrame(139.7671, 35.6812)

		expect(frame.east.dot(frame.north)).toBeCloseTo(0, 12)
		expect(frame.east.dot(frame.up)).toBeCloseTo(0, 12)
		expect(frame.north.dot(frame.up)).toBeCloseTo(0, 12)
		expect(new Vector3().crossVectors(frame.east, frame.north).dot(frame.up)).toBeCloseTo(1, 12)

		const equator = cityFrame(0, 0)

		expect(equator.origin.toArray()).toEqual([6_378_137, 0, 0])
		expect(equator.up.toArray()).toEqual([1, 0, 0])
	})
})

describe("styleCityModel", () => {
	it("records each building's base and height, its district color and every vertex in local meters", () => {
		const frame = cityFrame(139.7671, 35.6812)

		// Building 0 stands 10 m east of the center from the ground to 30 m.
		// Building 1 is one point above the center.
		const local = [
			[10, 0, 0],
			[10, 0, 30],
			[0, 0, 5],
		] as const

		const ecef = local.flatMap(([east, north, up]) =>
			frame.origin
				.clone()
				.addScaledVector(frame.east, east)
				.addScaledVector(frame.north, north)
				.addScaledVector(frame.up, up)
				.toArray()
		)

		const geometry = new BufferGeometry()

		// float64 positions keep the ECEF coordinates exact in the test.
		geometry.setAttribute("position", new BufferAttribute(new Float64Array(ecef), 3))
		geometry.setAttribute("_feature_id_0", new BufferAttribute(new Float32Array([0, 0, 1]), 1))
		const material = createCityModelMaterial()
		const mesh = new Mesh(geometry)
		const model = new Group().add(mesh)

		styleCityModel(model, frame, material)

		expect(mesh.material).toBe(material)

		// The added 0 turns a rounded -0 into 0. toEqual tells the two apart.
		expect([...geometry.getAttribute("a_local").array].map((value) => Math.round(value * 1000) / 1000 + 0)).toEqual([
			10, 0, 0, 10, 0, 30, 0, 0, 5,
		])

		expect([...geometry.getAttribute("a_building").array].map((value) => Math.round(value) + 0)).toEqual([
			0, 30, 0, 30, 5, 0,
		])

		const centerColor = byteRGB(GuideMapPalette.buildingDistricts[districtIndex(139.7671, 35.6812)]!)

		expect([...geometry.getAttribute("a_district").array].slice(6)).toEqual([...centerColor])
	})
})
