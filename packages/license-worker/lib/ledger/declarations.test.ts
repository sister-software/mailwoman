/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:workers"
import { beforeAll, expect, test } from "vitest"

import { openLedger } from "#ledger/client"
import {
	createDeclaration,
	currentIssuance,
	findDeclaration,
	findDeclarationByClaim,
	findEvaluationByEmail,
	insertIssuance,
	recordDownload,
	setDeclarationVerification,
	setIssuanceEmailState,
} from "#ledger/declarations"
import { LicenseState } from "#ledger/schema"
import { applyMigrations } from "#test/support/migrations"

beforeAll(async () => {
	await applyMigrations(env.LICENSE_LEDGER)
})

function declaration(suffix: string) {
	return {
		lid: `lic_decl0000000000000000${suffix}`,
		intent: "open-source" as const,
		licensee: "Example Project",
		email: null,
		organization: null,
		source_url: "https://github.com/example/project",
		claim_id: null,
		refresh_secret_sha256: "0".repeat(64),
		refresh_secret_pending: "secret",
		first_install: null,
	}
}

function issuance(lid: string, seq: number, expires: string) {
	return {
		issuance_id: `iss_${lid.slice(-1)}${seq}`,
		lid,
		seq,
		issued: "2026-10-21",
		expires,
		install: null,
		payload_json: "{}",
		token: `mwl1.${seq}.x`,
	}
}

test("a declaration round-trips with the active state and an unverified source", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)
	const row = declaration("a")

	await createDeclaration(ledger, row)

	const found = await findDeclaration(ledger, row.lid)

	expect(found).toMatchObject({
		lid: row.lid,
		intent: "open-source",
		license_state: LicenseState.Active,
		verification: "unverified",
		verified_at: null,
	})

	await expect(findDeclaration(ledger, "lic_missing000000000000000")).resolves.toBeNull()
})

test("an issuance inserts once per (lid, seq), and the current issuance is the highest seq", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)
	const row = declaration("b")

	await createDeclaration(ledger, row)

	await expect(insertIssuance(ledger, issuance(row.lid, 1, "2027-03-11"))).resolves.toBe("inserted")

	await expect(insertIssuance(ledger, { ...issuance(row.lid, 1, "2027-03-11"), issuance_id: "iss_dup" })).resolves.toBe(
		"present"
	)

	await expect(insertIssuance(ledger, issuance(row.lid, 2, "2027-06-10"))).resolves.toBe("inserted")

	const current = await currentIssuance(ledger, row.lid)

	expect(current).toMatchObject({ seq: 2, expires: "2027-06-10", email_state: "pending" })

	await setIssuanceEmailState(ledger, current!.issuance_id, "sent", "msg_1")

	await expect(currentIssuance(ledger, row.lid)).resolves.toMatchObject({
		email_state: "sent",
		email_message_id: "msg_1",
	})
})

test("one evaluation per email address, found by that address", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)
	const first = { ...declaration("c"), intent: "evaluation" as const, email: "eval@example.com", source_url: null }

	await createDeclaration(ledger, first)

	expect((await findEvaluationByEmail(ledger, "eval@example.com"))?.lid).toBe(first.lid)
	await expect(findEvaluationByEmail(ledger, "nobody@example.com")).resolves.toBeNull()

	await expect(createDeclaration(ledger, { ...first, lid: `lic_decl0000000000000000d` })).rejects.toThrow(/UNIQUE/u)
})

test("a non-profit declaration with the same email is admitted beside an evaluation", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)

	await createDeclaration(ledger, {
		...declaration("e"),
		intent: "non-profit",
		email: "eval@example.com",
		organization: "Example Trust",
		source_url: null,
		claim_id: "clm_e",
	})

	expect((await findDeclarationByClaim(ledger, "clm_e"))?.intent).toBe("non-profit")
	await expect(findDeclarationByClaim(ledger, "clm_missing")).resolves.toBeNull()
})

test("source verification is recorded with its time", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)
	const row = declaration("g")

	await createDeclaration(ledger, row)
	await setDeclarationVerification(ledger, row.lid, "verified", "2027-03-01T00:00:00.000Z")

	await expect(findDeclaration(ledger, row.lid)).resolves.toMatchObject({
		verification: "verified",
		verified_at: "2027-03-01T00:00:00.000Z",
	})
})

test("a download is recorded with or without a lid", async () => {
	const ledger = openLedger(env.LICENSE_LEDGER)

	await recordDownload(ledger, {
		download_id: "dl_1",
		lid: null,
		kid: "v9-deadbeef",
		licensee: "Enterprise Ltd",
		install: null,
		artifact: "tier:gb-streets",
	})

	await recordDownload(ledger, {
		download_id: "dl_2",
		lid: declaration("a").lid,
		kid: "v9-deadbeef",
		licensee: "Example Project",
		install: "6f1e2a4c-9b3d-4e8f-a1c2-0d5e6f7a8b9c",
		artifact: "tier:gb-streets",
	})

	const rows = await ledger.selectFrom("downloads").select(["download_id", "lid"]).orderBy("download_id").execute()

	expect(rows).toEqual([
		{ download_id: "dl_1", lid: null },
		{ download_id: "dl_2", lid: declaration("a").lid },
	])
})
