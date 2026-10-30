/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { decodeLicenseKeyPayload, verifyLicenseKey } from "@mailwoman/core/license/key"
import { env } from "cloudflare:workers"
import { beforeAll, expect, test } from "vitest"

import { issueDeclaration, reissueDeclaration } from "#declare"
import type { LicenseEmail } from "#email/provider"
import { readEnv } from "#env"
import { openLedger } from "#ledger/client"
import { currentIssuance, findDeclaration } from "#ledger/declarations"
import { envWithSigningKey } from "#test/support/keys"
import { applyMigrations } from "#test/support/migrations"

const OCT_21 = Date.UTC(2026, 9, 21)
const INSTALL = "6f1e2a4c-9b3d-4e8f-a1c2-0d5e6f7a8b9c"
const AGPL_BODY = "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007"

beforeAll(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

function emailSpy() {
	const sent: Array<{ message: LicenseEmail; key: string }> = []

	return {
		sent,
		provider: {
			send: async (message: LicenseEmail, key: string) => {
				sent.push({ message, key })

				return { messageID: `msg_${sent.length}` }
			},
		},
	}
}

function fetchAnswering(status: number, body: string): typeof fetch {
	return (async () => new Response(body, { status })) as typeof fetch
}

async function harness(options: { issuance?: boolean; now?: number } = {}) {
	const signing = await envWithSigningKey(
		readEnv({ ...env, ISSUANCE_ENABLED: options.issuance === false ? "false" : "true" })
	)

	const email = emailSpy()

	return {
		signing,
		email,
		ledger: openLedger(env.LICENSE_LEDGER),
		deps: {
			ledger: openLedger(env.LICENSE_LEDGER),
			email: email.provider,
			fetch: fetchAnswering(200, AGPL_BODY),
			now: () => options.now ?? OCT_21,
		},
	}
}

test("an open-source declaration answers the token and the secret and mints seq 1 under the quarter rule", async () => {
	const h = await harness()

	const outcome = await issueDeclaration(h.signing.env, h.deps, {
		intent: "open-source",
		name: "Example Project",
		sourceURL: "https://github.com/example/project",
		install: INSTALL,
	})

	expect(outcome.outcome).toBe("issued")

	if (outcome.outcome !== "issued") return

	expect(decodeLicenseKeyPayload(outcome.token)).toMatchObject({
		terms: "AGPL-3.0-only",
		intent: "open-source",
		seq: 1,
		lid: outcome.lid,
		licensee: "Example Project",
		issued: "2026-10-21",
		expires: "2027-03-11",
		install: INSTALL,
		scope: "all",
	})

	const verified = await verifyLicenseKey(outcome.token, {
		trustedKeys: { [h.signing.kid]: h.signing.publicKeyPEM },
		now: new Date(OCT_21),
	})

	expect(verified.status).toBe("valid")
	expect(outcome.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u)
	expect(h.email.sent).toHaveLength(0)

	await expect(findDeclaration(h.ledger, outcome.lid)).resolves.toMatchObject({
		source_url: "https://github.com/example/project",
		first_install: INSTALL,
		refresh_secret_pending: null,
	})
})

test("an academic declaration answers a claim and emails the token with the secret to the stated address", async () => {
	const h = await harness()

	const outcome = await issueDeclaration(h.signing.env, h.deps, {
		intent: "academic",
		name: "Dr Example",
		organization: "Example University",
		email: "prof@example.edu",
	})

	expect(outcome.outcome).toBe("pending")

	if (outcome.outcome !== "pending") return

	expect(outcome.claim).toMatch(/^clm_[A-Za-z0-9_-]{22}$/u)
	expect(h.email.sent).toHaveLength(1)

	const { message, key } = h.email.sent[0]!

	expect(message).toMatchObject({
		to: "prof@example.edu",
		licensee: "Dr Example",
		lid: outcome.lid,
		issued: "2026-10-21",
		expires: "2027-10-21",
		agreement: null,
		intent: "academic",
	})

	expect(message.refreshSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u)
	expect(key).toBe((await currentIssuance(h.ledger, outcome.lid))?.issuance_id)
	await expect(currentIssuance(h.ledger, outcome.lid)).resolves.toMatchObject({ seq: 1, email_state: "sent" })
})

test("a second evaluation for one address is refused and mints no token", async () => {
	const h = await harness()
	const request = { intent: "evaluation" as const, name: "Evaluator", email: "eval@example.com" }

	expect((await issueDeclaration(h.signing.env, h.deps, request)).outcome).toBe("pending")

	await expect(issueDeclaration(h.signing.env, h.deps, request)).resolves.toEqual({
		outcome: "refused",
		reason: "evaluation_exists",
	})

	expect(h.email.sent).toHaveLength(1)
})

test("a declaration without its required field is refused", async () => {
	const h = await harness()

	await expect(issueDeclaration(h.signing.env, h.deps, { intent: "open-source", name: "X" })).resolves.toEqual({
		outcome: "refused",
		reason: "missing_source_url",
	})

	await expect(issueDeclaration(h.signing.env, h.deps, { intent: "student", name: "X" })).resolves.toEqual({
		outcome: "refused",
		reason: "missing_email",
	})
})

test("the kill switch refuses a declaration", async () => {
	const h = await harness({ issuance: false })

	await expect(
		issueDeclaration(h.signing.env, h.deps, {
			intent: "open-source",
			name: "X",
			sourceURL: "https://github.com/example/project",
		})
	).resolves.toEqual({ outcome: "refused", reason: "issuance_disabled" })
})

test("re-issue keeps the current token with 100 days left, and mints seq 2 and verifies the source within 28 days", async () => {
	const h = await harness()

	const issued = await issueDeclaration(h.signing.env, h.deps, {
		intent: "open-source",
		name: "Example Project",
		sourceURL: "https://github.com/example/project",
	})

	if (issued.outcome !== "issued") throw new Error(issued.outcome)

	const declaration = await findDeclaration(h.ledger, issued.lid)

	if (!declaration) throw new Error("declaration vanished")

	const early = await reissueDeclaration(h.signing.env, { ...h.deps, now: () => Date.UTC(2026, 11, 1) }, declaration)

	expect(early).toMatchObject({ seq: 1, token: issued.token })

	const late = await reissueDeclaration(h.signing.env, { ...h.deps, now: () => Date.UTC(2027, 2, 1) }, declaration)

	if (!late) throw new Error("the re-issue minted nothing")

	expect(late.seq).toBe(2)
	expect(decodeLicenseKeyPayload(late.token)).toMatchObject({ seq: 2, issued: "2027-03-01", expires: "2027-06-10" })
	await expect(findDeclaration(h.ledger, issued.lid)).resolves.toMatchObject({ verification: "verified" })
	expect(h.email.sent).toHaveLength(0)
})

test("an evaluation is never re-issued: the current token is answered while it lasts and null after it expires", async () => {
	const h = await harness()

	const pending = await issueDeclaration(h.signing.env, h.deps, {
		intent: "evaluation",
		name: "Trial Ltd",
		email: "trial-reissue@example.com",
	})

	if (pending.outcome !== "pending") throw new Error(pending.outcome)

	const declaration = await findDeclaration(h.ledger, pending.lid)

	if (!declaration) throw new Error("declaration vanished")

	// 2026-11-10 is ten days before the thirty-day expiry on 2026-11-20.
	const near = await reissueDeclaration(h.signing.env, { ...h.deps, now: () => Date.UTC(2026, 10, 10) }, declaration)

	expect(near).toMatchObject({ seq: 1, expires: "2026-11-20" })

	const after = await reissueDeclaration(h.signing.env, { ...h.deps, now: () => Date.UTC(2026, 10, 21) }, declaration)

	expect(after).toBeNull()
	await expect(currentIssuance(h.ledger, pending.lid)).resolves.toMatchObject({ seq: 1 })
	expect(h.email.sent).toHaveLength(1)
})

test("with issuance disabled a re-issue answers the current token and mints nothing", async () => {
	const open = await harness()

	const issued = await issueDeclaration(open.signing.env, open.deps, {
		intent: "open-source",
		name: "Example Project",
		sourceURL: "https://github.com/example/disabled",
	})

	if (issued.outcome !== "issued") throw new Error(issued.outcome)

	const declaration = await findDeclaration(open.ledger, issued.lid)

	if (!declaration) throw new Error("declaration vanished")

	const closed = await harness({ issuance: false, now: Date.UTC(2027, 2, 1) })
	const answer = await reissueDeclaration(closed.signing.env, closed.deps, declaration)

	expect(answer).toMatchObject({ seq: 1, token: issued.token })
	await expect(currentIssuance(open.ledger, issued.lid)).resolves.toMatchObject({ seq: 1 })
})

test("an evaluation address is one address whatever its case or surrounding space", async () => {
	const h = await harness()

	expect(
		(await issueDeclaration(h.signing.env, h.deps, { intent: "evaluation", name: "A", email: "Case@Example.com" }))
			.outcome
	).toBe("pending")

	await expect(
		issueDeclaration(h.signing.env, h.deps, { intent: "evaluation", name: "B", email: " case@example.com " })
	).resolves.toEqual({ outcome: "refused", reason: "evaluation_exists" })

	expect(h.email.sent[0]?.message.to).toBe("case@example.com")
})
