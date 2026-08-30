/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pins for the shared dev-weights freshness implementation (#1734). The sidecar contract is the part worth pinning: a
 *   fresh sidecar is TRUSTED (that is the whole point — never re-hash a multi-gigabyte source per linker run), a stale
 *   or malformed one recomputes and rewrites, and the rewrite self-heals the cache.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, setTimestamps, writeLocalFile } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/utils"
import { join } from "@mailwoman/platform/path"
import { md5FileWithSidecar } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function scratchFile(content: string): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("mw-md5-sidecar-")).path

	const path = join(root, "source.bin")

	await writeLocalFile(content, path)

	return path
}

describe("md5FileWithSidecar (#1734)", () => {
	it("computes, writes the sidecar, and returns the true md5 on first contact", async () => {
		const path = await scratchFile("payload")

		const hash = await md5FileWithSidecar(path)

		expect(hash).toBe(await md5File(path))
		expect(await readLocalTextFile(`${path}.md5`)).toBe(`${hash}  source.bin\n`)
	})

	it("TRUSTS a sidecar at least as new as the source — no re-hash", async () => {
		const path = await scratchFile("payload")
		const fake = "deadbeefdeadbeefdeadbeefdeadbeef"

		await writeLocalTextFile(`${fake}  source.bin\n`, `${path}.md5`)

		expect(await md5FileWithSidecar(path)).toBe(fake)
	})

	it("recomputes and heals when the sidecar is older than the source", async () => {
		const path = await scratchFile("payload")
		const fake = "deadbeefdeadbeefdeadbeefdeadbeef"

		await writeLocalTextFile(`${fake}  source.bin\n`, `${path}.md5`)
		// Sidecar mtime strictly before the source's — the state after a source swap that forgot the sidecar.
		await setTimestamps(`${path}.md5`, new Date(0), new Date(0))

		const hash = await md5FileWithSidecar(path)

		expect(hash).toBe(await md5File(path))
		expect(await readLocalTextFile(`${path}.md5`)).toContain(hash)
	})

	it("recomputes past a malformed sidecar rather than returning garbage", async () => {
		const path = await scratchFile("payload")

		await writeLocalTextFile("not-a-hash\n", `${path}.md5`)

		expect(await md5FileWithSidecar(path)).toBe(await md5File(path))
	})
})
