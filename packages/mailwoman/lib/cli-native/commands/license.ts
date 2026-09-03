/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman license <keygen|issue|verify>` — the issuer's side of the commercial license key, and the check any
 *   installation can run. `keygen` mints an Ed25519 signing pair into the config root and prints the public half with
 *   its key id; `issue` signs a payload with that private key and prints the token; `verify` checks a token (or
 *   `$MAILWOMAN_LICENSE_KEY`) offline against the trusted keys this build ships, and with `--online` also asks
 *   mailwoman.ai whether the key id is still listed.
 */

import { $public } from "@mailwoman/core/env"
import { pathExists, readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, writePrivateTextFile } from "@mailwoman/core/fs/writers"
import {
	confirmLicenseKeyPublished,
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	licenseKeyID,
	licenseKeysWellKnownURL,
	TRUSTED_LICENSE_SIGNING_KEYS,
	verifyLicenseKey,
	type LicenseKeyPayload,
} from "@mailwoman/core/license"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { resolvePath } from "path-ts"

import {
	booleanValue,
	CLIError,
	CLIUsageError,
	type CommandSpec,
	type ParsedCommand,
	runNativeCommand,
	stringValue,
} from "#cli-native/spec"

/**
 * The `license` command contract: one positional action and the options each action reads.
 */
export const spec = {
	name: "license",
	description:
		"Mint, issue and verify commercial license keys. `keygen` writes an Ed25519 signing pair under $MAILWOMAN_CONFIG_ROOT/license and prints the public key with its id; `issue` signs a key for a licensee; `verify` checks a token offline against the public keys this build trusts. Without a key the AGPL-3.0-only branch applies — `mailwoman doctor` says which branch applies and why.",
	positionals: [{ name: "action", description: "One of: keygen, issue, verify.", required: true }],
	options: {
		licensee: {
			type: "string",
			hint: "name",
			description: "issue: who holds the license, as the doctor should print it.",
		},
		expires: {
			type: "string",
			hint: "YYYY-MM-DD",
			description: "issue: the last day the key is valid, inclusive. Omit for a key with no expiry.",
		},
		scope: {
			type: "string",
			default: "all",
			hint: "all|pkg,pkg",
			description: "issue: `all`, or a comma-separated list of package names the agreement covers.",
		},
		major: {
			type: "string",
			hint: "N",
			description: "keygen: the mailwoman major version the key id is prefixed with. Defaults to this build's.",
		},
		key: {
			type: "string",
			hint: "token",
			description: "verify: the token to check. Defaults to $MAILWOMAN_LICENSE_KEY.",
		},
		"signing-key": {
			type: "string",
			hint: "path",
			description: "issue: the private key PEM. Defaults to $MAILWOMAN_CONFIG_ROOT/license/signing-key.pem.",
		},
		online: {
			type: "boolean",
			default: false,
			description: "verify: also ask mailwoman.ai's well-known register whether the key id is still listed.",
		},
		json: { type: "boolean", default: false, description: "Emit the result as JSON." },
	},
} as const satisfies CommandSpec

const SIGNING_KEY_FILE = "signing-key.pem"
const PUBLIC_KEY_FILE = "signing-key.pub.pem"

function licenseConfigPath(...segments: string[]): string {
	return resolvePath($public.MAILWOMAN_CONFIG_ROOT, "license", ...segments)
}

async function thisMajorVersion(): Promise<number> {
	const manifest = await readLocalJSONFile<{ version?: string }>(resolvePackageDirectory("mailwoman")("package.json"))
	const major = Number.parseInt(manifest.version?.split(".")[0] ?? "", 10)

	if (!Number.isFinite(major))
		throw new CLIError("Could not read this build's major version from its package manifest.")

	return major
}

function today(): string {
	return new Date().toISOString().slice(0, 10)
}

async function keygen(parsed: ParsedCommand): Promise<number> {
	const privatePath = licenseConfigPath(SIGNING_KEY_FILE)
	const publicPath = licenseConfigPath(PUBLIC_KEY_FILE)

	if (await pathExists(privatePath)) {
		throw new CLIError(
			`${privatePath} already exists. Move it aside to mint a new signing key; a lost key is retired, never replaced in place.`
		)
	}

	const majorOption = stringValue(parsed.values, "major")
	const major = majorOption === undefined ? await thisMajorVersion() : Number.parseInt(majorOption, 10)

	if (!Number.isFinite(major))
		throw new CLIUsageError(`--major must be an integer, got ${JSON.stringify(majorOption)}.`)

	const pair = generateLicenseSigningKeyPair()
	const kid = licenseKeyID(pair.publicKeyPEM, major)

	await writePrivateTextFile(pair.privateKeyPEM, privatePath)
	await writeLocalTextFile(pair.publicKeyPEM, publicPath)

	if (booleanValue(parsed.values, "json")) {
		process.stdout.write(
			`${JSON.stringify({ kid, publicKeyPEM: pair.publicKeyPEM, privateKeyPath: privatePath }, null, 2)}\n`
		)
	} else {
		process.stdout.write(
			[
				`signing key written: ${privatePath} (mode 0600)`,
				`public key written:  ${publicPath}`,
				`key id:              ${kid}`,
				"",
				"Register the public key in TWO places before issuing keys against it:",
				"  1. packages/core/lib/license/trusted-keys.ts — TRUSTED_LICENSE_SIGNING_KEYS[kid]",
				`  2. docs/static${licenseKeysWellKnownURL().replace(/^https?:\/\/[^/]+/u, "")} — the well-known register`,
				"",
				pair.publicKeyPEM.trimEnd(),
				"",
			].join("\n")
		)
	}

	return 0
}

async function issue(parsed: ParsedCommand): Promise<number> {
	const licensee = stringValue(parsed.values, "licensee")

	if (!licensee) throw new CLIUsageError("issue requires --licensee <name>.")

	const signingKeyPath = stringValue(parsed.values, "signing-key") ?? licenseConfigPath(SIGNING_KEY_FILE)

	if (!(await pathExists(signingKeyPath))) {
		throw new CLIError(
			`No signing key at ${signingKeyPath}. Run \`mailwoman license keygen\` first, or pass --signing-key.`
		)
	}

	const privateKeyPEM = await readLocalTextFile(signingKeyPath)
	const publicKeyPath = resolvePath(signingKeyPath.replace(/\.pem$/u, ""), "..", PUBLIC_KEY_FILE)
	const publicKeyPEM = (await pathExists(publicKeyPath)) ? await readLocalTextFile(publicKeyPath) : undefined

	const trusted = publicKeyPEM
		? Object.entries(TRUSTED_LICENSE_SIGNING_KEYS).find(([, pem]) => pem.trim() === publicKeyPEM.trim())
		: undefined

	if (!trusted) {
		throw new CLIError(
			`The public half of ${signingKeyPath} is not in this build's TRUSTED_LICENSE_SIGNING_KEYS, so a key it signs would verify nowhere. Register it (see \`mailwoman license keygen\`) and rebuild first.`
		)
	}

	const scopeRaw = stringValue(parsed.values, "scope") ?? "all"

	const scope: LicenseKeyPayload["scope"] =
		scopeRaw === "all"
			? "all"
			: scopeRaw
					.split(",")
					.map((name) => name.trim())
					.filter((name) => name.length > 0)

	const expires = stringValue(parsed.values, "expires")

	const payload: LicenseKeyPayload = {
		v: 1,
		kid: trusted[0],
		licensee,
		issued: today(),
		...(expires ? { expires } : {}),
		scope,
		terms: "LicenseRef-Commercial",
	}

	const token = encodeLicenseKey(payload, privateKeyPEM)

	process.stdout.write(
		booleanValue(parsed.values, "json") ? `${JSON.stringify({ token, payload }, null, 2)}\n` : `${token}\n`
	)

	return 0
}

