/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman license <keygen|issue|verify|register|adopt|refresh>` — the issuer's side of the commercial license key,
 *   the customer's side, and the check any installation can run. `keygen` mints an Ed25519 signing pair into the config
 *   root and prints the public half with its key id; `issue` signs a payload with that private key and prints the token;
 *   `verify` checks a token (or the configured one) offline against the register this build ships, and with `--online`
 *   also asks mailwoman.ai whether the key id is still listed and the license worker whether the license still stands;
 *   `register` prints the well-known file the register derives, or writes it under `docs/static` with `--write`. `adopt`
 *   writes a purchased token to the config-root key file, and its refresh secret beside it; `refresh` trades that secret
 *   for the current token after a renewal. Neither writes a token this build cannot verify.
 */

import { configRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, writePrivateTextFile } from "@mailwoman/core/fs/writers"
import {
	decodeLicenseKeyPayload,
	docsSiteURL,
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	isSelfServicePayload,
	licenseKeyID,
	type LicenseKeyPayload,
	type LicenseKeyVerification,
	publishedLicenseKeys,
	readRefreshCredentials,
	trustedLicenseSigningKeys,
	verifyLicenseKey,
	writeLicenseKeyFile,
	writeRefreshCredentials,
} from "@mailwoman/core/license"
import { confirmLicenseKeyPublished, licenseKeysWellKnownURL } from "@mailwoman/core/license/publication"
import { checkLicenseStatus, licenseWorkerURL, refreshLicenseKey } from "@mailwoman/core/license/status"
import { repoRootPath } from "@mailwoman/core/paths"
import { isoDate } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"

import { readMailwomanManifest } from "#cli-kit/metadata"
import {
	booleanValue,
	CLIError,
	CLIUsageError,
	type CommandSpec,
	type ParsedCommand,
	runNativeCommand,
	stringValue,
} from "#cli-native/spec"
import { $public } from "#env"

/**
 * The `license` command contract: one positional action and the options each action reads.
 */
export const spec = {
	name: "license",
	description:
		"Mint, issue, verify, adopt and refresh commercial license keys. `keygen` writes an Ed25519 signing pair under $MAILWOMAN_CONFIG_ROOT/license and prints the public key with its id; `issue` signs a key for a licensee; `verify` checks a token offline against the public keys this build trusts; `register` prints the well-known key file the shipped register derives; `adopt <token> --secret <s>` writes a purchased key to $MAILWOMAN_CONFIG_ROOT/license/key and its refresh secret beside it; `refresh` fetches the current key after a renewal. Without a key the AGPL-3.0-only branch applies — `mailwoman doctor` says which branch applies and why.",
	positionals: [
		{ name: "action", description: "One of: keygen, issue, verify, register, adopt, refresh.", required: true },
		{ name: "argument", description: "adopt: the token to adopt.", required: false },
	],
	options: {
		lid: {
			type: "string",
			hint: "lic_…",
			description: "refresh: the license id, when not reading $MAILWOMAN_CONFIG_ROOT/license/refresh.json.",
		},
		secret: {
			type: "string",
			hint: "secret",
			description:
				"adopt: the refresh secret from the purchase page or the first email, stored beside the key; refresh: the secret, when not reading the credentials file.",
		},
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
			description:
				"verify: also ask mailwoman.ai's well-known register whether the key id is still listed, and the license worker whether a self-service license still stands.",
		},
		write: {
			type: "boolean",
			default: false,
			description: "register: write the well-known file under docs/static instead of printing it.",
		},
		json: { type: "boolean", default: false, description: "Emit the result as JSON." },
	},
} as const satisfies CommandSpec

const SIGNING_KEY_FILE = "signing-key.pem"
const PUBLIC_KEY_FILE = "signing-key.pub.pem"

function licenseConfigPath(...segments: string[]): string {
	return String(configRootPath("license", ...segments))
}

async function thisMajorVersion(): Promise<number> {
	const manifest = await readMailwomanManifest()
	const major = Number.parseInt(manifest.version.split(".")[0] ?? "", 10)

	if (!Number.isFinite(major))
		throw new CLIError("Could not read this build's major version from its package manifest.")

	return major
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

	const pair = await generateLicenseSigningKeyPair()
	const kid = await licenseKeyID(pair.publicKeyPEM, major)

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
				"Register the public key, then regenerate the well-known file, before issuing keys against it:",
				'  1. packages/core/lib/license/register.ts — add an entry with status "active"',
				"  2. mailwoman license register --write",
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
		? Object.entries(trustedLicenseSigningKeys()).find(([, pem]) => pem.trim() === publicKeyPEM.trim())
		: undefined

	if (!trusted) {
		throw new CLIError(
			`The public half of ${signingKeyPath} is not in this build's register (packages/core/lib/license/register.ts), so a key it signs would verify nowhere. Add it and rebuild first.`
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
		issued: isoDate(),
		...(expires ? { expires } : {}),
		scope,
		terms: "LicenseRef-Commercial",
	}

	const token = await encodeLicenseKey(payload, privateKeyPEM)

	process.stdout.write(
		booleanValue(parsed.values, "json") ? `${JSON.stringify({ token, payload }, null, 2)}\n` : `${token}\n`
	)

	return 0
}

