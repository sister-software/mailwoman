/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman license <keygen|issue|verify|register|adopt|refresh>` provides commands for license issuers,
 *   customers and installations. `keygen` creates an Ed25519 signing pair in the config root and prints the
 *   public key with its key id. `issue` signs a payload with the private key and prints the token.
 *   `verify` checks a token (or the configured token) offline against this build's register. With `--online`,
 *   it asks mailwoman.ai whether the key id remains listed and asks the license worker whether the license is active.
 *   `register` prints the well-known file derived from the register. The `--write` flag writes it under `docs/static`.
 *   `adopt` writes a purchased token to the config-root key file and stores its refresh secret beside it.
 *   `refresh` exchanges that secret for the current token after renewal. Neither command writes a token this build cannot verify.
 */

import { configRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalTextFile, writePrivateTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import {
	type DeclarationAnswer,
	type DeclarationClaimAnswer,
	type DeclarationRequest,
	decodeLicenseKeyPayload,
	docsSiteURL,
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	isSelfServicePayload,
	LicenseIntent,
	licenseKeyID,
	type LicenseKeyPayload,
	type LicenseKeyVerification,
	publishedLicenseKeys,
	readOrMintInstallationID,
	readRefreshCredentials,
	trustedLicenseSigningKeys,
	verifyLicenseKey,
	writeLicenseKeyFile,
	writeRefreshCredentials,
} from "@mailwoman/core/license"
import { confirmLicenseKeyPublished, licenseKeysWellKnownURL } from "@mailwoman/core/license/publication"
import {
	checkLicenseStatus,
	claimDeclaration,
	DECLARATION_CLAIM_DEADLINE_MS,
	DECLARATION_CLAIM_INTERVAL_MS,
	declareLicense,
	type LicenseWorkerClientOptions,
	licenseWorkerURL,
	refreshLicenseKey,
	requestEvaluation,
} from "@mailwoman/core/license/status"
import { repoRootPath } from "@mailwoman/core/paths"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { isoDate } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"

import { attributionReport, renderAttributionReport } from "#cli/native/commands/license/attribution"
import {
	booleanValue,
	CLIError,
	CLIUsageError,
	type CommandSpec,
	type ParsedCommand,
	runNativeCommand,
	stringValue,
} from "#cli/native/spec"
import { $public } from "#env"
import { readMailwomanManifest } from "#metadata"

/**
 * The `license` command interface: one positional action and the options each action reads.
 */
export const spec = {
	name: "license",
	description:
		"Mint, issue, verify, adopt and refresh commercial license keys. `keygen` writes an Ed25519 signing pair under $MAILWOMAN_CONFIG_ROOT/license and prints the public key with its id. `issue` signs a key for a licensee. `verify` checks a token offline against the public keys this build trusts. `register` prints the well-known key file the shipped register derives. `adopt <token> --secret <s>` writes a purchased key to $MAILWOMAN_CONFIG_ROOT/license/key and its refresh secret beside it. `refresh` fetches the current key after a renewal. Without a key the AGPL-3.0-only branch applies — `mailwoman doctor` reports which branch applies and why.",
	positionals: [
		{
			name: "action",
			description: "One of: keygen, issue, verify, register, adopt, refresh, declare, evaluate, attribution.",
			required: true,
		},
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
				"adopt: the refresh secret from the purchase page or the first email, stored beside the key. refresh: the secret, when not reading the credentials file.",
		},
		licensee: {
			type: "string",
			hint: "name",
			description: "issue: who holds the license, as the doctor should print it.",
		},
		intent: {
			type: "string",
			hint: "open-source|non-profit|academic|student",
			description:
				"declare: the declaration's intent. open-source gives --project. The others give --organization and --email.",
		},
		name: {
			type: "string",
			hint: "text",
			description: "declare, evaluate: the project or the person the token is issued to, as the doctor prints it.",
		},
		project: {
			type: "string",
			hint: "url",
			description: "declare --intent open-source: the project's public source URL.",
		},
		organization: {
			type: "string",
			hint: "text",
			description: "declare: the non-profit, university or school.",
		},
		email: {
			type: "string",
			hint: "address",
			description:
				"declare, evaluate: the address the token is sent to. For a declaration it is an address at the organization.",
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
			description: "issue: `all`, or a comma-separated list of the packages the agreement covers.",
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

const licenseConfigPath = configRootPath("license")

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
	const major = majorOption ? Number.parseInt(majorOption, 10) : await thisMajorVersion()

	if (!Number.isFinite(major)) throw new CLIUsageError(`--major must be an integer, got ${stringifyJSON(majorOption)}.`)

	const pair = await generateLicenseSigningKeyPair()
	const kid = await licenseKeyID(pair.publicKeyPEM, major)

	await writePrivateTextFile(pair.privateKeyPEM, privatePath)
	await writeLocalTextFile(pair.publicKeyPEM, publicPath)

	if (booleanValue(parsed.values, "json")) {
		process.stdout.write(prettyJSON({ kid, publicKeyPEM: pair.publicKeyPEM, privateKeyPath: privatePath }))
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
	const publicKeyPEM = (await pathExists(publicKeyPath)) ? await readLocalTextFile(publicKeyPath) : null

	const trusted = publicKeyPEM
		? Object.entries(trustedLicenseSigningKeys()).find(([, pem]) => pem.trim() === publicKeyPEM.trim())
		: null

	if (!trusted) {
		throw new CLIError(
			`The public half of ${signingKeyPath} is not in this build's register (packages/core/lib/license/register.ts), so a key it signs would verify nowhere. Add it and rebuild first.`
		)
	}

	const scopeRaw = stringValue(parsed.values, "scope") ?? "all"

	const scope: LicenseKeyPayload["scope"] = scopeRaw === "all" ? "all" : extractDelimited(scopeRaw)

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

	process.stdout.write(booleanValue(parsed.values, "json") ? prettyJSON({ token, payload }) : `${token}\n`)

	return 0
}

