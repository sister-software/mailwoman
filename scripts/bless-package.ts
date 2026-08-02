#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Bless a package for publishing and trust configuration.
 *
 *   The second factor is delegated entirely to the npm CLI. Every write op runs with `--no-browser`
 *   and this terminal's stdio, so npm prints its `https://www.npmjs.com/auth/cli/…` approval URL
 *   here and polls while you approve it elsewhere. That is what makes a hardware security key work
 *   over SSH: the key never has to be attached to the machine running this script — open the URL
 *   wherever the key lives and touch it there. If the account's second factor is still TOTP, npm
 *   prompts for the code on stdin instead. Either way this script does not broker it.
 *
 *   To save you moving that URL by hand, it is also pushed to the terminal's clipboard over OSC 52
 *   (see `copyToTerminalClipboard`) — paste and go.
 *
 *   Expect one approval per write op. `npm trust` takes no `--otp` (it accepts no flags at all), and
 *   as of August 2026 npm gates trusted-publishing config behind interactive 2FA that no token can
 *   skip, so the browser step here is not removable. It is a per-package bootstrap cost: once trust
 *   is on file, releases run from CI over OIDC with no second factor at all.
 */

import { readFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { $, type ProcessPromise } from "zx"

import { packWorkspaceForPublish } from "./pack-workspace.ts"
import { verifyTarball } from "./verify-tarball.ts"

/**
 * The npm CLI approval URL, printed when a write op needs a second factor.
 */
const AUTH_URL_PATTERN = /https:\/\/www\.npmjs\.com\/auth\/cli\/[\w-]+/

const { values: flags, positionals: dirs } = parseArgs({
	options: {
		version: { type: "string" }, // optional semver bump
		file: { type: "string", default: "release.yml" }, // workflow filename (case-sensitive, .yml)
		env: { type: "string" }, // optional GH Actions environment
		provider: { type: "string", default: "github" }, // github | gitlab
		"no-trust": { type: "boolean", default: false }, // publish only; configure trust separately
		"dry-run": { type: "boolean", default: false },
	},
	allowPositionals: true,
})

if (!dirs.length) {
	console.error("usage: node ./bless-package.ts <dir...> [--version x.y.z] [--file workflow.yml] [--env name]")

	process.exit(1)
}

$.verbose = true

/**
 * Write ops borrow this terminal so the npm CLI can run its own auth handshake — printing the approval URL, or
 * prompting for a code — without this script standing in the middle of it. stdin and stdout stay inherited (npm keeps a
 * real TTY for any prompt); only stderr is piped, because that is where npm writes the approval URL and we want to read
 * it on the way past. zx forwards piped output to the terminal itself, so nothing here re-emits it.
 */
const npmWrite = $({ stdio: ["inherit", "inherit", "pipe"] })

/**
 * Put text on the clipboard of whatever terminal sits at the far end of the connection, via the OSC 52 escape sequence.
 * Over SSH this reaches the _local_ machine with no forwarding and no agent — the bytes ride the same stream as
 * everything else on screen.
 *
 * Inside tmux this needs `set-clipboard on`. The default, `external`, sets the clipboard from tmux's own copy-mode but
 * silently discards sequences that applications emit — the copy appears to work and nothing arrives.
 *
 * Returns whether the sequence was written; the terminal on the other end may still ignore it, which is not detectable
 * from here.
 */
function copyToTerminalClipboard(text: string): boolean {
	if (!process.stdout.isTTY) return false

	process.stdout.write(`\u001B]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`)

	return true
}

/**
 * Run an npm write op, watching its stderr for the approval URL and pushing the first one to the clipboard.
 *
 * The listener only reads — zx already forwards piped stderr to the terminal, so writing here would print npm's output
 * twice. A URL can straddle a chunk boundary, hence the rolling window rather than a per-chunk match.
 */
async function runNPMWrite(proc: ProcessPromise): Promise<void> {
	let tail = ""
	let copied = false

	proc.stderr.on("data", (chunk: Buffer) => {
		if (copied) return

		tail = (tail + chunk.toString("utf8")).slice(-512)

		const [url] = AUTH_URL_PATTERN.exec(tail) ?? []

		if (!url) return

		copied = true

		if (copyToTerminalClipboard(url)) {
			console.log("• approval URL copied to your clipboard — paste it into a browser and tap your key")
		}
	})

	await proc
}

interface Pkg {
	name: string
	version: string
	repository?: string | { url?: string }
}

async function readPkg(dir: string): Promise<Pkg> {
	return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"))
}

function parseRepo(repository: Pkg["repository"]): string | undefined {
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

async function packAndPublish(dir: string): Promise<void> {
	const pkg = await readPkg(dir)

	if (flags.version) {
		await $({ cwd: dir })`npm version ${flags.version} --no-git-tag-version`
	}

	const exists = await existsOnRegistry(pkg.name)

	if (exists && !flags.version) {
		console.log(`• ${pkg.name} already on registry — skip publish`)

		return
	}

	const tgz = `/tmp/${pkg.name.replaceAll(/[@/]/g, "-")}.tgz`

	// Pack through the SAME helper the release path uses, rather than a bare `yarn pack`. That buys
	// three things this script previously went without: symlinked `files` entries are dereferenced
	// (the registry rejects tarballs containing symlinks outright), the dev `exports` map is
	// transformed for consumers (a bare pack ships `node → .ts`, which no consumer can resolve), and
	// the audit below has a tarball worth auditing.
	packWorkspaceForPublish(dir, tgz)

	// A first publish is the one that most needs this: it is the path taken when CI could not create
	// the package, on a workspace whose derived binaries may never have been materialized locally.
	// neural-weights-en-in@8.6.0 went out from here as three metadata files describing a 4.3 MB index
	// that was not in the tarball, and npm accepted it. Published versions are immutable.
	const audit = verifyTarball(tgz)

	console.log(
		`• ${pkg.name}: tarball verified — ${audit.literalFiles} literal files, ${audit.exportTargets} exports targets`
	)

	if (flags["dry-run"]) {
		console.log(`• dry-run, would publish ${tgz}`)

		return
	}

	// `--no-browser` stops npm handing the approval URL to an xdg-open that has nowhere to go on a
	// headless host — it prints the URL to this terminal instead, where we can catch it.
	await runNPMWrite(npmWrite`npm publish ${tgz} --access public --no-browser`)
}

async function trust(dir: string): Promise<void> {
	const pkg = await readPkg(dir)
	const repo = parseRepo(pkg.repository)

	if (flags.provider === "github" && !repo) {
		throw new Error(`${pkg.name}: cannot derive owner/repo from package.json "repository"`)
	}

	const args = [
		"trust",
		flags.provider!,
		pkg.name,
		...(repo ? ["--repo", repo] : []),
		"--file",
		flags.file!,
		...(flags.env ? ["--env", flags.env] : []),
		"--no-browser",
		"--allow-publish",
		"--yes",
	]

	if (flags["dry-run"]) {
		console.log(`• dry-run: npm ${args.join(" ")}`)

		return
	}

	console.log(`• ${pkg.name}: configuring trusted publisher…`)
	console.log(`    npm ${args.join(" ")}`)

	// There is no cheap way to ask whether trust is already on file: `npm trust list` needs the same
	// second factor as the write, and reading it under `.quiet()` would swallow npm's approval URL —
	// which it prints to stderr — leaving the operator staring at a silent process. So attempt the
	// write unconditionally and let npm arbitrate. Failure never blocks the publishes; npm has already
	// printed the reason to this terminal, so only the retry command needs restating.
	try {
		await runNPMWrite(npmWrite`npm ${args}`)

		console.log(`• ${pkg.name}: trusted publisher configured`)
	} catch {
		console.warn(`⚠ ${pkg.name}: trust not configured (it may already be). Run by hand:`)
		console.warn(`    npm ${args.join(" ")}`)
	}
}

async function main(): Promise<void> {
	for (const dir of dirs) {
		const d = path.resolve(dir)

		console.log(`\n=== ${dir} ===`)

		await packAndPublish(d)

		if (!flags["no-trust"]) {
			await trust(d)
		}

		// Rate-limit guard between calls. It doubles as the window in which npm's auth grant is still
		// warm, so a run of packages usually costs one approval rather than one each.
		await $`sleep 2`
	}
}

main()
	.then(() => {
		process.exit(0)
	})
	.catch((error) => {
		console.error(error)

		process.exit(1)
	})
