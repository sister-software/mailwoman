/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

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

	// No weights exist for this locale under either root, so the session fails after it leased generation 1.
	const options = {
		dataRoot: scratch.path,
		locale: "zz-ZZ",
		weightsCacheRoot: weights.path.toString(),
	} as GeocodeSessionOptions

	await expect(createGeocodeSession(options)).rejects.toThrow(/geocode requires the neural weights/u)

	// Disposal starts the lease file's removal without awaiting it, so the test waits for the file to go.
	for (let attempt = 0; attempt < 50 && (await readLiveLeases(scratch.path)).length; attempt++) {
		await sleep(20)
	}

	expect(await readLiveLeases(scratch.path)).toEqual([])
})