/**
 * Why a token may not be written: this build cannot verify it, so writing it would
 * configure a key the runtime reads as unknown on every invocation.
 *
 * `null` for a token that verifies.
 */
function refusalFor(verification: LicenseKeyVerification): string | null {
	switch (verification.status) {
		case "valid":
			return null
		case "expired":
			return `this token expired on ${verification.payload.expires}; refresh it or purchase again.`
		case "unknown_key":
			return `this release does not trust key id ${verification.kid}; upgrade mailwoman to a release that lists it, then try again.`
		default:
			return verification.reason
	}
}

/**
 * The `lid` in a token, when the self-service worker issued it.
 *
 * For a token this build cannot verify the payload is read as written: the command
 * asks only for the license's public status for such a token, since it identifies
 * whether the action is an upgrade or a purchase.
 */
function licenseIDOf(verification: LicenseKeyVerification, token: string): string | null {
	const payload = "payload" in verification ? verification.payload : decodeLicenseKeyPayload(token)

	return payload && isSelfServicePayload(payload) ? payload.lid : null
}

async function adopt(parsed: ParsedCommand): Promise<number> {
	const token = parsed.positionals[1]

	if (!token) throw new CLIUsageError("adopt needs the token: mailwoman license adopt <token> [--secret <secret>].")

	const secret = stringValue(parsed.values, "secret")
	const decoded = decodeLicenseKeyPayload(token)
	const lid = decoded && isSelfServicePayload(decoded) ? decoded.lid : null

	if (secret && !lid) {
		throw new CLIError(
			"Not adopted: this token carries no license id, so it has no refresh secret; adopt it without --secret."
		)
	}

	printAdopted(parsed, await adoptIssued(token, lid, secret, trustedLicenseSigningKeys()))

	return 0
}

interface AdoptedKey {
	keyPath: string
	refreshPath: string | null
	payload: LicenseKeyPayload
}

/**
 * Verify a token against the trusted keys and write it with its refresh credentials.
 *
 * The shared tail of `adopt`, `declare` and `evaluate`: a token this build cannot verify
 * is never written, because the runtime would read it as unknown on every invocation.
 */
async function adoptIssued(
	token: string,
	lid: string | null,
	secret: string | null,
	trustedKeys: Readonly<Record<string, string>>
): Promise<AdoptedKey> {
	const verification = await verifyLicenseKey(token, { trustedKeys })
	const refusal = refusalFor(verification)

	if (refusal || verification.status !== "valid") throw new CLIError(`Not adopted: ${refusal ?? verification.status}`)

	const keyPath = await writeLicenseKeyFile(token)
	const refreshPath = secret && lid ? await writeRefreshCredentials({ lid, secret }) : null

	return { keyPath, refreshPath, payload: verification.payload }
}

function printAdopted(parsed: ParsedCommand, adopted: AdoptedKey, extraLines: readonly string[] = []): void {
	if (booleanValue(parsed.values, "json")) {
		process.stdout.write(prettyJSON(adopted))

		return
	}

	process.stdout.write(
		[
			`key written:      ${adopted.keyPath}`,
			...(adopted.refreshPath ? [`refresh secret:   ${adopted.refreshPath} (mode 0600)`] : []),
			`licensee:         ${adopted.payload.licensee}`,
			`expires:          ${adopted.payload.expires ?? "never"}`,
			...extraLines,
			"",
			"Check it: mailwoman license verify --online",
			"",
		].join("\n")
	)
}

