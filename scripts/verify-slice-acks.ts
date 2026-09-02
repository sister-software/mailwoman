/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pre-training gate: verifies that every slice in MANIFEST.json which has `lint_flags > 0` ALSO has
 *   `lint_acknowledged: true`. Exits non-zero if any flagged slice is unacknowledged, blocking the
 *   training run.
 *
 *   Pairs with ``mailwoman dev lint corpus-slice`` (which emits the flag count) and the MANIFEST schema
 *   extension introduced 2026-05-29 after the v0.6.2 "5th Avenue Theatre" incident. The enforcing
 *   model is "report + acknowledgment, not block":
 *
 *   - Linter flags suspicious patterns and writes the count to MANIFEST.
 *   - Curator reviews flags. For intentional adversarial training data, sets `lint_acknowledged: true`
 *       in the MANIFEST entry with a note explaining why.
 *   - For unintentional patterns (the 5th Avenue case), curator fixes the slice and re-runs the linter.
 *       The new flag count goes into MANIFEST; if zero, no ack needed.
 *
 *   This script enforces step 2. It does NOT run the linter itself — it consumes the linter's
 *   previously-recorded flag count from MANIFEST. Run the linter when a slice is built; run this
 *   verifier as a pre-training check.
 *
 *   MANIFEST entry extension:
 *
 *   ```json
 *   {
 *   	"split": "train",
 *   	"path": "/data/corpus/.../part-no-street-v063.parquet",
 *   	"format": "parquet",
 *   	"rows": 122011,
 *   	"bytes": 5027210,
 *   	"first_source_id": "synth-no-street-v063",
 *   	"last_source_id": "synth-no-street-v063",
 *   	"lint_flags": 24,
 *   	"lint_acknowledged": true,
 *   	"lint_ack_note": "Intentional adversarial venue training; digit+ordinal patterns removed."
 *   }
 * ```
 *
 *   Backward-compat: slices predating the linter have no `lint_flags` field — those are treated as
 *   flag_count=0 and pass. New slices SHOULD record their flag count even if zero (defensive
 *   against silent under-counting from a future linter rule addition).
 *
 *   Usage: node scripts/verify-slice-acks.ts\
 *   --manifest /tmp/MANIFEST.json
 *
 *   # Or run against the live Modal volume (downloads first):
 *
 *   Modal volume get mailwoman-training corpus/.../MANIFEST.json /tmp/MANIFEST.json node
 *   scripts/verify-slice-acks.ts --manifest /tmp/MANIFEST.json
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

interface SliceEntry {
	path: string
	split?: string
	first_source_id?: string
	lint_flags?: number
	lint_acknowledged?: boolean
	lint_ack_note?: string
}

interface Manifest {
	slices: SliceEntry[]
}

interface Args {
	manifestPath: string
	verbose: boolean
}

function parseArgs(): Args {
	const out: Partial<Args> = { verbose: false }

	// node:util parseArgs (strict:false = old scan parity: unknown flags tolerated)
	const { values } = parseArguments({
		options: { manifest: { type: "string" }, verbose: { type: "boolean", short: "v" } },
		strict: false,
		allowPositionals: true,
	})

	if (values["manifest"] != null) {
		out.manifestPath = values["manifest"] as string
	}

	if (values["verbose"] != null) {
		out.verbose = true
	}

	if (!out.manifestPath) {
		console.error("Usage: verify-slice-acks.ts --manifest <MANIFEST.json> [--verbose]")

		process.exit(2)
	}

	return out as Args
}

async function main(): Promise<void> {
	const args = parseArgs()
	const m = await readLocalJSONFile<Manifest>(args.manifestPath)
	const slices = m.slices ?? []

	const unacknowledged: SliceEntry[] = []
	const acknowledged: SliceEntry[] = []
	const clean: SliceEntry[] = []
	let untracked = 0

	// slices predating the linter (no lint_flags field)

	for (const s of slices) {
		const flags = s.lint_flags

		if (flags === undefined) {
			untracked++

			continue
		}

		if (flags === 0) {
			clean.push(s)

			continue
		}

		if (s.lint_acknowledged === true) {
			acknowledged.push(s)
		} else {
			unacknowledged.push(s)
		}
	}

	console.log(`# Slice acknowledgment verification`)
	console.log("")
	console.log(`- **Manifest:** \`${args.manifestPath}\``)
	console.log(`- **Total slices:** ${slices.length}`)
	console.log(`- **Untracked (pre-linter):** ${untracked}`)
	console.log(`- **Clean (lint_flags: 0):** ${clean.length}`)
	console.log(`- **Flagged + acknowledged:** ${acknowledged.length}`)
	console.log(`- **Flagged + UNACKNOWLEDGED:** ${unacknowledged.length}`)
	console.log("")

	if (args.verbose && acknowledged.length) {
		console.log(`## Acknowledged flagged slices (${acknowledged.length})`)
		console.log("")

		for (const s of acknowledged) {
			const note = s.lint_ack_note ? ` — _${s.lint_ack_note}_` : ""

			console.log(`- \`${s.path}\` (${s.lint_flags} flags)${note}`)
		}

		console.log("")
	}

	if (unacknowledged.length) {
		console.log(`## ❌ UNACKNOWLEDGED FLAGGED EXTRACTS (${unacknowledged.length})`)
		console.log("")
		console.log("These slices have lint flags but no `lint_acknowledged: true`. Training will be blocked. Either:")
		console.log("- Fix the slice so it no longer triggers flags, OR")
		console.log(
			"- Set `lint_acknowledged: true` in the MANIFEST entry with a `lint_ack_note` explaining why the flagged patterns are intentional."
		)
		console.log("")

		for (const s of unacknowledged) {
			console.log(`- \`${s.path}\` (${s.lint_flags} flag(s), source=${s.first_source_id ?? "?"})`)
		}

		console.log("")
		console.error(`VERIFY FAILED: ${unacknowledged.length} unacknowledged flagged slice(s).`)

		process.exit(1)
	}

	console.error("VERIFY PASSED.")
}

await main()
