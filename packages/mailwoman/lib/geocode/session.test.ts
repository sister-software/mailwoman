// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { setTimeout as sleep } from "node:timers/promises"

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { ServingRole } from "@mailwoman/core/layers"
import { expect, test } from "vitest"

import { replaceActiveSelection } from "#data/catalog"
import { readLiveLeases } from "#data/retention"
import { createGeocodeSession, type GeocodeSessionOptions } from "#geocode/session"
import { installFixtureArtifact } from "#test-kit/fixture-registry"

test("a session that fails to start releases the lease it took on the active generation", async () => {
	await using scratch = await temporaryDirectory("mw-session-lease-")
	await using weights = await temporaryDirectory("mw-session-weights-")

	const candidate = await installFixtureArtifact(scratch.path, ServingRole.Candidate, "candidate.db", "bytes")

	await replaceActiveSelection(scratch.path, { basedOn: null, set: [candidate.entry] })

	// The session leases generation 1 and then starts its services together.
	// Two of them fail: no weights exist for this locale under either root,
	// and the fixture candidate database holds no SQLite header.
	// The first failure to settle rejects the session, so either message proves a failure after the lease.
	const options = {
		dataRoot: scratch.path,
		locale: "zz-ZZ",
		weightsCacheRoot: weights.path.toString(),
	} as GeocodeSessionOptions

	await expect(createGeocodeSession(options)).rejects.toThrow(
		/geocode requires the neural weights|file is not a database/u
	)

	// Disposal starts the lease file's removal without awaiting it, so the test waits for the file to go.
	for (let attempt = 0; attempt < 50 && (await readLiveLeases(scratch.path)).length; attempt++) {
		await sleep(20)
	}

	await expect(readLiveLeases(scratch.path)).resolves.toEqual([])
})