/**
 * The exit code for a worker that did not answer.
 * It differs from refusal (1) and success (0).
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
				? prettyJSON({ ...answer, keyPath })
				: `status: active\nexpires: ${answer.expires}\nkey written: ${keyPath}\n`
		)

		return 0
	}

	if (json) {
		process.stdout.write(prettyJSON(answer))
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

/**
 * What a declaration or evaluation action may have injected: the worker transport,
 * the keys a token must verify against, and the claim poll's cadence.
 * Production uses the defaults, and a test scripts each.
 */
export interface LicenseActionDependencies {
	client?: LicenseWorkerClientOptions
	trustedKeys?: Readonly<Record<string, string>>
	pollIntervalMs?: number
	pollDeadlineMs?: number
}

const DECLARED_INTENTS: ReadonlySet<string> = new Set([
	LicenseIntent.OpenSource,
	LicenseIntent.NonProfit,
	LicenseIntent.Academic,
	LicenseIntent.Student,
])

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

type ClaimOutcome =
	| { kind: "sent"; answer: Extract<DeclarationClaimAnswer, { status: "sent" }> }
	| { kind: "unreachable"; reason: string }

/**
 * Poll a declaration's claim until the message is sent, the send fails,
 * the worker stops answering, or the deadline passes.
 *
 * The claim reports the delivery state: the token and the secret arrive only in the message.
 */
async function awaitClaim(claim: string, email: string, deps: LicenseActionDependencies): Promise<ClaimOutcome> {
	const interval = deps.pollIntervalMs ?? DECLARATION_CLAIM_INTERVAL_MS
	const deadline = deps.pollDeadlineMs ?? DECLARATION_CLAIM_DEADLINE_MS
	const started = Date.now()

	for (;;) {
		const answer = await claimDeclaration(claim, deps.client)

		switch (answer.status) {
			case "sent":
				return { kind: "sent", answer }
			case "unreachable":
				return { kind: "unreachable", reason: answer.reason }
			case "failed":
				throw new CLIError(`The key could not be delivered to ${email}. Check the address and run the command again.`)
			case "revoked":
				throw new CLIError("This declaration is revoked, and no key is issued for it.")
			case "not_found":
				throw new CLIError(`No declaration answers to claim ${claim}.`)
			case "pending":
				break
		}

		if (Date.now() - started >= deadline) {
			throw new CLIError(`Check your inbox at ${email}; run the adopt command from the message.`)
		}

		await pause(interval)
	}
}

/**
 * Turn the worker's answer into an adopted key: at once for an issued token,
 * after the claim for a token that travels by email.
 */
async function finishDeclaration(
	parsed: ParsedCommand,
	answer: DeclarationAnswer,
	email: string | null,
	deps: LicenseActionDependencies
): Promise<number> {
	const trustedKeys = deps.trustedKeys ?? trustedLicenseSigningKeys()

	switch (answer.status) {
		case "issued":
			printAdopted(parsed, await adoptIssued(answer.token, answer.lid, answer.secret, trustedKeys))

			return 0
		case "pending": {
			const address = email ?? "your address"

			process.stdout.write(`Your key is on its way to ${address}. Waiting for the message to go out.\n`)

			const claimed = await awaitClaim(answer.claim, address, deps)

			if (claimed.kind === "unreachable") {
				process.stderr.write(
					`${licenseWorkerURL()} did not answer: ${claimed.reason}. The message still arrives; adopt the key from it.\n`
				)

				return EXIT_UNREACHABLE
			}

			const { licensee, issued, expires } = claimed.answer

			process.stdout.write(
				[
					`Your key was sent to ${address} for ${licensee}, valid ${issued} to ${expires}.`,
					"Run the adopt command from the message on each machine that runs mailwoman:",
					'  mailwoman license adopt "<key>" --secret "<refresh secret>"',
					"",
				].join("\n")
			)

			return 0
		}
		case "refused":
			if (answer.reason === "evaluation_exists") {
				throw new CLIError(
					`This address has already received its evaluation. A declaration or a commercial license continues it: ${docsSiteURL()}/license`
				)
			}

			throw new CLIError(`Refused: ${answer.reason}.`)
		case "unreachable":
			process.stderr.write(`${licenseWorkerURL()} did not answer: ${answer.reason}.\n`)

			return EXIT_UNREACHABLE
	}
}

/**
 * `license declare`: record a declaration of intent with the worker and adopt the token it issues.
 */
