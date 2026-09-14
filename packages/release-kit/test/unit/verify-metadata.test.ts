/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The release-metadata surfaces over a planted tree, and the constraint that keeps the status page published.
 *
 *   The defect this pins (#2259): the check verified that A FILE cites the shipped model, never that the file is
 *   the one the site publishes, so it read the archived August copy and passed for four releases while
 *   https://mailwoman.ai said release 8.6.0 and model 7.0.0. A target that can move out from under a check while
 *   still RESOLVING reports success from the wrong place.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { verifyReleaseMetadata } from "@mailwoman/release-kit/release/verify-metadata"
import { join, resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const MODEL = "9.1.0"

const statusPage = (version: string) =>
	[
		"---",
		"title: Status",
		"---",
		"",
		`:::info[Verified as of release ${version}]`,
		"",
		"What ships today.",
		"",
		":::",
		"",
	].join("\n")

/**
 * The version matrix, in the shape `checkReleases` reads: newest first, `(current)` on the first column, and the third
 * column carrying the model lineage.
 */
const releasesPage = (version: string) =>
	[
		"# Releases",
		"",
		"| Version | Date | Model lineage | Notes |",
		"| --- | --- | --- | --- |",
		`| **${version}** (current) | 2026-09-12 | model \`${version}\` | the one |`,
		"",
	].join("\n")

async function plant(options: { status: string; statusVersion?: string }) {
	const repoRoot = String(fixtures.use(await temporaryDirectory("verify-metadata-")).path)

	const files: Record<string, string> = {
		"packages/neural-weights-en-us/model-card.json": stringifyJSON({ version: MODEL }),
		"evals/scores-by-version.json": stringifyJSON({ schema_version: 1, runs: [{ model_version: MODEL }] }),
		"docs/records/site-2026-08/releases.mdx": releasesPage(MODEL),
		[options.status]: statusPage(options.statusVersion ?? MODEL),
	}

	for (const [file, text] of Object.entries(files)) {
		await makeDirectories(join(repoRoot, file.slice(0, file.lastIndexOf("/"))))
		await writeLocalTextFile(text, resolvePath(repoRoot, file))
	}

	return repoRoot
}

describe("verifyReleaseMetadata", () => {
	it("passes when the published status page cites the shipped model", async () => {
		const repoRoot = await plant({ status: "docs/articles/developers/status.mdx" })
		const report = await verifyReleaseMetadata({ repoRoot, log: () => {} })

		expect(report.modelVersion).toBe(MODEL)
		expect(report.surfaces.every((surface) => surface.ok)).toBe(true)
	})

	it("fails when the published status page cites a superseded release", async () => {
		const repoRoot = await plant({ status: "docs/articles/developers/status.mdx", statusVersion: "8.6.0" })

		await expect(verifyReleaseMetadata({ repoRoot, log: () => {} })).rejects.toThrow(
			/1 of 3 surfaces stale for model 9\.1\.0/u
		)
	})

	it("refuses a status page outside the tree the site publishes", async () => {
		const repoRoot = await plant({ status: "docs/records/site-2026-08/status.mdx" })

		// The archived copy cites the shipped model, so without the constraint this run would PASS — which is
		// exactly how the live page went four releases without being read.
		await expect(
			verifyReleaseMetadata({ repoRoot, status: "docs/records/site-2026-08/status.mdx", log: () => {} })
		).rejects.toThrow(/must be a page the site publishes/u)
	})
})
