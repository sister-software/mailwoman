/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pins for the shared dev-weights freshness implementation (#1734). The sidecar contract is the part worth pinning: a
 *   fresh sidecar is TRUSTED (that is the whole point — never re-hash a multi-gigabyte source per linker run), a stale
 *   or malformed one recomputes and rewrites, and the rewrite self-heals the cache.
 */

import { md5File } from "@mailwoman/core/utils"
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { md5FileWithSidecar } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"
import { afterEach, describe, expect, it } from "vitest"

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true })
	}
})

function scratchFile(content: string): string {
	const root = mkdtempSync(join(tmpdir(), "mw-md5-sidecar-"))

	roots.push(root)

	const path = join(root, "source.bin")

	writeFileSync(path, content)

	return path
}

describe("md5FileWithSidecar (#1734)", () => {
	it("computes, writes the sidecar, and returns the true md5 on first contact", async () => {
		const path = scratchFile("payload")

		const hash = await md5FileWithSidecar(path)

		expect(hash).toBe(await md5File(path))
		expect(readFileSync(`${path}.md5`, "utf8")).toBe(`${hash}  source.bin\n`)
	})

	it("TRUSTS a sidecar at least as new as the source — no re-hash", async () => {
		const path = scratchFile("payload")
		const fake = "deadbeefdeadbeefdeadbeefdeadbeef"

		writeFileSync(`${path}.md5`, `${fake}  source.bin\n`)

		expect(await md5FileWithSidecar(path)).toBe(fake)
	})

	it("recomputes and heals when the sidecar is older than the source", async () => {
		const path = scratchFile("payload")
		const fake = "deadbeefdeadbeefdeadbeefdeadbeef"

		writeFileSync(`${path}.md5`, `${fake}  source.bin\n`)
		// Sidecar mtime strictly before the source's — the state after a source swap that forgot the sidecar.
		utimesSync(`${path}.md5`, new Date(0), new Date(0))

		const hash = await md5FileWithSidecar(path)

		expect(hash).toBe(await md5File(path))
		expect(readFileSync(`${path}.md5`, "utf8")).toContain(hash)
	})

	it("recomputes past a malformed sidecar rather than returning garbage", async () => {
		const path = scratchFile("payload")

		writeFileSync(`${path}.md5`, "not-a-hash\n")

		expect(await md5FileWithSidecar(path)).toBe(await md5File(path))
	})
})
