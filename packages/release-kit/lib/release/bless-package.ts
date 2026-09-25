/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Publishes a package for the first time and configures its npm trusted publisher.
 *
 *   The npm CLI handles the second factor. Each write runs with `--no-browser` and this terminal's stdio,
 *   so npm prints its approval URL here and polls while the operator approves it on any machine. This
 *   module also copies the URL to the terminal clipboard over OSC 52. Each write needs its own approval,
 *   because `npm trust` accepts no `--otp` flag. After trust is configured, CI publishes over OIDC.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { type PackageJSONLike, readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { PathBuilder, type PathBuilderLike, resolvePath } from "path-ts"
import { $, type ProcessPromise } from "zx"

import { packWorkspaceForPublish } from "#pack/pack-workspace"
import { formatTarballAudit, verifyTarball } from "#pack/verify-tarball"
import { assertWorkspacePublishable } from "#release/stage"

/**
 * Matches the approval URL that the npm CLI prints when a write needs a second factor.
 */
const AUTH_URL_PATTERN = /https:\/\/www\.npmjs\.com\/auth\/cli\/[\w-]+/

/**
 * Options for {@link blessPackages}.
 */
export interface BlessPackageOptions {
	repoRoot: string
	/**
	 * The workspace directories to bless, in order.
	 */
	dirs: string[]
	/**
	 * An optional semver bump that `npm version` applies before packing.
	 */
	version?: string
	/**
	 * The file name of the workflow that runs `npm publish`.
	 * The match is case-sensitive.
	 */
	file: string
	/**
	 * An optional GitHub Actions environment for the trust configuration.
	 */
	env?: string
	provider: string
	/**
	 * Whether to skip the trust configuration and only publish.
	 */
	noTrust: boolean
	dryRun: boolean
	log: (line: string) => void
}

/**
 * The per-package outcome of {@link blessPackages}.
 */
export interface BlessPackageReport {
	blessed: Array<{ name: string; published: boolean; trusted: boolean }>
}

/**
 * Runs an npm write with inherited stdin and stdout so npm keeps a real TTY for its prompts.
 *
 * Stderr is piped so {@link runNPMWrite} can read the approval URL.
 * Zx still forwards the piped output to the terminal.
 */
const npmWrite = $({ stdio: ["inherit", "inherit", "pipe"] })

/**
 * Writes text to the clipboard of the operator's terminal with the OSC 52 escape sequence.
 * Over SSH, the sequence reaches the local machine.
 *
 * Inside tmux, this requires `set-clipboard on`.
 * The tmux default, `external`, discards the sequences that applications emit.
 *
 * @returns Whether the sequence was written.
 * The terminal may still ignore it.
 */
function copyToTerminalClipboard(text: string): boolean {
	if (!process.stdout.isTTY) return false

	process.stdout.write(`\u001B]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`)

	return true
}

/**
 * Runs an npm write and copies the first approval URL from its stderr to the clipboard.
 *
 * The listener only reads, because zx already forwards piped stderr to the terminal.
 * The listener matches against a rolling window because a URL can span two chunks.
 */
async function runNPMWrite(proc: ProcessPromise, log: (line: string) => void): Promise<void> {
	let tail = ""
	let copied = false

	proc.stderr.on("data", (chunk: Buffer) => {
		if (copied) return

		tail = (tail + chunk.toString("utf8")).slice(-512)

		const [url] = AUTH_URL_PATTERN.exec(tail) ?? []

		if (!url) return

		copied = true

		if (copyToTerminalClipboard(url)) {
			log("• approval URL copied to your clipboard — paste it into a browser and tap your key")
		}
	})

	await proc
}

/**
 * Throws when the workflow file does not exist in this repository.
 *
 * The registry accepts a trust config for any workflow file name without checking that the file exists.
 * A wrong name then fails every CI publish with a bare `E404 Not Found - PUT`.
 *
 * Repairing a stored config takes a read and a revoke, and each step needs an interactive 2FA approval.
 */
async function assertWorkflowExists(options: BlessPackageOptions): Promise<void> {
	if (options.provider !== "github") return

	const workflowPath = resolvePath(options.repoRoot, ".github", "workflows", options.file)

	if (await pathExists(workflowPath)) return

	throw new Error(`--file ${options.file}: no such workflow — ${workflowPath} does not exist`)
}

/**
 * Reads a workspace manifest.
 *
 * The return type requires `name` because every caller publishes or reports under it.
 */
async function readPkg(dir: PathBuilderLike): Promise<PackageJSONLike<{ name: string }>> {
	return await readPackageJSON<{ name: string }>(PathBuilder.from(dir)("package.json"))
}

function parseRepo(repository: PackageJSONLike["repository"]): string | undefined {
	if (!repository) return
	const url = typeof repository === "string" ? repository : repository.url

	if (!url) return
	const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/i) ?? url.match(/^github:([^/]+\/[^/.]+)/i)

	return m?.[1]
}