/**
 * Why a token may not be written: this build cannot verify it, so writing it would configure a key the runtime reads as
 * unknown on every invocation. `undefined` for a token that verifies.
 */
function refusalFor(verification: LicenseKeyVerification): string | undefined {
	switch (verification.status) {
		case "valid":
			return undefined
		case "expired":
			return `this token expired on ${verification.payload.expires}; refresh it or buy again.`
		case "unknown_key":
			return `this release does not trust key id ${verification.kid}; upgrade mailwoman to a release that lists it, then try again.`
		default:
			return verification.reason
	}
}

/**
 * The lid a token carries, when the self-service worker issued it. For a token this build cannot verify the payload is
 * read as written: the license's public status is the one thing worth asking about such a token, since it says whether
 * the remedy is an upgrade or a purchase.
 */
function licenseIDOf(verification: LicenseKeyVerification, token: string): string | undefined {
	const payload = "payload" in verification ? verification.payload : decodeLicenseKeyPayload(token)

	return payload && isSelfServicePayload(payload) ? payload.lid : undefined
}

async function adopt(parsed: ParsedCommand): Promise<number> {
	const token = parsed.positionals[1]

	if (!token) throw new CLIUsageError("adopt needs the token: mailwoman license adopt <token> [--secret <secret>].")

	const verification = await verifyLicenseKey(token, { trustedKeys: trustedLicenseSigningKeys() })
	const refusal = refusalFor(verification)

	if (refusal || verification.status !== "valid") throw new CLIError(`Not adopted: ${refusal ?? verification.status}`)

	const secret = stringValue(parsed.values, "secret")
	const lid = licenseIDOf(verification, token)

	if (secret && !lid) {
		throw new CLIError(
			"Not adopted: this token carries no license id, so it has no refresh secret; adopt it without --secret."
		)
	}

	const keyPath = await writeLicenseKeyFile(token)
	const refreshPath = secret && lid ? await writeRefreshCredentials({ lid, secret }) : undefined

	if (booleanValue(parsed.values, "json")) {
		process.stdout.write(
			`${JSON.stringify({ keyPath, ...(refreshPath ? { refreshPath } : {}), payload: verification.payload }, null, 2)}\n`
		)
	} else {
		process.stdout.write(
			[
				`key written:      ${keyPath}`,
				...(refreshPath ? [`refresh secret:   ${refreshPath} (mode 0600)`] : []),
				`licensee:         ${verification.payload.licensee}`,
				`expires:          ${verification.payload.expires ?? "never"}`,
				"",
				"Check it: mailwoman license verify --online",
				"",
			].join("\n")
		)
	}

	return 0
}

/**
 * The exit code for a worker that did not answer: not a refusal, so not 1, and not success.
 */
const EXIT_UNREACHABLE = 2

