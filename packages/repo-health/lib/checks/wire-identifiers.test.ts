/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the wire-identifiers check over a planted config and over the current tree.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { PathBuilder } from "path-ts"
import { afterAll, describe, expect, test } from "vitest"

import { configSourceNames, wireIdentifiersCheck } from "#checks/wire-identifiers"
import { collectRepoContext } from "#index"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const CONFIG = `data:
  corpus_dir: /data/corpus/versioned/v0.6.0-register-surface/corpus-v0.6.0-register-surface
  source_weights:
    ban: 3.0
    synth-german: 6.0
    # A decline, which is still a key.
    synth-unit: 0.0 # Replaced by synth-unit-v30.
    state-ia-builders: 2.0
  source_reps:
    synth-sg-register: 1.0
    osm: 0.5
  required_corpus_receipts:
    - name: sg-registers
      min_draws: 1000
      source: synth-sg-register
      country: SG
    - name: renamed-by-a-sweep
      min_draws: 1
      source: rendered-interfaces
  augment_exclude_sources:
    - synth-suffix-boundary
    - synth-bare-postcode
train:
  max_steps: 60000
`

describe("configSourceNames", () => {
	test("reads the four fields and nothing else", () => {
		const names = configSourceNames(CONFIG)

		expect(names.map((entry) => `${entry.field}:${entry.name}`)).toEqual([
			"source_weights:ban",
			"source_weights:synth-german",
			"source_weights:synth-unit",
			"source_weights:state-ia-builders",
			"source_reps:synth-sg-register",
			"source_reps:osm",
			"required_corpus_receipts:synth-sg-register",
			"required_corpus_receipts:rendered-interfaces",
			"augment_exclude_sources:synth-suffix-boundary",
			"augment_exclude_sources:synth-bare-postcode",
		])

		expect(names.find((entry) => entry.name === "state-ia-builders")?.line).toBe(8)
	})
})

describe("the wire-identifiers check", () => {
	test("reports the swept adapter id and the invented receipt source, and passes both spellings of a recipe source", async () => {
		const root = PathBuilder.from(fixtures.use(await temporaryDirectory("wire-identifiers-")).path)
		const config = "corpus-python/src/mailwoman_train/configs/planted.yaml"

		await writeLocalTextFile(CONFIG, root(config))

		await writeLocalTextFile(
			'export const OSM_ADAPTER_ID = "osm"\nexport const BAN_ADAPTER_ID = "ban"\n',
			root("packages/corpus/lib/planted/adapter.ts")
		)

		const diagnostics = await wireIdentifiersCheck.run({
			repoRoot: root.toString(),
			trackedFiles: [config, "packages/corpus/lib/planted/adapter.ts"],
		})

		expect(diagnostics.map((diagnostic) => [diagnostic.file, diagnostic.line])).toEqual([
			[config, 8],
			[config, 19],
		])

		expect(diagnostics[0]!.message).toContain("`state-ia-builders` in `source_weights`")
		expect(diagnostics[1]!.message).toContain("`rendered-interfaces` in `required_corpus_receipts`")
	})

	test("reports nothing on the current tree", async () => {
		const context = await collectRepoContext()

		expect(await wireIdentifiersCheck.run(context)).toEqual([])
	})
})
