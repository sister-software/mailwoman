/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Loader tests for the sealed street-morphology FST artifact (`fst-street-morphology.bin`):
 *
 *   - Artifact round-trip: build → serialize → load via the loader → identical matches to the
 *     in-process build on street-type probes ("rue", "avenue", "straße")
 *   - Provenance rides the trailer through the loader
 *   - Web-deserializer parity: `deserializeFSTWeb` over the same artifact bytes matches
 *   - Degrade path: a missing or unreadable explicit artifact falls back to the dictionary build
 *     (warning, never a throw)
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resourceDictionaryPath } from "@mailwoman/core/utils"
import { afterAll, describe, expect, it } from "vitest"

import { deserializeFSTWeb } from "./fst-deserialize-web.ts"
import { serializeFST } from "./fst-serialize.ts"
import type { PlaceEntry } from "./fst-types.ts"
import { buildStreetMorphologyFST } from "./street-morphology-fst-builder.ts"
import { loadStreetMorphologyFST } from "./street-morphology-fst-loader.ts"

const DICTIONARIES_DIR = resourceDictionaryPath("libpostal")

/**
 * Street-type probes across the served languages: fr, en, de.
 */
const PROBES = ["rue", "avenue", "straße"] as const

/**
 * Project the identity triple so comparisons ignore object identity.
 */
const keyOf = (entries: PlaceEntry[]) => entries.map((e) => [e.wofID, e.placetype, e.name])

const tempDir = mkdtempSync(join(tmpdir(), "morphology-fst-loader-"))
const artifactPath = join(tempDir, "fst-street-morphology.bin")
const built = buildStreetMorphologyFST({ dictionariesDir: DICTIONARIES_DIR })

writeFileSync(artifactPath, serializeFST(built.matcher, built.provenance))
// The sealed posture `mailwoman gazetteer build street-morphology` leaves.
chmodSync(artifactPath, 0o444)

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true })
})

describe("loadStreetMorphologyFST", () => {
	it("loads the sealed artifact and matches the in-process build on street-type probes", () => {
		const loaded = loadStreetMorphologyFST({ artifactPath })

		expect(loaded.source).toBe("artifact")
		expect(loaded.path).toBe(artifactPath)

		for (const probe of PROBES) {
			const fromArtifact = loaded.matcher.query(probe).accepting
			const fromBuild = built.matcher.query(probe).accepting

			expect(fromArtifact.length).toBeGreaterThan(0)
			expect(fromArtifact.every((e) => e.placetype === "street_affix")).toBe(true)
			expect(keyOf(fromArtifact)).toEqual(keyOf(fromBuild))
		}
	})

	it("carries the build provenance through the artifact trailer", () => {
		const loaded = loadStreetMorphologyFST({ artifactPath })

		expect(loaded.provenance?.placeCount).toBe(built.provenance.placeCount)
		expect(loaded.provenance?.nameInsertions).toBe(built.provenance.nameInsertions)
		expect(loaded.provenance?.countries).toEqual(built.provenance.countries)
	})

	it("web-deserializer parity: deserializeFSTWeb over the artifact bytes matches the node matchers", () => {
		const bytes = readFileSync(artifactPath)
		const web = deserializeFSTWeb(new Uint8Array(bytes))

		for (const probe of PROBES) {
			expect(keyOf(web.query(probe).accepting)).toEqual(keyOf(built.matcher.query(probe).accepting))
		}
	})

	it("falls back to the dictionary build when the explicit artifact is missing", () => {
		const loaded = loadStreetMorphologyFST({
			artifactPath: join(tempDir, "does-not-exist.bin"),
			dictionariesDir: DICTIONARIES_DIR,
		})

		expect(loaded.source).toBe("built")
		expect(loaded.path).toBeUndefined()
		expect(loaded.matcher.query("avenue").accepting.length).toBeGreaterThan(0)
	})

	it("falls back with a warning when the explicit artifact is unreadable — never a throw", () => {
		const corruptPath = join(tempDir, "corrupt.bin")

		writeFileSync(corruptPath, Buffer.from("not an FST artifact"))
		const warnings: string[] = []

		const loaded = loadStreetMorphologyFST({
			artifactPath: corruptPath,
			dictionariesDir: DICTIONARIES_DIR,
			onWarn: (message) => warnings.push(message),
		})

		expect(loaded.source).toBe("built")
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain(corruptPath)
		expect(loaded.matcher.query("rue").accepting.length).toBeGreaterThan(0)
	})
})
