/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { relativeImportSpecifiers, stageMapLibreWorker } from "@mailwoman/docs/plugins/demo-assets/artifacts"
import { MAPLIBRE_WORKER_URL } from "@mailwoman/docs/shared/maplibre-worker-url"
import { basename } from "path-ts"
import { describe, expect, test } from "vitest"

describe("demo-assets MapLibre worker staging", () => {
	test("reads the relative imports a worker module depends on", () => {
		const source = `import{a as b}from"./maplibre-gl-shared.mjs";import "./other.mjs";import x from "maplibre-gl";`

		expect(relativeImportSpecifiers(source)).toEqual(["./maplibre-gl-shared.mjs", "./other.mjs"])
	})

	test("stages the worker the demo names, with every module it imports beside it", async () => {
		await using scratch = await temporaryDirectory("maplibre-worker-")
		const staged = await stageMapLibreWorker(String(scratch.path))

		expect(staged, "the worker the client points MapLibre at must be staged").toContain(basename(MAPLIBRE_WORKER_URL))

		for (const file of staged) {
			const stagedPath = scratch.resolve(file)

			expect(await pathExists(stagedPath), `${file} was reported staged but is absent`).toBe(true)

			for (const specifier of relativeImportSpecifiers(await readLocalTextFile(stagedPath))) {
				expect(staged, `${file} imports ${specifier}, which is not staged beside it`).toContain(basename(specifier))
			}
		}
	})
})
