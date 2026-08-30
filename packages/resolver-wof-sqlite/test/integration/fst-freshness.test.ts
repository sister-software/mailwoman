/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture-scale cover for the FST build stamp and the freshness check.
 *
 *   Everything here runs on a three-state FST and a 12-byte "source database", because the thing under
 *   test is a comparison, not a gazetteer. The one property that DOES need a real artifact — that the
 *   trailer can be read by seek without buffering 317 MB — is exercised structurally: the fixture
 *   writes a trailer at a non-zero offset and the reader is never handed the buffer.
 */

import { readLocalBuffer, readLocalTextFile, statPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { setTimestamps, writeLocalBuffer, writeLocalFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { createHash } from "@mailwoman/platform/crypto"
import {
	fstFreshnessWarning,
	fstStaleReason,
	md5FileSync,
	MIN_STAMPED_FORMAT_VERSION,
	peekFSTStampFields,
	readWOFSourceIdentity,
} from "@mailwoman/resolver-wof-sqlite/fst-freshness"
import { FSTMatcher } from "@mailwoman/resolver-wof-sqlite/fst-matcher"
import { FST_FORMAT_VERSION, serializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import type { FSTProvenance } from "@mailwoman/resolver-wof-sqlite/fst-types"
import { afterAll, describe, expect, it } from "vitest"

const TMP = await temporaryDirectory("fst-freshness-")

afterAll(() => TMP[Symbol.asyncDispose]())

/**
 * A two-token FST ("aa" → "bb") with one place, so the serialized artifact has a real string table, edge table and
 * place table between the header and the trailer — the trailer offset must be computed, not guessed.
 */
function fixtureMatcher(): FSTMatcher {
	return FSTMatcher.fromNodes([
		{ edges: new Map([["aa", 1]]), places: [] },
		{ edges: new Map([["bb", 2]]), places: [] },
		{
			edges: new Map(),
			places: [
				{
					wofID: 42,
					placetype: "locality",
					name: "Aa Bb",
					parentChain: [7],
					referential: 0.5,
					lat: 1,
					lon: 2,
				},
			],
		},
	])
}

async function writeFST(name: string, provenance?: FSTProvenance): Promise<string> {
	const path = TMP.resolve(name)
	await writeLocalFile(serializeFST(fixtureMatcher(), provenance), path)

	return path
}

function provenanceOf(overrides: Partial<FSTProvenance> = {}): FSTProvenance {
	return {
		builtAt: "2026-08-05T00:00:00.000Z",
		countries: ["US"],
		stateCount: 3,
		placeCount: 1,
		edgeCount: 2,
		nameInsertions: 1,
		importanceMatches: 0,
		...overrides,
	}
}

const SOURCE = TMP.resolve("source.db")
await writeLocalTextFile("source bytes", SOURCE)
const SOURCE_IDENTITY = { md5: md5FileSync(SOURCE), bytes: (await statPath(SOURCE)).size }

describe("md5FileSync", () => {
	it("matches the digest of the same bytes hashed in one pass", () => {
		expect(md5FileSync(SOURCE)).toBe(createHash("md5").update("source bytes").digest("hex"))
	})

	it("hashes a file LARGER than one read chunk identically", async () => {
		// The defect this catches lives in the input tail: every fixture-sized file fits one 8 MiB read,
		// so an off-by-one in the chunk loop is invisible until a real 5 GB source arrives. 20 MiB runs
		// the loop three times, with the last read short.
		const bytes = Buffer.alloc(20 * 1024 * 1024 + 7, 0xab)
		const big = TMP.resolve("big.bin")
		await writeLocalFile(bytes, big)

		expect(md5FileSync(big)).toBe(createHash("md5").update(bytes).digest("hex"))
	})
})

describe("readWOFSourceIdentity", () => {
	it("computes and caches the digest in an md5sum-format sidecar", async () => {
		const path = TMP.resolve("sidecar-source.db")
		await writeLocalTextFile("abc", path)
		const identity = readWOFSourceIdentity(path)

		expect(identity.md5).toBe(md5FileSync(path))
		expect(identity.bytes).toBe(3)
		// md5sum(1) format: "<hash>  <basename>".
		expect(await readLocalTextFile(`${path}.md5`)).toBe(`${identity.md5}  sidecar-source.db\n`)
	})

	it("recomputes when the sidecar is OLDER than the source", async () => {
		const path = TMP.resolve("stale-sidecar.db")
		await writeLocalTextFile("one", path)
		await writeLocalTextFile("00000000000000000000000000000000  stale-sidecar.db\n", `${path}.md5`)
		// Sidecar predates the source: the guard must not trust it.
		await setTimestamps(`${path}.md5`, new Date(1000), new Date(1000))

		expect(readWOFSourceIdentity(path).md5).toBe(md5FileSync(path))
	})

	it("trusts a sidecar at or after the source's mtime without reading the source", async () => {
		const path = TMP.resolve("trusted-sidecar.db")
		await writeLocalTextFile("two", path)
		const lie = "11111111111111111111111111111111"
		await writeLocalTextFile(`${lie}  trusted-sidecar.db\n`, `${path}.md5`)

		// The lie proves the sidecar was READ rather than the file re-hashed — the property that keeps
		// the guard cheap enough to leave switched on for a 5 GB source.
		expect(readWOFSourceIdentity(path).md5).toBe(lie)
	})
})

describe("peekFSTStampFields", () => {
	it("reads the format version and the provenance trailer", async () => {
		const path = await writeFST("stamped.bin", provenanceOf({ sourceDBMD5: "deadbeef", sourceDBBytes: 12 }))
		const fields = peekFSTStampFields(path)

		expect(fields?.formatVersion).toBe(FST_FORMAT_VERSION)
		expect(fields?.provenance?.sourceDBMD5).toBe("deadbeef")
		expect(fields?.provenance?.sourceDBBytes).toBe(12)
	})

	it("reports no provenance for an artifact serialized without one", async () => {
		const fields = peekFSTStampFields(await writeFST("unstamped.bin"))

		expect(fields?.formatVersion).toBe(FST_FORMAT_VERSION)
		expect(fields?.provenance).toBeUndefined()
	})

	it("returns undefined for a non-FST file, a stub, and an absent path", async () => {
		const notFST = TMP.resolve("not-an-fst.bin")
		await writeLocalBuffer(Buffer.alloc(64, 0x7f), notFST)
		expect(peekFSTStampFields(notFST)).toBeUndefined()

		const tooSmall = TMP.resolve("tiny.bin")
		await writeLocalBuffer(Buffer.from("FST\0"), tooSmall)
		expect(peekFSTStampFields(tooSmall)).toBeUndefined()

		expect(peekFSTStampFields(TMP.resolve("nope.bin"))).toBeUndefined()
	})

	it("survives a truncated trailer instead of throwing", async () => {
		const path = await writeFST("truncated.bin", provenanceOf({ sourceDBMD5: "deadbeef" }))
		const bytes = await readLocalBuffer(path)
		// Cut into the JSON: the declared length now runs past EOF.
		await writeLocalFile(bytes.subarray(0, -20), path)

		expect(peekFSTStampFields(path)?.provenance).toBeUndefined()
	})
})

describe("fstStaleReason", () => {
	const expected = { source: SOURCE_IDENTITY }

	it("passes an artifact stamped with the current source", async () => {
		const path = await writeFST(
			"current.bin",
			provenanceOf({ sourceDBMD5: SOURCE_IDENTITY.md5, sourceDBBytes: SOURCE_IDENTITY.bytes })
		)

		expect(fstStaleReason(peekFSTStampFields(path), expected)).toBeUndefined()
	})

	it("flags a source md5 that has moved, and names the build date", async () => {
		const path = await writeFST(
			"moved.bin",
			provenanceOf({ builtAt: "2026-07-26T21:10:37.566Z", sourceDBMD5: "aaaaaaaabbbbbbbbccccccccdddddddd" })
		)

		const reason = fstStaleReason(peekFSTStampFields(path), expected)

		expect(reason).toContain("source db aaaaaaaa")
		expect(reason).toContain(SOURCE_IDENTITY.md5.slice(0, 8))
		expect(reason).toContain("2026-07-26")
	})

	it("distinguishes 'no stamp at all' from 'stamp without a checksum'", async () => {
		// The meaning-of-zero rule, applied to the stamp: these are different states and the operator
		// does different things about them (rebuild vs. rebuild-to-stamp), so they must not share prose.
		expect(fstStaleReason(peekFSTStampFields(await writeFST("bare.bin")), expected)).toBe("carries no build stamp")

		const unchecksummed = await writeFST("no-md5.bin", provenanceOf({ sourceDB: "/some/where.db" }))
		expect(fstStaleReason(peekFSTStampFields(unchecksummed), expected)).toContain("no source checksum")
	})

	it("flags a format older than the tree writes even when the source matches", async () => {
		// The R5 lesson in format edition: a guard comparing only the source reads a format-obsolete
		// artifact as current.
		const path = await writeFST(
			"format-stale.bin",
			provenanceOf({ sourceDBMD5: SOURCE_IDENTITY.md5, sourceDBBytes: SOURCE_IDENTITY.bytes })
		)

		expect(fstStaleReason(peekFSTStampFields(path), { ...expected, formatVersion: FST_FORMAT_VERSION + 1 })).toBe(
			`format v${FST_FORMAT_VERSION} → v${FST_FORMAT_VERSION + 1}`
		)
	})

	it("flags a size disagreement at a matching md5", async () => {
		const path = await writeFST(
			"size-skew.bin",
			provenanceOf({ sourceDBMD5: SOURCE_IDENTITY.md5, sourceDBBytes: SOURCE_IDENTITY.bytes + 1 })
		)

		expect(fstStaleReason(peekFSTStampFields(path), expected)).toContain("misrecorded")
	})

	it("flags a changed exclusion policy only when the caller supplies one", async () => {
		const path = await writeFST(
			"policy.bin",
			provenanceOf({
				sourceDBMD5: SOURCE_IDENTITY.md5,
				sourceDBBytes: SOURCE_IDENTITY.bytes,
				exclusionPolicy: "v1.0",
			})
		)

		const fields = peekFSTStampFields(path)

		expect(fstStaleReason(fields, expected)).toBeUndefined()
		expect(fstStaleReason(fields, { ...expected, exclusionPolicy: "v1.1" })).toBe("exclusion policy v1.0 → v1.1")
	})

	it("reports an unreadable artifact rather than passing it", () => {
		expect(fstStaleReason(undefined, expected)).toBe("unreadable or not an FST artifact")
	})

	it("exposes the stamped-format floor it enforces", () => {
		expect(MIN_STAMPED_FORMAT_VERSION).toBeLessThanOrEqual(FST_FORMAT_VERSION)
	})
})

describe("fstFreshnessWarning", () => {
	it("names the artifact, the reason, and the rebuild command", async () => {
		const path = await writeFST("warn.bin", provenanceOf({ sourceDBMD5: "0".repeat(32) }))

		const warning = await fstFreshnessWarning({
			fstPath: path,
			sourceDBPath: SOURCE,
			rebuildCommand: "mailwoman gazetteer build fst --locales en-us",
		})

		expect(warning).toContain("FST STALE")
		expect(warning).toContain(path)
		expect(warning).toContain("mailwoman gazetteer build fst --locales en-us")
	})

	it("is silent for a current artifact", async () => {
		const path = await writeFST(
			"quiet.bin",
			provenanceOf({ sourceDBMD5: SOURCE_IDENTITY.md5, sourceDBBytes: SOURCE_IDENTITY.bytes })
		)

		expect(await fstFreshnessWarning({ fstPath: path, sourceDBPath: SOURCE, rebuildCommand: "x" })).toBeUndefined()
	})

	it("is silent when either side is absent — a missing file is a different report", async () => {
		expect(
			await fstFreshnessWarning({ fstPath: TMP.resolve("gone.bin"), sourceDBPath: SOURCE, rebuildCommand: "x" })
		).toBeUndefined()

		expect(
			await fstFreshnessWarning({
				fstPath: await writeFST("orphan.bin", provenanceOf()),
				sourceDBPath: TMP.resolve("gone.db"),
				rebuildCommand: "x",
			})
		).toBeUndefined()
	})
})
