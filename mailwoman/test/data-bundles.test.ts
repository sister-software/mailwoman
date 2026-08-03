/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the pure `mailwoman data` bundle logic (#task-6): bundle resolution against a
 *   `releases.json`-shaped manifest, the artifact filter, and the present/missing/stale download
 *   decision. No filesystem, no network — every fact is passed in.
 */

import { describe, expect, it } from "vitest"

import {
	artifactURL,
	BUNDLES,
	filterArtifacts,
	needsDownload,
	PUBLIC_BUCKET_BASE_URL,
	resolveBundleArtifacts,
	type BundleArtifact,
	type DataBundle,
} from "../data-bundles.ts"

describe("BUNDLES registry", () => {
	it("ships exactly the confirmed bundles — no invented timezone/nuts/un-locode entries", () => {
		expect(Object.keys(BUNDLES).toSorted()).toEqual(["candidate", "fr", "poi", "us"])
	})

	it("every artifact declares a positive approxBytes and a non-empty remote/local path", () => {
		for (const bundle of Object.values(BUNDLES)) {
			expect(bundle.artifacts.length).toBeGreaterThan(0)

			for (const artifact of bundle.artifacts) {
				expect(artifact.remotePath.length).toBeGreaterThan(0)
				expect(artifact.localPath.length).toBeGreaterThan(0)
				expect(artifact.approxBytes).toBeGreaterThan(0)
			}
		}
	})

	it("the us bundle carries one address-points + interpolation entry per state, keyed by family+slug", () => {
		const us = BUNDLES.us!
		const ca = us.artifacts.filter((a) => a.stateSlug === "ca")

		expect(ca).toHaveLength(2)
		expect(ca.map((a) => a.family).toSorted()).toEqual(["address-points", "interpolation"])
	})

	it("vi (US Virgin Islands) ships situs only — no interpolation shard hosted for the territory", () => {
		const us = BUNDLES.us!
		const vi = us.artifacts.filter((a) => a.stateSlug === "vi")

		expect(vi).toHaveLength(1)
		expect(vi[0]!.family).toBe("address-points")
	})

	it("candidate/poi/fr are single fixed-path artifacts with no family tag", () => {
		for (const name of ["candidate", "poi", "fr"] as const) {
			const bundle = BUNDLES[name]!

			expect(bundle.artifacts).toHaveLength(1)
			expect(bundle.artifacts[0]!.family).toBeUndefined()
		}
	})
})

describe("artifactURL", () => {
	it("prefixes the public bucket base URL", () => {
		const artifact: BundleArtifact = {
			remotePath: "gazetteer/2026-07-07a/candidate.db",
			localPath: "wof/candidate.db",
			md5Sidecar: false,
			approxBytes: 100,
		}

		expect(artifactURL(artifact)).toBe(`${PUBLIC_BUCKET_BASE_URL}gazetteer/2026-07-07a/candidate.db`)
	})
})

describe("resolveBundleArtifacts — maps versioned names", () => {
	const bundle: DataBundle = {
		name: "us",
		description: "test",
		artifacts: [
			{
				remotePath: "street/us/ca/situs.db",
				localPath: "address-points/address-points-us-ca.db",
				md5Sidecar: false,
				approxBytes: 3_471_339_520,
				family: "address-points",
				stateSlug: "ca",
			},
			{
				remotePath: "street/us/ca/interp.db",
				localPath: "interpolation/interpolation-us-ca.db",
				md5Sidecar: false,
				approxBytes: 779_272_192,
				family: "interpolation",
				stateSlug: "ca",
			},
		],
	}

	it("passes family artifacts through unchanged with no manifest", () => {
		const resolved = resolveBundleArtifacts(bundle, null)

		expect(resolved[0]!.localPath).toBe("address-points/address-points-us-ca.db")
		expect(resolved[1]!.localPath).toBe("interpolation/interpolation-us-ca.db")
	})

	it("substitutes the manifest-pinned version into the localPath for a matching family", () => {
		const resolved = resolveBundleArtifacts(bundle, { "address-points": "2026-08-01" })

		expect(resolved[0]!.localPath).toBe("address-points/address-points-us-ca-2026-08-01.db")
		// interpolation has no manifest entry — stays at the legacy path.
		expect(resolved[1]!.localPath).toBe("interpolation/interpolation-us-ca.db")
	})

	it("passes non-family artifacts (candidate/poi/fr) through unchanged regardless of manifest", () => {
		const candidate: DataBundle = {
			name: "candidate",
			description: "test",
			artifacts: [
				{
					remotePath: "gazetteer/2026-07-07a/candidate.db",
					localPath: "wof/candidate.db",
					md5Sidecar: false,
					approxBytes: 1,
				},
			],
		}

		const resolved = resolveBundleArtifacts(candidate, { candidate: "2099-01-01" })

		expect(resolved[0]!.localPath).toBe("wof/candidate.db")
	})

	it("does not mutate the input bundle's artifacts", () => {
		const before = JSON.stringify(bundle)

		resolveBundleArtifacts(bundle, { "address-points": "2026-08-01" })

		expect(JSON.stringify(bundle)).toBe(before)
	})
})

describe("filterArtifacts — the --only substring filter", () => {
	const artifacts: BundleArtifact[] = [
		{
			remotePath: "street/us/nh/situs.db",
			localPath: "address-points/address-points-us-nh.db",
			md5Sidecar: false,
			approxBytes: 20_480,
			family: "address-points",
			stateSlug: "nh",
		},
		{
			remotePath: "street/us/ca/situs.db",
			localPath: "address-points/address-points-us-ca.db",
			md5Sidecar: false,
			approxBytes: 3_471_339_520,
			family: "address-points",
			stateSlug: "ca",
		},
	]

	it("returns everything when only is undefined or empty", () => {
		expect(filterArtifacts(artifacts, undefined)).toHaveLength(2)
		expect(filterArtifacts(artifacts, "")).toHaveLength(2)
	})

	it("matches by state slug, case-insensitively", () => {
		const filtered = filterArtifacts(artifacts, "NH")

		expect(filtered).toHaveLength(1)
		expect(filtered[0]!.stateSlug).toBe("nh")
	})

	it("matches by a substring of the local or remote path", () => {
		expect(filterArtifacts(artifacts, "ca.db")).toHaveLength(1)
		expect(filterArtifacts(artifacts, "street/us")).toHaveLength(2)
	})

	it("returns nothing when nothing matches", () => {
		expect(filterArtifacts(artifacts, "tx")).toHaveLength(0)
	})
})

describe("needsDownload — the present/missing/stale decision", () => {
	it("absent locally → yes", () => {
		expect(needsDownload({ exists: false }, { contentLength: 100 })).toBe(true)
	})

	it("present, md5 matches → no", () => {
		expect(needsDownload({ exists: true, md5: "abc123" }, { md5: "abc123" })).toBe(false)
	})

	it("present, md5 mismatch → yes", () => {
		expect(needsDownload({ exists: true, md5: "abc123" }, { md5: "def456" })).toBe(true)
	})

	it("md5 is checked before content-length when both are present", () => {
		// Same size, different md5 — a same-size corruption/edit must still be caught.
		expect(needsDownload({ exists: true, sizeBytes: 100, md5: "abc123" }, { contentLength: 100, md5: "def456" })).toBe(
			true
		)
	})

	it("no md5 on either side, content-length matches → no", () => {
		expect(needsDownload({ exists: true, sizeBytes: 100 }, { contentLength: 100 })).toBe(false)
	})

	it("no md5 on either side, content-length mismatch → yes", () => {
		expect(needsDownload({ exists: true, sizeBytes: 99 }, { contentLength: 100 })).toBe(true)
	})

	it("no verifiable signal at all → not forced (caller surfaces a warning instead)", () => {
		expect(needsDownload({ exists: true }, {})).toBe(false)
	})
})
