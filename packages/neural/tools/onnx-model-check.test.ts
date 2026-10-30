/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { spawnProcessSync } from "@mailwoman/core/process"
import { expect, test } from "vitest"

const SCRIPT = new URL("./onnx-model-check.run.ts", import.meta.url).pathname

test("a feeds file with no probe fails rather than passing a check over nothing", async () => {
	await using scratch = await temporaryDirectory("onnx-model-check-")
	const feeds = scratch.path("feeds.json").toString()

	await writeLocalJSONFile({ checkpoint: "none", probes: [] }, feeds)

	const child = spawnProcessSync(process.execPath, [SCRIPT, "--model", scratch.path("absent.onnx"), "--feeds", feeds])

	expect(child.status).not.toBe(0)
	expect(child.stderr).toContain("holds no probe")
})
