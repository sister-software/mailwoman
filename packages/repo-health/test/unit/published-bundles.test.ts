/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The published-bundles check over the live tree and over planted registries and snapshots: a registry figure
 *   edited away from the bucket's, a bundle the snapshot never measured, a size it could not read and a snapshot row
 *   the registry no longer names.
 */

import { collectRepoContext } from "@mailwoman/repo-health"
import {
	APPROX_BYTES_TOLERANCE,
	compareRegistryToSnapshot,
	publishedBundlesCheck,
} from "@mailwoman/repo-health/checks/published-bundles"
import type { DataBundle, PublishedBundlesSnapshot } from "mailwoman/data"
import { describe, expect, it } from "vitest"

const FILE = "packages/mailwoman/data/published-bundles.json"

function bundleWith(name: string, remotePath: string, approxBytes: number): DataBundle {
	return {
		name,
		description: `${name} fixture`,
		artifacts: [{ remotePath, localPath: `${name}/${name}.db`, md5Sidecar: false, approxBytes }],
		// `expression` is what `data pull --refuse` decides on.
		// The fixture includes a grant whose obligations are unrecorded, so a refusal
		// over this bundle would rest on an unresolved reading.
		rights: { publishers: [], expression: "LicenseRef-Undeclared-Input", terms: [], conditions: [], unresolved: [] },
	}
}

function snapshotWith(rows: Array<{ bundle: string; remotePath: string; contentLength: number | null }>) {
	const snapshot: PublishedBundlesSnapshot = {
		measuredAt: "2026-09-27T05:18:08Z",
		bucket: "https://public.mailwoman.ai/mailwoman/",
		bundles: rows.map((row) => ({
			bundle: row.bundle,
			rights: { database: { status: "unmeasured", reason: "fixture" }, components: [] },
			artifacts: [
				{
					remotePath: row.remotePath,
					size:
						row.contentLength === null
							? { status: "unmeasured", reason: "HEAD failed in the fixture" }
							: { status: "measured", contentLength: row.contentLength },
					manifest: { status: "unmeasured", reason: "fixture" },
				},
			],
		})),
	}

	return snapshot
}

describe("publishedBundlesCheck", () => {
	it("reports nothing on the current tree", async () => {
		const context = await collectRepoContext()

		expect(await publishedBundlesCheck.run(context)).toEqual([])
	})

	it("accepts a registry whose approxBytes equals the served content-length", () => {
		const bundles = { one: bundleWith("one", "one/1.db", 1000) }
		const snapshot = snapshotWith([{ bundle: "one", remotePath: "one/1.db", contentLength: 1000 }])

		expect(compareRegistryToSnapshot(bundles, snapshot, FILE)).toEqual([])
	})

	it("reports a registry approxBytes edited away from the served size", () => {
		const bundles = { one: bundleWith("one", "one/1.db", 1000 + APPROX_BYTES_TOLERANCE + 1) }
		const snapshot = snapshotWith([{ bundle: "one", remotePath: "one/1.db", contentLength: 1000 }])

		const diagnostics = compareRegistryToSnapshot(bundles, snapshot, FILE)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.severity).toBe("error")
		expect(diagnostics[0]?.file).toBe(FILE)
		expect(diagnostics[0]?.message).toMatch(/records approxBytes 1001 and the bucket served 1000 bytes/u)
	})

	it("reports a bundle in the registry that the snapshot never measured", () => {
		const bundles = {
			one: bundleWith("one", "one/1.db", 1000),
			two: bundleWith("two", "two/2.db", 2000),
		}

		const snapshot = snapshotWith([{ bundle: "one", remotePath: "one/1.db", contentLength: 1000 }])

		const messages = compareRegistryToSnapshot(bundles, snapshot, FILE).map((diagnostic) => diagnostic.message)

		expect(messages).toHaveLength(2)
		expect(messages[0]).toMatch(/bundle `two` is in BUNDLES and has no row in the snapshot/u)
		expect(messages[1]).toMatch(/`two\/2\.db` \(bundle `two`\) is in BUNDLES and has no row in the snapshot/u)
	})

	it("reports a size the snapshot could not read rather than passing it", () => {
		const bundles = { one: bundleWith("one", "one/1.db", 1000) }
		const snapshot = snapshotWith([{ bundle: "one", remotePath: "one/1.db", contentLength: null }])

		const diagnostics = compareRegistryToSnapshot(bundles, snapshot, FILE)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toMatch(/has an unmeasured size in the snapshot/u)
	})

	it("reports a snapshot row that no bundle names any more", () => {
		const bundles = { one: bundleWith("one", "one/1.db", 1000) }

		const snapshot = snapshotWith([
			{ bundle: "one", remotePath: "one/1.db", contentLength: 1000 },
			{ bundle: "gone", remotePath: "gone/0.db", contentLength: 5 },
		])

		const diagnostics = compareRegistryToSnapshot(bundles, snapshot, FILE)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toMatch(/`gone\/0\.db` is in the snapshot and no bundle in BUNDLES names it/u)
	})
})
