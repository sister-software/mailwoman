/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { TRAINER_DATA_FILES, trainerSourceFiles } from "#tools/training/launch/image"

describe("trainerSourceFiles", () => {
	it("lists the crates' sources and manifests, and leaves their tests, benches, examples and Markdown out", async () => {
		const files = await trainerSourceFiles()

		expect(files).toContain("Cargo.lock")
		expect(files).toContain("packages/trainer/crates/trainer-cli/src/main.rs")
		expect(files).toContain("packages/mtf/crates/mtf-sampler/Cargo.toml")
		expect(files).toEqual(expect.arrayContaining([...TRAINER_DATA_FILES]))

		// A change to any of these keeps the published image, because the release build reads none of them.
		expect(files.filter((path) => /\/crates\/[^/]+\/(?:tests|benches|examples)\//u.test(path))).toEqual([])
		expect(files.filter((path) => path.endsWith(".md") || /\.test\.tsx?$/u.test(path))).toEqual([])
	})
})
