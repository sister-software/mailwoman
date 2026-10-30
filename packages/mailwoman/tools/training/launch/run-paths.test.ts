/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { checkClearable, rerootConfigText, resolveRunPaths } from "#tools/training/launch/run-paths"

describe("the launch run paths", () => {
	it("keeps an output directory under the mount and follows {output_dir} in the log path", () => {
		expect(resolveRunPaths("/data/output-v8-s42/checkpoints", "{output_dir}/../train_log.csv", "/data")).toEqual({
			outputDir: "/data/output-v8-s42/checkpoints",
			csvLogPath: "/data/output-v8-s42/checkpoints/../train_log.csv",
			runBase: "/data/output-v8-s42",
		})

		expect(resolveRunPaths("./out", "train_log.csv", "/data")).toMatchObject({
			outputDir: "/data/output/checkpoints",
			csvLogPath: "/data/output/train_log.csv",
		})
	})

	it("refuses to clear the mount, a shared root, or a path outside the mount", () => {
		expect(() => checkClearable("/data", "/data")).toThrow(/not inside/)
		expect(() => checkClearable("/data/corpus/versioned/v0.8.7", "/data")).toThrow(/shared assets/)
		expect(() => checkClearable("/elsewhere/run", "/data")).toThrow(/not inside/)
		expect(() => checkClearable("/data/output-v8-s42/checkpoints", "/data")).not.toThrow()
		expect(() => checkClearable("/data/models/checkpoints/v7", "/data")).not.toThrow()
	})

	it("re-roots a config's volume paths at the host mirror", () => {
		expect(rerootConfigText("corpus_dir: /data/corpus\noutput_dir: /data/out\n", "/data", "/mnt/mw")).toBe(
			"corpus_dir: /mnt/mw/corpus\noutput_dir: /mnt/mw/out\n"
		)
	})
})
