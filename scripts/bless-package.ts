#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Bless a package for publishing and trust configuration.
 */

import { readFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { $ } from "zx"

const { values: flags, positionals: dirs } = parseArgs({
	options: {
		otp: { type: "string" }, // seed code for first write op
		version: { type: "string" }, // optional semver bump
		file: { type: "string", default: "release.yml" }, // workflow filename (case-sensitive, .yml)
		env: { type: "string" }, // optional GH Actions environment
		provider: { type: "string", default: "github" }, // github | gitlab
		"no-trust": { type: "boolean", default: false }, // publish only; configure trust separately (it needs interactive 2FA)
		"dry-run": { type: "boolean", default: false },
	},
	allowPositionals: true,
})

if (!dirs.length) {
	console.error(
		"usage: node ./bless-package.ts <dir...> [--otp 123456] [--version x.y.z] [--file workflow.yml] [--env name]"
	)
	process.exit(1)
}

$.verbose = true

let pendingOTP = flags.otp // single-use, consumed by first op that needs it
const rl = createInterface({ input: process.stdin, output: process.stdout })

async function nextOTP(): Promise<string> {
	return (await rl.question("npm OTP: ")).trim()
}

// Run an npm write op. attempt 0 leans on the grace window (or seeded otp);
// on EOTP/invalid, prompt for a fresh code and retry.
async function withOTP(run: (otpArgs: string[]) => Promise<unknown>): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		let otpArgs: string[] = []

		if (attempt === 0 && pendingOTP) {
			otpArgs = ["--otp", pendingOTP]
			pendingOTP = undefined
		} else if (attempt > 0) {
			otpArgs = ["--otp", await nextOTP()]
		}

		try {
			await run(otpArgs)
			return
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err)

			if (/EOTP|one-time|invalid otp/i.test(msg)) {
				console.error("⚠ OTP needed/invalid — retry")
				continue
			}

			throw err
		}
	}

	throw new Error("OTP attempts exhausted")
}

type Pkg = { name: string; version: string; repository?: string | { url?: string } }

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

	const tgz = `/tmp/${pkg.name.replace(/[@/]/g, "-")}.tgz`
	await $({ cwd: dir })`yarn pack -o ${tgz}`

	if (flags["dry-run"]) {
		console.log(`• dry-run, would publish ${tgz}`)
		return
	}

	await withOTP((otp) => $`npm publish ${tgz} --access public ${otp}`)
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
		"--allow-publish",
		"--yes",
	]
	if (flags["dry-run"]) {
		console.log(`• dry-run: npm ${args.join(" ")}`)
		return
	}

	console.log(`• ${pkg.name}: configuring trusted publisher…`)
	console.log(`    npm ${args.join(" ")}`)

	// `npm trust` does NOT accept --otp; it requires interactive browser 2FA ("open this URL…"), which
	// can't complete inside this captured-stdio subprocess. So attempt it, but NEVER block the publishes
	// on it — if it can't auth here, print the exact command to run by hand in an interactive shell.
	try {
		await $`npm ${args}`
		console.log(`• ${pkg.name}: trusted publisher configured`)
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)

		if (/already|exists|configured/i.test(msg)) {
			console.log(`• ${pkg.name}: trusted publisher already configured — skip`)
			return
		}
		console.warn(`⚠ ${pkg.name}: trust not set (needs interactive 2FA). Run by hand:`)
		console.warn(`    npm ${args.join(" ")}`)
	}
}

async function main(): Promise<void> {
	for (const dir of dirs) {
		const d = path.resolve(dir)
		console.log(`\n=== ${dir} ===`)
		await packAndPublish(d)

		// `npm trust` needs interactive browser 2FA, which can't run here — `--no-trust` skips it so the
		// publish phase stays clean; configure trust separately (see trust-dropins.sh).

		if (!flags["no-trust"]) {
			await trust(d)
		}

		await $`sleep 2` // rate-limit guard between calls
	}
}

main()
	.then(() => {
		rl.close()
		process.exit(0)
	})
	.catch((e) => {
		console.error(e)
		rl.close()
		process.exit(1)
	})
