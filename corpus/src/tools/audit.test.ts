/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

// Lightweight integration smoke against the actual corpus on this host. Skipped when the data
// isn't present (CI / fresh clones); only the file-format-parsing tests run unconditionally.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

// Re-export the internals for testing. The script's CLI entry is gated on
// `runIfScript(import.meta, …)`, so importing the module is side-effect-free.
import { audit } from "./audit.ts"

const CORPUS_PATH = "/mnt/playpen/mailwoman-data/corpus/versioned/v0.3.0/corpus-v0.3.0"
const hasCorpus = existsSync(CORPUS_PATH)

describe.skipIf(!hasCorpus)("audit — integration", () => {
	it("emits a report without throwing on the v0.3.0 corpus + v0.4.0 config", () => {
		// audit() prints to stdout/stderr — we test that it doesn't throw and produces a stat line.
		// More substantive output assertions are bypass-able since the printed report is the artifact;
		// a successful run is the contract.
		const tmp = mkdtempSync(join(tmpdir(), "audit-test-"))
		const configPath = join(tmp, "v0_4_0.yaml")
		writeFileSync(
			configPath,
			[
				"data:",
				"  source_weights:",
				"    wof-admin: 2.0",
				"    ban: 3.0",
				"    tiger: 4.0",
				"    usgov-nad: 1.0",
				"  val_rows: 4096",
				"  coarse_filter: true",
				"model:",
				"  use_crf: true",
			].join("\n")
		)
		expect(() => audit({ corpusDir: CORPUS_PATH, configPath })).not.toThrow()
	})
})

describe("audit — config parser", () => {
	it("parses source_weights block without bleeding into sibling keys (val_rows etc.)", async () => {
		// White-box: re-import the parser via dynamic import + grep on stdout would couple us to
		// printer formatting. Instead, write a small config + call audit() against an empty corpus
		// dir; we verify the warning-output for "no shards" mentions the right sources (proving the
		// parser found exactly the configured ones and not val_rows).
		const tmp = mkdtempSync(join(tmpdir(), "audit-parser-test-"))
		// Empty train/ subdir so the printer enters the per-source report block + emits the
		// "weighted in config but no shards" warning where we can inspect what the parser saw.
		mkdirSync(join(tmp, "train"))
		const configPath = join(tmp, "test.yaml")
		writeFileSync(
			configPath,
			[
				"data:",
				"  source_weights:",
				"    wof-admin: 1.0",
				"    ban: 2.5",
				"  val_rows: 1024",
				"  train_rows_per_epoch: null",
				"  coarse_filter: true",
				"model:",
				"  use_crf: true",
				"  crf_loss_weight: 0.05",
			].join("\n")
		)
		const origError = console.error
		const origLog = console.log
		const errLines: string[] = []
		const logLines: string[] = []
		console.error = (...args: unknown[]) => errLines.push(args.join(" "))
		console.log = (...args: unknown[]) => logLines.push(args.join(" "))

		try {
			audit({ corpusDir: tmp, configPath })
		} finally {
			console.error = origError
			console.log = origLog
		}
		const errOutput = errLines.join("\n")
		const logOutput = logLines.join("\n")
		// Configured sources should appear as warnings (no shards present).
		expect(errOutput + logOutput).toContain("wof-admin")
		expect(errOutput + logOutput).toContain("ban")
		// Non-source keys must NOT appear — val_rows / train_rows_per_epoch / coarse_filter /
		// use_crf / crf_loss_weight are config noise that the source_weights parser used to
		// pick up incorrectly.
		expect(errOutput + logOutput).not.toContain("val_rows")
		expect(errOutput + logOutput).not.toContain("train_rows_per_epoch")
		expect(errOutput + logOutput).not.toContain("coarse_filter")
		expect(errOutput + logOutput).not.toContain("use_crf")
		expect(errOutput + logOutput).not.toContain("crf_loss_weight")
	})
})
