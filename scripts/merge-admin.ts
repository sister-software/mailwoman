#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ONE sanctioned `gh pr merge --admin` route (#1895). Four PRs merged with `--admin` on
 *   2026-08-24 while their checks were pending, and two board rows shipped with stale pins that
 *   surfaced a day later on the first branch that ran the suite. The bypass stays available — the
 *   lab fleet is slow when it is slow — but it now runs the sub-second guards the skipped checks
 *   would have, synchronously, and refuses to merge over a failure.
 *
 *   Contract: the LOCAL checkout must be at the PR's head commit — the guards measure the tree they
 *   run in, and measuring a different tree than the one being merged answers a question nobody
 *   asked. The script verifies the SHA and refuses with the checkout command otherwise.
 *
 *   Usage: `node scripts/merge-admin.ts <pr-number> [--method merge|squash|rebase]`
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArgs } from "@mailwoman/platform/util"
import { $ } from "zx"

/**
 * The paths whose change makes the board-pin guard mandatory: the corpus rows themselves, the loader/fingerprint
 * implementation, the pins API, and the pin test.
 */
const BOARD_PIN_PATHS = [
	/^packages\/mailwoman\/eval-harness\/gauntlet\/cases\//,
	/^packages\/mailwoman\/eval-harness\/gauntlet\/ablation\.ts$/,
	/^packages\/mailwoman\/test\/unit\/eval-harness\/gauntlet\/cases\/load\.test\.ts$/,
]

async function mergeAdmin(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			method: { type: "string", default: "merge" },
		},
	})

	const prNumber = positionals[0]

	if (!prNumber || !/^\d+$/.test(prNumber)) {
		throw new Error("usage: node scripts/merge-admin.ts <pr-number> [--method merge|squash|rebase]")
	}

	if (!["merge", "squash", "rebase"].includes(values.method)) {
		throw new Error(`--method ${JSON.stringify(values.method)} is not merge|squash|rebase`)
	}

	const prView = await $`gh pr view ${prNumber} --json state,title,headRefOid,files`.quiet()

	const pr = parseJSONStrict<{
		state: string
		title: string
		headRefOid: string
		files: Array<{ path: string }>
	}>(prView.stdout)

	if (pr.state !== "OPEN") {
		throw new Error(`PR #${prNumber} is ${pr.state}, not OPEN.`)
	}

	const localHead = (await $`git rev-parse HEAD`.quiet()).stdout.trim()

	if (localHead !== pr.headRefOid) {
		throw new Error(
			`the local checkout is at ${localHead.slice(0, 12)} but PR #${prNumber}'s head is ` +
				`${pr.headRefOid.slice(0, 12)} — the guards measure the tree they run in, so check the PR out first:\n` +
				`  gh pr checkout ${prNumber}`
		)
	}

	const changed = pr.files.map((file) => file.path)
	const ranChecks: string[] = []

	if (changed.some((path) => BOARD_PIN_PATHS.some((pattern) => pattern.test(path)))) {
		const { checkBoardPins } = await import("mailwoman/eval-harness/gauntlet/cases/pins")
		const check = await checkBoardPins()

		ranChecks.push(`board-pins (${check.measured.CORPUS_SIZE} rows)`)

		if (check.stale.length) {
			const drift = check.stale
				.map((key) => `  ${key}: committed ${String(check.committed[key])} → measured ${String(check.measured[key])}`)
				.join("\n")

			throw new Error(
				`REFUSING to admin-merge PR #${prNumber} — the board pins are stale on its head:\n${drift}\n` +
					"Run `mailwoman eval pins --update`, commit, and re-run."
			)
		}
	}

	process.stderr.write(
		`checks run: ${ranChecks.length ? ranChecks.join(", ") : "none applicable to the changed paths"}\n`
	)

	process.stderr.write(`merging PR #${prNumber} (${pr.title}) with --admin --${values.method}\n`)

	const methodFlag = `--${values.method}`

	await $({ stdio: "inherit" })`gh pr merge ${prNumber} --admin ${methodFlag}`
}

runIfScript(import.meta, mergeAdmin)
