// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { UnreadableArtifactError, UnreadableReason } from "#layers"

describe("UnreadableArtifactError", () => {
	it("names the artifact's path and the reason", () => {
		const error = new UnreadableArtifactError("/data/db/osm/x.db", UnreadableReason.Unsupported, "schema 9")

		expect(error.message).toBe("/data/db/osm/x.db is unreadable (unsupported): schema 9")
		expect(error.path).toBe("/data/db/osm/x.db")
	})
})
