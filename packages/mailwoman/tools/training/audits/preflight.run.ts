/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes and checks the preflight receipt: the file a CPU preflight leaves once every audit a config declares has
 *   passed, and which a GPU run requires before it trains.
 *
 *   `key` prints the receipt key for a config and corpus. `write` writes the receipt for the audits selected with
 *   `--audit <name>=<report path>` and prints its key, the token the GPU run presents. `verify` refuses unless the
 *   token is this config and corpus's key and the receipt records a pass for each `--require <name>`.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/audits/preflight.run.ts key --config <yaml> --corpus-dir <dir>
 *     node packages/mailwoman/tools/training/audits/preflight.run.ts write --config <yaml> --corpus-dir <dir> \
 *       --audit-root <dir> --audit corpus_receipts=<report> [--audit validation_label_support] [--audit …]
 *     node packages/mailwoman/tools/training/audits/preflight.run.ts verify --config <yaml> --corpus-dir <dir> \
 *       --audit-root <dir> --token <key> --require corpus_receipts [--require …]
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { preflightKey, verifyPreflightReceipt, writePreflightReceipt } from "./receipt.ts"

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		config: { type: "string" },
		"corpus-dir": { type: "string" },
		"audit-root": { type: "string" },
		audit: { type: "string", multiple: true, default: [] },
		require: { type: "string", multiple: true, default: [] },
		token: { type: "string", default: "" },
	},
})

const [command] = positionals
const config = values.config
const corpusDir = values["corpus-dir"]

if (!config || !corpusDir) throw new Error("--config and --corpus-dir are required")

if (command === "key") {
	console.log(await preflightKey(config, corpusDir))
} else if (command === "write" || command === "verify") {
	const root = values["audit-root"]

	if (!root) throw new Error("--audit-root is required")

	if (command === "write") {
		// `--audit <name>` records a pass with no report file, as a preflight audit that writes none does.
		const audits = values.audit.map((entry) => entry.split("=", 1)[0]!)

		const reports = Object.fromEntries(
			values.audit
				.filter((entry) => entry.includes("="))
				.map((entry) => {
					const at = entry.indexOf("=")

					return [entry.slice(0, at), entry.slice(at + 1)]
				})
		)

		console.log(await writePreflightReceipt(root, config, corpusDir, audits, reports))
	} else {
		await verifyPreflightReceipt(root, config, corpusDir, values.token, values.require)

		console.log(`Preflight receipt: verified (${values.require.join(", ")})`)
	}
} else {
	throw new Error("expected the command key, write or verify")
}