async function refresh(parsed: ParsedCommand): Promise<number> {
	const lid = stringValue(parsed.values, "lid")
	const secret = stringValue(parsed.values, "secret")
	const credentials = lid && secret ? { lid, secret } : await readRefreshCredentials()

	if (!credentials) {
		throw new CLIUsageError(
			"refresh needs the license id and secret: pass --lid and --secret, or run `mailwoman license adopt <token> --secret <secret>` once."
		)
	}

	const answer = await refreshLicenseKey(credentials)
	const json = booleanValue(parsed.values, "json")

	if (answer.status === "active") {
		const verification = await verifyLicenseKey(answer.token, { trustedKeys: trustedLicenseSigningKeys() })
		const refusal = refusalFor(verification)

		if (refusal) throw new CLIError(`Not written: ${refusal}`)

		const keyPath = await writeLicenseKeyFile(answer.token)

		process.stdout.write(
			json
				? `${JSON.stringify({ ...answer, keyPath }, null, 2)}\n`
				: `status: active\nexpires: ${answer.expires}\nkey written: ${keyPath}\n`
		)

		return 0
	}

	if (json) {
		process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`)
	}

	switch (answer.status) {
		case "pending":
			throw new CLIError(
				"The first payment has not been recorded yet; the key arrives by email, or run refresh again shortly."
			)
		case "not_found":
			throw new CLIError("No license answers to this lid and secret.")
		case "unreachable":
			process.stderr.write(
				`${licenseWorkerURL()} did not answer: ${answer.reason}. The configured key, if any, stands.\n`
			)

			return EXIT_UNREACHABLE
		default:
			throw new CLIError(
				`This license is ${answer.status}; no key is issued for it. Manage billing at ${docsSiteURL()}/license.`
			)
	}
}

async function verifyCommand(parsed: ParsedCommand): Promise<number> {
	const token = stringValue(parsed.values, "key") ?? $public.MAILWOMAN_LICENSE_KEY

	if (!token) throw new CLIUsageError("verify needs a token: pass --key <token> or set MAILWOMAN_LICENSE_KEY.")

	const verification = await verifyLicenseKey(token, { trustedKeys: trustedLicenseSigningKeys() })
	const kid = "kid" in verification ? verification.kid : undefined
	const online = booleanValue(parsed.values, "online")
	const publication = online && kid ? await confirmLicenseKeyPublished(kid) : undefined
	const lid = licenseIDOf(verification, token)
	const lidStatus = online && lid ? await checkLicenseStatus(lid) : undefined

	const ok =
		verification.status === "valid" &&
		publication !== "retired" &&
		publication !== "unlisted" &&
		lidStatus !== "revoked" &&
		lidStatus !== "lapsed"

	if (booleanValue(parsed.values, "json")) {
		process.stdout.write(
			`${JSON.stringify(
				{ ...verification, ...(publication ? { publication } : {}), ...(lidStatus ? { lid_status: lidStatus } : {}) },
				null,
				2
			)}\n`
		)
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

		if (lidStatus) {
			lines.push(`license ${lid}: ${lidStatus} (${licenseWorkerURL()})`)
		}

		process.stdout.write(`${lines.join("\n")}\n`)
	}

	return ok ? 0 : 1
}

async function registerCommand(parsed: ParsedCommand): Promise<number> {
	const document = `${JSON.stringify(publishedLicenseKeys(), null, "\t")}\n`

	if (booleanValue(parsed.values, "write")) {
		const target = repoRootPath("docs", "static", ".well-known", "mailwoman", "license-keys.json")

		await writeLocalTextFile(document, target)
		process.stdout.write(`wrote ${target}\n`)

		return 0
	}

	process.stdout.write(document)

	return 0
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
			case "register":
				return await registerCommand(parsed)
			case "adopt":
				return await adopt(parsed)
			case "refresh":
				return await refresh(parsed)
			default:
				throw new CLIUsageError(
					`Unknown action ${JSON.stringify(action)}. Expected keygen, issue, verify, register, adopt or refresh.`
				)
		}
	})
}