async function existsOnRegistry(name: string): Promise<boolean> {
	try {
		await $`npm view ${name} version`.quiet()

		return true
	} catch {
		return false
	}
}

async function packAndPublish(dir: string, options: BlessPackageOptions): Promise<boolean> {
	const { log } = options
	const pkg = await readPkg(dir)

	if (options.version) {
		// By default, npm follows the bump with an install of the workspace root,
		// and that install cannot parse the Yarn `workspace:*` protocol.
		// The `--no-workspaces-update` flag skips the install.
		await $({
			cwd: dir,
		})`npm version ${options.version} --allow-same-version --no-git-tag-version --no-workspaces-update`
	}

	const exists = await existsOnRegistry(pkg.name)

	if (exists && !options.version) {
		log(`• ${pkg.name} already on registry — skip publish`)

		return false
	}

	const tgz = `/tmp/${pkg.name.replaceAll(/[@/]/g, "-")}.tgz`

	// The release packer dereferences symlinked `files` entries, which the registry rejects,
	// and rewrites the development `exports` map for consumers.
	await packWorkspaceForPublish(dir, tgz)

	// A local workspace may lack derived binaries that were never built,
	// and npm accepts an incomplete tarball.
	// Published versions are immutable, so the audit runs before the publish.
	const audit = verifyTarball(tgz)

	log(`• ${pkg.name}: tarball verified — ${formatTarballAudit(audit)}`)

	if (options.dryRun) {
		log(`• dry-run, would publish ${tgz}`)

		return false
	}

	// The `--no-browser` flag makes npm print the approval URL to stderr instead of opening a browser.
	await runNPMWrite(npmWrite`npm publish ${tgz} --access public --no-browser`, log)

	return true
}

async function trust(dir: string, options: BlessPackageOptions): Promise<boolean> {
	const { log } = options
	const pkg = await readPkg(dir)
	const repo = parseRepo(pkg.repository)

	if (options.provider === "github" && !repo) {
		throw new Error(`${pkg.name}: cannot derive owner/repo from package.json "repository"`)
	}

	const args = [
		"trust",
		options.provider,
		pkg.name,
		...(repo ? ["--repo", repo] : []),
		"--file",
		options.file,
		...(options.env ? ["--env", options.env] : []),
		"--no-browser",
		"--allow-publish",
		"--yes",
	]

	if (options.dryRun) {
		log(`• dry-run: npm ${args.join(" ")}`)

		return false
	}

	log(`• ${pkg.name}: configuring trusted publisher…`)
	log(`    npm ${args.join(" ")}`)

	// Checking for an existing config with `npm trust list` would need its own
	// second factor, so the write runs unconditionally.
	// A failure does not block the remaining publishes.
	// Npm has already printed the reason, so the log adds only the retry command.
	try {
		await runNPMWrite(npmWrite`npm ${args}`, log)

		log(`• ${pkg.name}: trusted publisher configured`)

		return true
	} catch (error) {
		// The create endpoint answers 409 whenever a trust config exists, even a stale one.
		// A retry keeps returning 409, so the log gives the revoke commands.
		const stderr = String((error as { stderr?: string } | undefined)?.stderr ?? error)

		if (/\b409\b/.test(stderr)) {
			log(`⚠ ${pkg.name}: a trust config already exists (409). Read it, and replace it if it is stale:`)
			log(`    npm trust list ${pkg.name}`)
			log(`    npm trust revoke ${pkg.name} --id <id>`)
			log(`    npm ${args.join(" ")}`)

			return false
		}

		log(`⚠ ${pkg.name}: trust not configured. Run by hand:`)
		log(`    npm ${args.join(" ")}`)

		return false
	}
}

/**
 * Publishes each workspace in `options.dirs` and configures its trusted publisher.
 */
export async function blessPackages(options: BlessPackageOptions): Promise<BlessPackageReport> {
	if (!options.dirs.length) {
		throw new Error("bless-package: --dirs <dir>[,<dir>…] is required")
	}

	// Every directory is checked before the first publish.
	// A first publish can target a package that the release list does not include,
	// so this is where a held-out workspace would otherwise leak.
	for (const dir of options.dirs) {
		assertWorkspacePublishable(dir)
	}

	$.verbose = true

	await assertWorkflowExists(options)

	const blessed: BlessPackageReport["blessed"] = []

	for (const dir of options.dirs) {
		const d = resolvePath(options.repoRoot, dir)

		options.log(`\n=== ${dir} ===`)

		const published = await packAndPublish(d, options)
		const trusted = options.noTrust ? false : await trust(d, options)

		blessed.push({ name: (await readPkg(d)).name, published, trusted })

		// The pause limits the request rate.
		// The npm auth grant usually stays valid across the pause, so a run of
		// packages often needs only one approval.
		await $`sleep 2`
	}

	return { blessed }
}
