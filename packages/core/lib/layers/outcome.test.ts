/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { consultsNextSource, LayerOutcome, UnreadableArtifactError, UnreadableReason } from "#layers"

describe("consultsNextSource", () => {
	it("moves on only from an absent layer", () => {
		expect(Object.values(LayerOutcome).filter(consultsNextSource)).toEqual([LayerOutcome.Absent])
	})
})

describe("UnreadableArtifactError", () => {
	it("names the artifact's path and the reason", () => {
		const error = new UnreadableArtifactError("/data/db/osm/x.db", UnreadableReason.Unsupported, "schema 9")

		expect(error.message).toBe("/data/db/osm/x.db is unreadable (unsupported): schema 9")
		expect(error.path).toBe("/data/db/osm/x.db")
	})
})
