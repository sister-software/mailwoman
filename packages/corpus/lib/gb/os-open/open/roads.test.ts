/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { MarkupElement } from "@mailwoman/core/html/elements"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { createOpenRoadsReadStats, readOpenRoadsLink, readOpenRoadsLinks } from "#gb/os-open/open/roads"

const fixtureGML = workspacePath("corpus", "fixtures", "gb-os-open", "open-roads", "data", "OSOpenRoads_SE.gml")

describe("readOpenRoadsLinks", () => {
	it("yields the named links with their TOID and centreline, and counts the rest", async () => {
		const stats = createOpenRoadsReadStats()
		const links = await Array.fromAsync(readOpenRoadsLinks(fixtureGML, stats))

		expect(links.map((link) => [link.name1, link.roadNameTOID])).toEqual([
			["Park Row", "osgb4000000000000001"],
			["Woodhouse Lane", "osgb4000000000000002"],
			["Church Lane", "osgb4000000000000003"],
			["Kenneth Street", "osgb4000000000000004"],
		])

		expect([...links[0]!.vertices]).toEqual([428_900, 433_010, 429_000, 433_010, 429_100, 433_010])
		// One link is unnamed.
		// The A61 link has a road number but no name.
		expect(stats).toEqual({ links: 6, named: 4, unnamed: 2, malformedGeometry: 0 })
	})
})

describe("readOpenRoadsLink", () => {
	const element = (posList: string, srsDimension = "2"): MarkupElement => ({
		name: "road:RoadLink",
		attributes: { "gml:id": "idX" },
		text: "",
		children: [
			{
				name: "net:centrelineGeometry",
				attributes: {},
				text: "",
				children: [
					{
						name: "gml:LineString",
						attributes: { srsDimension },
						text: "",
						children: [{ name: "gml:posList", attributes: {}, text: posList, children: [] }],
					},
				],
			},
			{ name: "road:name1", attributes: {}, text: "High Street", children: [] },
			{ name: "road:roadNameTOID", attributes: { "xlink:href": "#osgb1" }, text: "", children: [] },
		],
	})

	it("reads the first two ordinates of a three-dimensional line", () => {
		const link = readOpenRoadsLink(element("1 2 9 3 4 9", "3"))

		expect(link).not.toBeTypeOf("string")
		expect([...(link as { vertices: Float64Array }).vertices]).toEqual([1, 2, 3, 4])
	})

	it("reports a line of one vertex as malformed rather than yielding it", () => {
		expect(readOpenRoadsLink(element("1 2"))).toBe("malformed-geometry")
		expect(readOpenRoadsLink(element("1 2 x 4"))).toBe("malformed-geometry")
	})
})
