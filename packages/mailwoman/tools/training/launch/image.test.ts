// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import {
	TRAINER_BUILD_INPUTS,
	TRAINER_DATA_FILES,
	trainerBuildScript,
	trainerImageName,
	TrainerLicense,
	trainerSourceFiles,
} from "#tools/training/launch/image"

describe("the commercial trainer image", () => {
	it("builds the commercial feature under its own name, and the open-source image without it", () => {
		expect(trainerBuildScript("cu130", TrainerLicense.Commercial)).toContain("-p trainer-cli --features commercial")
		expect(trainerBuildScript("cu130", TrainerLicense.OpenSource)).not.toContain("commercial")

		expect(trainerImageName("cu130", "1.99.1", "0".repeat(64), TrainerLicense.Commercial)).toBe(
			"mailwoman-trainer-commercial-cu130-1.99.1-0000000000000000"
		)

		expect(trainerImageName("cu130", "1.99.1", "0".repeat(64), TrainerLicense.OpenSource)).toBe(
			"mailwoman-trainer-cu130-1.99.1-0000000000000000"
		)
	})

	it("ships the trust register the product-license crate embeds and the crate's sources", async () => {
		const files = await trainerSourceFiles()

		expect(files).toEqual(expect.arrayContaining([...TRAINER_BUILD_INPUTS]))
		expect(files).toContain("packages/license/crates/product-license/src/token.rs")
	})
})

describe("trainerSourceFiles", () => {
	it("lists the crates' sources and manifests, and leaves their tests, benches, examples and Markdown out", async () => {
		const files = await trainerSourceFiles()

		expect(files).toContain("Cargo.lock")
		expect(files).toContain("packages/trainer/crates/trainer-cli/src/main.rs")
		expect(files).toContain("packages/mtf/crates/mtf-sampler/Cargo.toml")

		// Cargo loads every member the root manifest declares, so a crate the trainer never builds still ships.
		expect(files.filter((path) => /^packages\/[^/]+\/crates\/[^/]+\/Cargo\.toml$/u.test(path)).length).toBeGreaterThan(
			files.filter((path) => /^packages\/(?:mtf|trainer)\/crates\/[^/]+\/Cargo\.toml$/u.test(path)).length
		)

		expect(files).toEqual(expect.arrayContaining([...TRAINER_DATA_FILES]))

		// A change to any of these keeps the published image, because the release build reads none of them.
		expect(files.filter((path) => /\/crates\/[^/]+\/(?:tests|benches|examples)\//u.test(path))).toEqual([])
		expect(files.filter((path) => path.endsWith(".md") || /\.test\.tsx?$/u.test(path))).toEqual([])
	})
})
