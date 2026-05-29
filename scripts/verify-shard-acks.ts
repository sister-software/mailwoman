/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pre-training gate: verifies that every shard in MANIFEST.json which has `lint_flags > 0` ALSO has
 *   `lint_acknowledged: true`. Exits non-zero if any flagged shard is unacknowledged, blocking the
 *   training run.
 *
 *   Pairs with `scripts/lint-corpus-shard.ts` (which emits the flag count) and the MANIFEST schema
 *   extension introduced 2026-05-29 after the v0.6.2 "5th Avenue Theatre" incident. The gating
 *   model is "report + acknowledgment, not block":
 *
 *   - Linter flags suspicious patterns and writes the count to MANIFEST.
 *   - Curator reviews flags. For intentional adversarial training data, sets `lint_acknowledged: true`
 *       in the MANIFEST entry with a note explaining why.
 *   - For unintentional patterns (the 5th Avenue case), curator fixes the shard and re-runs the linter.
 *       The new flag count goes into MANIFEST; if zero, no ack needed.
 *
 *   This script enforces step 2. It does NOT run the linter itself — it consumes the linter's
 *   previously-recorded flag count from MANIFEST. Run the linter when a shard is built; run this
 *   verifier as a pre-training check.
 *
 *   MANIFEST entry extension:
 *
 *   ```json
 *   {
 *     "split": "train",
 *     "path": "/data/corpus/.../part-no-street-v063.parquet",
 *     "format": "parquet",
 *     "rows": 122011,
 *     "bytes": 5027210,
 *     "first_source_id": "synth-no-street-v063",
 *     "last_source_id": "synth-no-street-v063",
 *     "lint_flags": 24,
 *     "lint_acknowledged": true,
 *     "lint_ack_note": "Intentional adversarial venue training; digit+ordinal patterns removed."
 *   }
 * ```
 *
 *   Backward-compat: shards predating the linter have no `lint_flags` field — those are treated as
 *   flag_count=0 and pass. New shards SHOULD record their flag count even if zero (defensive
 *   against silent under-counting from a future linter rule addition).
 *
 *   Usage: node --experimental-strip-types scripts/verify-shard-acks.ts\
 *   --manifest /tmp/MANIFEST.json
 *
 *   # Or run against the live Modal volume (downloads first):
 *
 *   Modal volume get mailwoman-training corpus/.../MANIFEST.json /tmp/MANIFEST.json node
 *   --experimental-strip-types scripts/verify-shard-acks.ts --manifest /tmp/MANIFEST.json
 */

import { readFileSync } from "node:fs"

interface ShardEntry {
	path: string
	split?: string
	first_source_id?: string
	lint_flags?: number
	lint_acknowledged?: boolean
	lint_ack_note?: string
}

interface Manifest {
	shards: ShardEntry[]
}

interface Args {
	manifestPath: string
	verbose: boolean
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	const out: Partial<Args> = { verbose: false }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--manifest" && args[i + 1]) out.manifestPath = args[++i]
		else if (a === "--verbose" || a === "-v") out.verbose = true
	}
	if (!out.manifestPath) {
		console.error("Usage: verify-shard-acks.ts --manifest <MANIFEST.json> [--verbose]")
		process.exit(2)
	}
	return out as Args
}

function main(): void {
	const args = parseArgs()
	const m: Manifest = JSON.parse(readFileSync(args.manifestPath, "utf8"))
	const shards = m.shards ?? []

	const unacknowledged: ShardEntry[] = []
	const acknowledged: ShardEntry[] = []
	const clean: ShardEntry[] = []
	let untracked = 0 // shards predating the linter (no lint_flags field)

	for (const s of shards) {
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

	console.log(`# Shard acknowledgment verification`)
	console.log("")
	console.log(`- **Manifest:** \`${args.manifestPath}\``)
	console.log(`- **Total shards:** ${shards.length}`)
	console.log(`- **Untracked (pre-linter):** ${untracked}`)
	console.log(`- **Clean (lint_flags: 0):** ${clean.length}`)
	console.log(`- **Flagged + acknowledged:** ${acknowledged.length}`)
	console.log(`- **Flagged + UNACKNOWLEDGED:** ${unacknowledged.length}`)
	console.log("")

	if (args.verbose && acknowledged.length > 0) {
		console.log(`## Acknowledged flagged shards (${acknowledged.length})`)
		console.log("")
		for (const s of acknowledged) {
			const note = s.lint_ack_note ? ` — _${s.lint_ack_note}_` : ""
			console.log(`- \`${s.path}\` (${s.lint_flags} flags)${note}`)
		}
		console.log("")
	}

	if (unacknowledged.length > 0) {
		console.log(`## ❌ UNACKNOWLEDGED FLAGGED SHARDS (${unacknowledged.length})`)
		console.log("")
		console.log("These shards have lint flags but no `lint_acknowledged: true`. Training will be blocked. Either:")
		console.log("- Fix the shard so it no longer triggers flags, OR")
		console.log(
			"- Set `lint_acknowledged: true` in the MANIFEST entry with a `lint_ack_note` explaining why the flagged patterns are intentional."
		)
		console.log("")
		for (const s of unacknowledged) {
			console.log(`- \`${s.path}\` (${s.lint_flags} flag(s), source=${s.first_source_id ?? "?"})`)
		}
		console.log("")
		console.error(`VERIFY FAILED: ${unacknowledged.length} unacknowledged flagged shard(s).`)
		process.exit(1)
	}

	console.error("VERIFY PASSED.")
}

main()