async function verifyCommand(parsed: ParsedCommand): Promise<number> {
	const token = stringValue(parsed.values, "key") ?? $public.MAILWOMAN_LICENSE_KEY

	if (!token) throw new CLIUsageError("verify needs a token: pass --key <token> or set MAILWOMAN_LICENSE_KEY.")

	const verification = verifyLicenseKey(token, { trustedKeys: TRUSTED_LICENSE_SIGNING_KEYS })
	const kid = "kid" in verification ? verification.kid : undefined
	const publication = booleanValue(parsed.values, "online") && kid ? await confirmLicenseKeyPublished(kid) : undefined
	const ok = verification.status === "valid" && publication !== "retired" && publication !== "unlisted"

	if (booleanValue(parsed.values, "json")) {
		process.stdout.write(`${JSON.stringify({ ...verification, ...(publication ? { publication } : {}) }, null, 2)}\n`)
	} else {
		const lines = [`status: ${verification.status}`]

		if ("payload" in verification) {
			lines.push(
				`licensee: ${verification.payload.licensee}`,
				`key id: ${verification.kid}`,
				`issued: ${verification.payload.issued}`,
				`expires: ${verification.payload.expires ?? "never"}`,
				`scope: ${verification.payload.scope === "all" ? "all" : verification.payload.scope.join(", ")}`
			)
		}

		if ("reason" in verification) {
			lines.push(`reason: ${verification.reason}`)
		}

		if (publication) {
			lines.push(`mailwoman.ai: ${publication} (${licenseKeysWellKnownURL()})`)
		}

		process.stdout.write(`${lines.join("\n")}\n`)
	}

	return ok ? 0 : 1
}

export async function run(args: readonly string[]): Promise<number> {
	return await runNativeCommand(spec, args, async (parsed) => {
		const action = parsed.positionals[0]

		switch (action) {
			case "keygen":
				return await keygen(parsed)
			case "issue":
				return await issue(parsed)
			case "verify":
				return await verifyCommand(parsed)
			default:
				throw new CLIUsageError(`Unknown action ${JSON.stringify(action)}. Expected keygen, issue or verify.`)
		}
	})
}
