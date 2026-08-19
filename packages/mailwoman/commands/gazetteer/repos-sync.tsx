/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer repos-sync` — what state the WOF repos root is IN, and the one repair `inspect sync` cannot
 *   perform.
 *
 *   THE DIVISION OF LABOUR MATTERS, because two commands touching the same directories otherwise looks like an
 *   accident. `gazetteer inspect sync` clones and pulls; it now resolves each repo's origin through
 *   `resolveWOFRepoOrigin`, so a NEW clone comes from our fork when one exists. What it cannot do is fix an EXISTING
 *   checkout: `synchronizeRepo` pulls in place and never rewrites a remote, so a directory cloned from upstream before
 *   the fork existed keeps pulling upstream forever, silently, over corrections the build depends on. That repair is
 *   here, and it is opt-in twice (`--apply --repoint`) because it changes what the next build ingests.
 *
 *   REPORT FIRST. Without `--apply` nothing is written: the sweep resolves every origin, reads every checkout and
 *   prints the plan — remote, vintage, shallowness, and whether the tree is safe to touch. A plan nobody saw cannot be
 *   checked, and the vintage half is not available anywhere else: the admin build reads whatever is on disk, so a repo
 *   six months behind produces a plausible artifact and no complaint.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { Box, Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

import type { RepoSyncPlan } from "../../gazetteer-pipeline/repos-sync.ts"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "repos-sync",
	description: "Report each WOF repo's origin, vintage and clone state; re-point an existing clone onto our fork",
	options: {
		root: { type: "string", description: "WOF repos root. Default <data-root>/wof/repos" },
		countries: { type: "string", description: "Comma-separated ISO codes to ensure present, beyond what is cloned" },
		apply: { type: "boolean", default: false, description: "Perform the clones and fast-forwards" },
		repoint: { type: "boolean", default: false, description: "With --apply, re-point a remote onto our fork" },
		offline: { type: "boolean", default: false, description: "Skip the pre-fetch; report against local refs only" },
	},
} as const satisfies CommandSpec

interface Options {
	root?: string
	countries?: string
	apply: boolean
	repoint: boolean
	offline: boolean
}

const ACTION_MARK: Record<string, string> = {
	"up-to-date": "=",
	"fast-forward": "↑",
	clone: "+",
	"repoint-required": "→",
	"refuse-dirty": "✗",
	"refuse-local-commits": "✗",
	"refuse-not-a-clone": "✗",
}

const GazetteerReposSync: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { execFile } = await import("node:child_process")
		const { promisify } = await import("node:util")
		const { existsSync } = await import("node:fs")
		const { join } = await import("node:path")
		const { dataRootPath } = await import("@mailwoman/core/utils")
		const { auditReposRoot } = await import("../../gazetteer-pipeline/repos-audit.ts")
		const { planReposSync, SyncAction, syncSentence } = await import("../../gazetteer-pipeline/repos-sync.ts")
		const { UPSTREAM_ORG } = await import("../../gazetteer-pipeline/wof-repo-origin.ts")

		const exec = promisify(execFile)
		const root = options.root ?? String(dataRootPath("wof", "repos"))

		const requested = (options.countries ?? "")
			.split(",")
			.map((cc) => cc.trim().toLowerCase())
			.filter(Boolean)
			.map((cc) => `whosonfirst-data-admin-${cc}`)

		const audit = auditReposRoot(root, { readCommits: false })
		const repos = [...new Set([...audit.repos.map((r) => r.name), ...requested])].toSorted()

		/**
		 * `gh` answers whether the fork org holds a repo. A THROW here is not "no fork" — `resolveWOFRepoOrigin` keeps that
		 * distinction, and the summary line reports it.
		 */
		const probe = async (org: string, repo: string): Promise<boolean> => {
			await exec("gh", ["api", `/repos/${org}/${repo}`, "--jq", ".name"])

			return true
		}

		const plans = await planReposSync({
			root,
			repos,
			probe: async (org, repo) => {
				try {
					return await probe(org, repo)
				} catch (error) {
					// A 404 is a real answer: the fork does not exist. Anything else (no auth, no network, rate limit) is a
					// failed lookup, and must reach the resolver as a throw so it is not recorded as absence.
					if (/HTTP 404|Not Found/i.test((error as Error).message)) return false

					throw error
				}
			},
			// Existing clones live under `<root>/<owner>/<name>` when nested; prefer wherever the repo already is.
			directoryFor: (repo) => {
				const nested = join(root, UPSTREAM_ORG, repo)
				const flat = join(root, repo)

				if (existsSync(nested)) return nested

				if (existsSync(flat)) return flat

				return nested
			},
			fetchFirst: !options.offline,
		})

		const performed: string[] = []

		if (options.apply) {
			for (const plan of plans) {
				try {
					if (plan.action === SyncAction.Clone) {
						mkdirSync(dirname(plan.directory), { recursive: true })
						await exec("git", ["clone", "--depth", "1", plan.origin.url, plan.directory])
						performed.push(`cloned ${plan.repo} from ${plan.origin.source}`)
					} else if (plan.action === SyncAction.FastForward) {
						await exec("git", ["-C", plan.directory, "merge", "--ff-only", "origin/HEAD"])
						performed.push(`fast-forwarded ${plan.repo}`)
					} else if (plan.action === SyncAction.RepointRequired && options.repoint) {
						// The previous remote is KEPT as `upstream`. Losing the address of the repo we fork from would make
						// the next upstream sync a guess.
						await exec("git", ["-C", plan.directory, "remote", "rename", "origin", "upstream"])
						await exec("git", ["-C", plan.directory, "remote", "add", "origin", plan.origin.url])
						await exec("git", ["-C", plan.directory, "fetch", "--quiet", "origin"])

						// The rename carried `branch.<name>.remote` along with it, so the branch now tracks the remote we
						// just moved away from. Re-point the tracking too, or the next `git pull` here pulls upstream over
						// the corrections this whole command exists to preserve.
						const branch = (
							await exec("git", ["-C", plan.directory, "rev-parse", "--abbrev-ref", "HEAD"])
						).stdout.trim()

						if (branch && branch !== "HEAD") {
							await exec("git", ["-C", plan.directory, "branch", `--set-upstream-to=origin/${branch}`, branch])
						}

						performed.push(`re-pointed ${plan.repo} at ${plan.origin.org} (previous remote kept as upstream)`)
					}
				} catch (error) {
					// oxlint-disable-next-line mailwoman/prefer-spliterator -- one git error message, read for its first line only
					performed.push(`FAILED ${plan.repo}: ${(error as Error).message.split("\n")[0]}`)
				}
			}
		}

		// The vintage stamp lives OUTSIDE the repos root: `ingestWOF` globs the root and a stray file inside it is one
		// more thing for that glob to consider.
		const vintagePath = String(dataRootPath("wof", "repos-vintage.json"))

		mkdirSync(dirname(vintagePath), { recursive: true })

		writeFileSync(
			vintagePath,
			JSON.stringify(
				{
					root,
					repos: plans.map((p) => ({
						repo: p.repo,
						origin: p.origin.org,
						source: p.origin.source,
						head: p.state.head ?? null,
						headDate: p.state.headDate ?? null,
						shallow: p.state.shallow ?? null,
						action: p.action,
					})),
				},
				null,
				1
			),
			"utf8"
		)

		return { plans, sentence: syncSentence(plans), performed, vintagePath, applied: options.apply }
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status !== "done") return <Text>Resolving WOF repo origins…</Text>

	const { plans, sentence, performed, vintagePath, applied } = state.result

	return (
		<Box flexDirection="column">
			<Text>{sentence}</Text>
			<Text> </Text>
			{plans.map((plan: RepoSyncPlan) => (
				<Text key={plan.repo}>
					{" "}
					{ACTION_MARK[plan.action] ?? "?"} {plan.repo} [{plan.origin.source}
					{plan.state.shallow ? ", shallow" : ""}
					{plan.state.headDate ? `, ${plan.state.headDate.slice(0, 10)}` : ""}] — {plan.reason}
				</Text>
			))}
			<Text> </Text>
			{!applied && <Text>report only — pass --apply to clone and fast-forward</Text>}
			{performed.map((line: string) => (
				<Text key={line}>{`  ${line}`}</Text>
			))}
			<Text>vintage → {vintagePath}</Text>
		</Box>
	)
}

export default GazetteerReposSync