export async function declareAction(parsed: ParsedCommand, deps: LicenseActionDependencies = {}): Promise<number> {
	const intent = stringValue(parsed.values, "intent")

	if (!intent || !DECLARED_INTENTS.has(intent)) {
		throw new CLIUsageError("declare requires --intent open-source, non-profit, academic or student.")
	}

	const name = stringValue(parsed.values, "name")

	if (!name) throw new CLIUsageError("declare requires --name <the project or the person the token is issued to>.")

	const project = stringValue(parsed.values, "project")
	const organization = stringValue(parsed.values, "organization")
	const email = stringValue(parsed.values, "email")

	if (intent === LicenseIntent.OpenSource && !project) {
		throw new CLIUsageError("declare --intent open-source requires --project <the project's public source URL>.")
	}

	if (intent !== LicenseIntent.OpenSource && (!email || !organization)) {
		throw new CLIUsageError(
			`declare --intent ${intent} requires --organization <name> and --email <an address at it>, where the key is sent.`
		)
	}

	const request: DeclarationRequest = {
		intent: intent as DeclarationRequest["intent"],
		name,
		install: await readOrMintInstallationID(),
		...(project ? { sourceURL: project } : {}),
		...(organization ? { organization } : {}),
		...(email ? { email } : {}),
	}

	return finishDeclaration(parsed, await declareLicense(request, deps.client), email, deps)
}

/**
 * `license evaluate`: ask for a thirty-day token on an email address and adopt it when it arrives.
 */
export async function evaluateAction(parsed: ParsedCommand, deps: LicenseActionDependencies = {}): Promise<number> {
	const email = stringValue(parsed.values, "email")
	const name = stringValue(parsed.values, "name")

	if (!email || !name) {
		throw new CLIUsageError(
			"evaluate requires --email <the address the key is sent to> and --name <who is evaluating>."
		)
	}

	const install = await readOrMintInstallationID()

	return finishDeclaration(parsed, await requestEvaluation({ email, name, install }, deps.client), email, deps)
}

async function verifyCommand(parsed: ParsedCommand): Promise<number> {
	const token = stringValue(parsed.values, "key") ?? $public.MAILWOMAN_LICENSE_KEY

	if (!token) throw new CLIUsageError("verify needs a token: pass --key <token> or set MAILWOMAN_LICENSE_KEY.")

	const verification = await verifyLicenseKey(token, { trustedKeys: trustedLicenseSigningKeys() })
	const kid = "kid" in verification ? verification.kid : null
	const online = booleanValue(parsed.values, "online")
	const publication = online && kid ? await confirmLicenseKeyPublished(kid) : null
	const lid = licenseIDOf(verification, token)
	const lidStatus = online && lid ? await checkLicenseStatus(lid) : null

	const ok =
		verification.status === "valid" &&
		publication !== "retired" &&
		publication !== "unlisted" &&
		lidStatus !== "revoked" &&
		lidStatus !== "lapsed"

	if (booleanValue(parsed.values, "json")) {
		process.stdout.write(
			prettyJSON({
				...verification,
				publication,
				lid_status: lidStatus,
			})
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

/**
 * `license attribution` — what this installation owes upstream, read off the packages it has.
 *
 * An action on `license` rather than a command of its own, because it answers
 * a question about the same subject.
 * No request calls for a new top-level command.
 * It reads no key and changes no verification path.
 */
async function attributionCommand(parsed: ParsedCommand): Promise<number> {
	const report = await attributionReport((await readMailwomanManifest()).license)

	if (booleanValue(parsed.values, "json")) {
		process.stdout.write(`${prettyJSON(report)}\n`)

		return 0
	}

	process.stdout.write(`${renderAttributionReport(report).join("\n")}\n`)

	return 0
}

async function registerCommand(parsed: ParsedCommand): Promise<number> {
	const document = prettyJSON(publishedLicenseKeys())

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
	return runNativeCommand(spec, args, async (parsed) => {
		const action = parsed.positionals[0]

		switch (action) {
			case "keygen":
				return keygen(parsed)
			case "issue":
				return issue(parsed)
			case "verify":
				return verifyCommand(parsed)
			case "register":
				return registerCommand(parsed)
			case "adopt":
				return adopt(parsed)
			case "refresh":
				return refresh(parsed)
			case "declare":
				return declareAction(parsed)
			case "evaluate":
				return evaluateAction(parsed)
			case "attribution":
				return attributionCommand(parsed)
			default:
				throw new CLIUsageError(
					`Unknown action ${stringifyJSON(action)}. Expected keygen, issue, verify, register, adopt, refresh, declare, evaluate or attribution.`
				)
		}
	})
}
