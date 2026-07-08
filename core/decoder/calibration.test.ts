/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readFileSync } from "node:fs"

import { repoRootPathBuilder } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import type { BIOLabel } from "../types/component.js"
import { buildAddressTree } from "./build-tree.js"
import { createCalibrator, type CalibrationTable } from "./calibration.js"
import type { AddressNode, DecoderToken } from "./types.js"

function tok(piece: string, start: number, end: number, label: BIOLabel, confidence = 1): DecoderToken {
	return { piece, start, end, label, confidence }
}

function findByTag(nodes: AddressNode[], tag: string): AddressNode | undefined {
	for (const n of nodes) {
		if (n.tag === tag) return n
		const c = findByTag(n.children, tag)

		if (c) return c
	}

	return undefined
}

// A tiny monotone table: low confidence maps down, high maps up.
const TABLE: CalibrationTable = {
	model: "test",
	model_version: "0",
	method: "test",
	bins: 4,
	table: [
		{ lo: 0.0, hi: 0.25, center: 0.125, calibrated: 0.1 },
		{ lo: 0.25, hi: 0.5, center: 0.375, calibrated: 0.2 },
		{ lo: 0.5, hi: 0.75, center: 0.625, calibrated: 0.6 },
		{ lo: 0.75, hi: 1.0, center: 0.875, calibrated: 0.95 },
	],
}

describe("createCalibrator", () => {
	test("clamps below the first center and above the last", () => {
		const cal = createCalibrator(TABLE)
		expect(cal(0)).toBeCloseTo(0.1, 6) // <= first center → first calibrated
		expect(cal(0.05)).toBeCloseTo(0.1, 6)
		expect(cal(1)).toBeCloseTo(0.95, 6) // >= last center → last calibrated
		expect(cal(0.99)).toBeCloseTo(0.95, 6)
	})

	test("linearly interpolates between bin centers", () => {
		const cal = createCalibrator(TABLE)
		// Midway between centers 0.625 and 0.875 → midway between 0.6 and 0.95.
		expect(cal(0.75)).toBeCloseTo(0.775, 6)
		// At a center it returns that center's calibrated value exactly.
		expect(cal(0.375)).toBeCloseTo(0.2, 6)
	})

	test("is monotone non-decreasing", () => {
		const cal = createCalibrator(TABLE)
		let prev = -Infinity

		for (let x = 0; x <= 1.0001; x += 0.02) {
			const y = cal(x)
			expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
			prev = y
		}
	})

	test("accepts a bare bin array and handles out-of-range/NaN input", () => {
		const cal = createCalibrator(TABLE.table)
		expect(cal(-5)).toBeCloseTo(0.1, 6)
		expect(cal(5)).toBeCloseTo(0.95, 6)
		expect(cal(Number.NaN)).toBeCloseTo(0.1, 6) // NaN clamps to 0 → first center
	})

	test("throws on an empty table", () => {
		expect(() => createCalibrator([])).toThrow(/empty/)
	})
})

describe("buildAddressTree calibrate hook", () => {
	const RAW = "Springfield"
	const tokens = (): DecoderToken[] => [tok("Springfield", 0, 11, "B-locality", 0.6)]

	test("default (no calibrator) preserves the raw mean confidence — byte-stable", () => {
		const tree = buildAddressTree(RAW, tokens())
		expect(findByTag(tree.roots, "locality")!.confidence).toBeCloseTo(0.6, 6)
	})

	test("a calibrator rewrites the stamped confidence", () => {
		const cal = createCalibrator(TABLE)
		const tree = buildAddressTree(RAW, tokens(), { calibrate: cal })
		// raw 0.6 sits between centers 0.375 (→0.2) and 0.625 (→0.6): t=(0.6-0.375)/0.25=0.9 → 0.2+0.9*0.4=0.56
		expect(findByTag(tree.roots, "locality")!.confidence).toBeCloseTo(0.56, 6)
	})
})

describe("shipped isotonic table sanity", () => {
	test("isotonic-en-us-v4.0.0.json is monotone and orders low<high confidence", () => {
		const path = String(repoRootPathBuilder("data", "eval", "calibration", "isotonic-en-us-v4.0.0.json"))
		let table: CalibrationTable

		try {
			table = JSON.parse(readFileSync(path, "utf8"))
		} catch {
			return // table not present in this checkout (e.g. shallow) — skip rather than fail
		}
		const cal = createCalibrator(table)
		expect(cal(0.5)).toBeLessThan(cal(0.99))
		let prev = -Infinity

		for (let x = 0; x <= 1.0001; x += 0.05) {
			const y = cal(x)
			expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
			prev = y
		}
	})
})
