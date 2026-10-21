# Declared-intent license routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A license token is obtained by payment, by a declaration of intent, or by a thirty-day evaluation, and a
paid artifact is withheld at download rather than at runtime.

**Architecture:** The signed `mwl1` token in `@mailwoman/core/license/key` gains a `terms` union and four claims. The
license worker gains declaration, evaluation, claim and download routes over new ledger tables, with the expiry rule
per intent in one module. The `mailwoman` CLI gains `license declare`, `license evaluate`, a licensed-bundle refusal in
`data pull`, a precision-ceiling entry in the `engine` block, and a `setup` wizard. The pages follow.

**Tech Stack:** TypeScript on Node 24 with type stripping, zod 4, Hono with `@hono/zod-openapi`, Kysely over D1,
Cloudflare Workers through Wrangler and `@cloudflare/vitest-pool-workers`, Ink with `@inkjs/ui`, Docusaurus, vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-declared-intent-license-routes-design.md`. Issue
[#2773](https://github.com/sister-software/mailwoman/issues/2773).

## Global Constraints

- Relative imports carry `.ts`; sibling imports go through the workspace `#` map; a directory module is `<dir>.ts`.
- A constant object plus a derived union replaces `enum`. Constructor parameter properties and runtime namespaces are
  not used.
- A test sits beside its module as `<name>.test.ts`; a CLI test that spawns the compiled entry is
  `<name>.integration.test.ts` and runs after `yarn compile`.
- The worker imports only core subpaths free of `node:*` under the `workerd` condition; `packages/core/lib/worker-bundle.integration.test.ts` enforces it.
- Executable code reads the filesystem through `@mailwoman/core/fs` and composes paths with `path-ts`.
- Presence checks read `x != null` or `typeof x === "string"`, never `!== undefined`.
- A `*.run.ts` or `tools/` script parses flags with `parseArgs`; a file-routed CLI command declares a `spec` with
  booleans declared positively (`default: true` yields `--no-x`).
- Every comment and prose file passes the Vale rules the `PostToolUse` hook runs.
- The `license` field of every public package stays `AGPL-3.0-only OR LicenseRef-Commercial`.
- No runtime path consults the token: an artifact on disk is read as a free one is.
- The worker's new vars are optional in `readEnv`, so a deploy before the operator provisions the bucket keeps every
  existing route up and answers 503 on downloads alone.
- `yarn.lock` changes only through `yarn install` after a manifest edit, and the diff is committed with that edit.

## Review Focus

1. A commercial token minted before this change still verifies and still silences the notice: Task 1 and Task 2 pin
   it with a fixture token whose payload has no `intent`, `seq` or `install`.
2. An issue date near a month end plus four months: `2026-10-31` rolls to `2027-03-03` under `Date.UTC` and the
   nearest lead is `2027-03-11`; Task 4 pins it.
3. A second evaluation for an address that already received one answers 409 and mints no token; Task 6 pins it.
4. A lid-less hand-issued token downloads, a `lapsed` lid is refused, and an artifact outside `scope` is refused;
   Task 7 pins all three.
5. `data pull` of a free bundle is unchanged with no token, and of a licensed bundle with an expired token prints the
   refresh command; Task 10 pins both.

---

### Task 1: The token schema

**Files:**

- Modify: `packages/core/lib/license/key.ts`
- Create: `packages/core/lib/license/declaration.ts` (wire types and one constant, without runtime imports, exported as `./license/declaration` in `packages/core/package.json` so the worker's bundle stays free of `node:*`)
- Test: `packages/core/lib/license/key/key.test.ts`

**Interfaces:**

- Produces, in `declaration.ts`:
  - `EXPIRY_NOTICE_DAYS = 28`.
  - `DeclarationRequest = { intent: Exclude<LicenseIntent, "commercial">; name: string; sourceURL?: string; organization?: string; email?: string; install?: string }`.
  - `DeclarationAnswer = { status: "issued"; token: string; lid: string; secret: string; issued: string; expires: string } | { status: "pending"; claim: string } | { status: "refused"; reason: string } | { status: "unreachable"; reason: string }`.
  - `DeclarationClaimAnswer = { status: "issued"; token: string; lid: string; licensee: string; issued: string; expires: string; refresh_secret?: string } | { status: "pending" } | { status: "revoked" } | { status: "not_found" } | { status: "unreachable"; reason: string }`.
  - `DownloadRequest = { token: string; artifact: string; install?: string }`.
  - `DownloadAnswer = { status: "granted"; url: string; expires: string; bytes: number | null } | { status: "refused"; reason: string } | { status: "unavailable" } | { status: "unreachable"; reason: string }`.
- Produces, in `key.ts`:
  - `LicenseTerms = { Commercial: "LicenseRef-Commercial", OpenSource: "AGPL-3.0-only" } as const` and type `LicenseTerms`.
  - `LicenseIntent = { OpenSource: "open-source", NonProfit: "non-profit", Academic: "academic", Student: "student", Evaluation: "evaluation", Commercial: "commercial" } as const` and type `LicenseIntent`.
  - `LicenseKeyPayloadSchema` with `terms: z.enum([...])`, `intent: z.enum([...]).optional()`, `seq: z.number().int().min(1).optional()`, `install: z.uuid().optional()`.
  - `TIER_SCOPE_PREFIX = "tier:"` and `scopeAdmits(scope: LicenseKeyPayload["scope"], artifact: string): boolean`.
  - `isSelfServicePayload(payload): payload is LicenseKeyPayload & { lid: string }` testing `lid` alone, and `SelfServiceLicenseKeyPayload = LicenseKeyPayload & { lid: string }`.
  - `grantsCommercialTerms(key: LicenseKeyVerification | null | undefined): boolean`, true for `status === "valid"` and `payload.terms === LicenseTerms.Commercial`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a commercial token minted without the new claims still verifies", async () => {
	// payload: { v: 1, kid, licensee: "Example Ltd", issued: "2026-10-01", expires: "2026-11-14", scope: "all", terms: "LicenseRef-Commercial", lid: "lic_…", agreement: "commercial-2026-10" }
	expect((await verifyLicenseKey(token, { trustedKeys, now })).status).toBe("valid")
})
test("an open-source token carries intent, seq and install", async () => {
	const payload = { ...base, terms: "AGPL-3.0-only", intent: "open-source", seq: 3, install: "6f1e…-…" }
	expect(decodeLicenseKeyPayload(await encodeLicenseKey(payload, privateKeyPEM))).toMatchObject({
		intent: "open-source",
		seq: 3,
	})
})
test("seq below 1 and a non-UUID install are refused", async () => {
	await expect(encodeLicenseKey({ ...base, seq: 0 }, privateKeyPEM)).rejects.toThrow()
	await expect(encodeLicenseKey({ ...base, install: "not-a-uuid" }, privateKeyPEM)).rejects.toThrow()
})
test("scopeAdmits", () => {
	expect(scopeAdmits("all", "tier:gb-streets")).toBe(true)
	expect(scopeAdmits(["@mailwoman/neural-weights-en-gb"], "tier:gb-streets")).toBe(false)
	expect(scopeAdmits(["tier:gb-streets"], "tier:gb-streets")).toBe(true)
})
test("isSelfServicePayload needs lid alone", () => {
	expect(isSelfServicePayload({ ...base, lid: "lic_x" })).toBe(true)
	expect(isSelfServicePayload({ ...base, lid: "lic_x", agreement: undefined })).toBe(true)
})
test("grantsCommercialTerms", async () => {
	expect(grantsCommercialTerms({ status: "valid", kid, payload: { ...base, terms: "AGPL-3.0-only" } })).toBe(false)
	expect(grantsCommercialTerms({ status: "valid", kid, payload: base })).toBe(true)
	expect(grantsCommercialTerms(null)).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run packages/core/lib/license/key/key.test.ts`
Expected: the run fails on `scopeAdmits is not a function` and on the schema refusals.

- [ ] **Step 3: Implement in `key.ts`**

Replace `terms: z.literal("LicenseRef-Commercial")` with the enum. Add the three claims as optional. Add the two
constant objects, `scopeAdmits`, `grantsCommercialTerms`, and narrow `isSelfServicePayload`. Grep every caller of
`SelfServiceLicenseKeyPayload` and `.agreement` (`packages/mailwoman/cli`, `packages/license-worker/lib`) and keep
each compiling; `agreement` becomes optional on the narrowed type.

- [ ] **Step 4: Run to verify pass**

Run: `yarn vitest run packages/core/lib/license`
Expected: the run passes.

- [ ] **Step 5: Commit**

```bash
git add packages/core/lib/license/key.ts packages/core/lib/license/key/key.test.ts
git commit -F /tmp/claude-1000/-home-lab-Projects-mailwoman/b81e6a7e-810b-4cae-8dee-b1899e57600c/scratchpad/msg-1.txt
```

Message: `Admit AGPL-3.0-only terms and the intent, seq and install claims in the license key`.

---

### Task 2: The branch, the stamp and the notice follow `terms`

**Files:**

- Modify: `packages/core/lib/license/obligations.ts` (`appliedLicenseBranch`)
- Modify: `packages/core/lib/license/stamp.ts`
- Modify: `packages/api-kit/lib/engine-stamp.ts` (`EngineStampSchema`)
- Test: `packages/core/lib/license/stamp.test.ts`, `packages/core/lib/license/obligations.test.ts`

**Interfaces:**

- Consumes: `grantsCommercialTerms`, `LicenseTerms`, `LicenseIntent`, `EXPIRY_NOTICE_DAYS` from Task 1.
- Produces:
  - `EngineCoverage = { resolved: string; tier: string; command: string }` and `EngineStamp.coverage?: EngineCoverage`.
  - `declaredNoticeSentence(payload: LicenseKeyPayload): string` returning `Declared ${intent} for ${licensee} until ${expires}.`
  - `buildEngineStamp` unchanged in signature; `notice` is `null` only when `grantsCommercialTerms(key)`.
  - `licenseNoticeLines(stamp, key, now?)` returns `[first sentence, declared sentence + " " + license_url]` for a valid AGPL token, adds `expires <date>` when within `EXPIRY_NOTICE_DAYS`, and the existing two lines otherwise.

- [ ] **Step 1: Write the failing tests**

```ts
test("a valid AGPL-3.0-only token keeps the notice and names the declaration", () => {
	const stamp = buildEngineStamp({ version: "11.0.0", expression: DUAL, key: validOpenSource })
	expect(stamp.license).toBe("AGPL-3.0-only")
	expect(stamp.notice).toContain("Declared open-source for Example Project until 2027-03-11.")
	expect(licenseNoticeLines(stamp, validOpenSource)?.[1]).toContain("https://mailwoman.ai/license")
})
test("a valid commercial token silences the notice", () => {
	expect(buildEngineStamp({ version: "11.0.0", expression: DUAL, key: validCommercial }).notice).toBeNull()
})
test("appliedLicenseBranch chooses the open branch for a valid AGPL token", () => {
	expect(appliedLicenseBranch(DUAL, validOpenSource)).toBe("AGPL-3.0-only")
})
test("a token within 28 days of expiry announces the date", () => {
	const lines = licenseNoticeLines(stamp, validOpenSourceExpiring, new Date("2027-02-20T00:00:00Z"))
	expect(lines?.[1]).toMatch(/expires 2027-03-11/u)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run packages/core/lib/license/stamp.test.ts packages/core/lib/license/obligations.test.ts`
Expected: the run fails on the declared sentence and on the branch.

- [ ] **Step 3: Implement**

In `obligations.ts`, compute `commercialAgreement` from `grantsCommercialTerms(key) && !retired`. In `stamp.ts`, add
the `coverage` field and `EngineCoverage`, `declaredNoticeSentence`, and give `licenseNoticeLines` an optional `now`
for the expiry window. In `api-kit/lib/engine-stamp.ts`, add
`coverage: z.object({ resolved: z.string(), tier: z.string(), command: z.string() }).optional()` to the strict object.

- [ ] **Step 4: Run to verify pass**

Run: `yarn vitest run packages/core/lib/license packages/api-kit`
Expected: the run passes.

- [ ] **Step 5: Commit** — `Choose the license branch and the notice from the token's terms`.

---

### Task 3: The installation id

**Files:**

- Create: `packages/core/lib/license/install-id.ts`
- Create: `packages/core/lib/license/install-id.test.ts`
- Modify: `packages/core/lib/license.ts` (barrel export) and `packages/core/package.json` (`./license/install-id`)
- Modify: `packages/mailwoman/cli/doctor/checks.ts` (`RuntimeLicenseObservation.installationID`, `LicensePosture.installationID`, detail line) and its runner.

**Interfaces:**

- Produces: `installationIDFilePath = configRootPath("license", "install")`, `readInstallationID(): Promise<string | null>`, `readOrMintInstallationID(): Promise<string>` using `crypto.randomUUID()` and `writeLocalTextFile`.

- [ ] **Step 1: Write the failing tests** (a temporary config root through `MAILWOMAN_CONFIG_ROOT`, as `key-file.test.ts` does)

```ts
test("mints once and reads the same id after", async () => {
	const first = await readOrMintInstallationID()
	expect(first).toMatch(/^[0-9a-f-]{36}$/u)
	expect(await readOrMintInstallationID()).toBe(first)
	expect(await readInstallationID()).toBe(first)
})
test("reads null before the first mint", async () => {
	expect(await readInstallationID()).toBeNull()
})
```

- [ ] **Step 2: Run** — Expected: the run fails with the module not found.
- [ ] **Step 3: Implement the module, export it, and print `installation id: <uuid>` in the doctor's license check detail when one exists.**
- [ ] **Step 4: Run** `yarn vitest run packages/core/lib/license packages/mailwoman/cli/doctor` — Expected: the run passes.
- [ ] **Step 5: Commit** — `Mint an installation id into the config root and report it in the doctor`.

---

### Task 4: Expiry per intent in the worker

**Files:**

- Create: `packages/license-worker/lib/expiry.ts`
- Create: `packages/license-worker/lib/expiry.test.ts`

**Interfaces:**

- Consumes: `plusDays` from `#dates`; `LicenseIntent` type from `@mailwoman/core/license/key`.
- Produces:
  - `QUARTER_LEAD_DATES = ["03-11", "06-10", "09-10", "12-11"] as const` (21 days before each calendar quarter start).
  - `EVALUATION_DAYS = 30`, `ACADEMIC_DAYS = 365`.
  - `plusMonths(date: string, months: number): string` with `Date.UTC(year, month + months, day)` rollover.
  - `nearestQuarterLead(target: string): string`, a tie going to the later date.
  - `declarationExpiry(issued: string): string` = `nearestQuarterLead(plusMonths(issued, 4))`.
  - `expiryForIntent(intent: LicenseIntent, issued: string): string`, `evaluation` → 30 days, `academic`/`student` → 365 days, `open-source`/`non-profit` → `declarationExpiry`; `commercial` throws, because the billing period decides it.

- [ ] **Step 1: Write the failing tests**

```ts
test.each([
	["2026-10-21", "2027-03-11"],
	["2026-12-25", "2027-03-11"],
	["2026-12-27", "2027-06-10"],
	["2027-02-20", "2027-06-10"],
	["2026-10-31", "2027-03-11"],
])("declarationExpiry(%s) is %s", (issued, expires) => expect(declarationExpiry(issued)).toBe(expires))
test("a tie goes to the later lead date", () => {
	// 2027-04-25 is 45 days after 03-11 and 46 before 06-10; 2027-04-26 is 46 after and 45 before.
	expect(nearestQuarterLead("2027-04-25")).toBe("2027-03-11")
	expect(nearestQuarterLead("2027-04-26")).toBe("2027-06-10")
})
test("expiryForIntent", () => {
	expect(expiryForIntent("evaluation", "2026-10-21")).toBe("2026-11-20")
	expect(expiryForIntent("academic", "2026-10-21")).toBe("2027-10-21")
	expect(() => expiryForIntent("commercial", "2026-10-21")).toThrow()
})
```

- [ ] **Step 2: Run** `yarn workspace @mailwoman/license-worker vitest run lib/expiry.test.ts` — Expected: the run fails with the module not found.
- [ ] **Step 3: Implement.** Candidates are the four lead dates in the target's year and the two neighboring years; pick the smallest absolute day difference; on equal difference pick the later date.
- [ ] **Step 4: Run** — Expected: the run passes.
- [ ] **Step 5: Commit** — `Add the expiry rule per license intent`.

---

### Task 5: Ledger tables for declarations, issuances and downloads

**Files:**

- Create: `packages/license-worker/migrations/0003_declarations.sql`
- Modify: `packages/license-worker/lib/ledger/schema.ts` (three interfaces, `LedgerDatabase`, `LEDGER_COLUMNS`, row types)
- Create: `packages/license-worker/lib/ledger/declarations.ts`
- Test: `packages/license-worker/lib/ledger/ledger.test.ts` (extend), `schema.test.ts` (existing DDL comparison covers the new tables)

**Interfaces:**

- Produces, in `declarations.ts`, each taking `ledger: Ledger` first:
  - `createDeclaration(row: NewDeclaration): Promise<void>`
  - `findDeclaration(lid: string): Promise<DeclarationRow | null>`
  - `findDeclarationByClaim(claimID: string): Promise<DeclarationRow | null>`
  - `findEvaluationByEmail(email: string): Promise<DeclarationRow | null>`
  - `currentIssuance(lid: string): Promise<IssuanceRow | null>` (highest `seq`)
  - `insertIssuance(row: NewIssuance): Promise<"inserted" | "present">` (unique on `lid, seq`)
  - `setIssuanceEmailState(issuanceID: string, state: EmailState, messageID: string | null): Promise<void>`
  - `takePendingDeclarationSecret(lid: string): Promise<string | null>` (the claim route's one-time read, as `takePendingRefreshSecret`)
  - `setDeclarationVerification(lid: string, verification: "verified" | "unverified", at: string): Promise<void>`
  - `recordDownload(row: NewDownload): Promise<void>`

DDL:

```sql
CREATE TABLE declarations (
	lid TEXT PRIMARY KEY,
	intent TEXT NOT NULL CHECK (intent IN ('open-source', 'non-profit', 'academic', 'student', 'evaluation')),
	licensee TEXT NOT NULL,
	email TEXT,
	organization TEXT,
	source_url TEXT,
	claim_id TEXT UNIQUE,
	verification TEXT NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified', 'verified')),
	verified_at TEXT,
	refresh_secret_sha256 TEXT NOT NULL,
	refresh_secret_pending TEXT,
	first_install TEXT,
	license_state TEXT NOT NULL DEFAULT 'active' CHECK (license_state IN ('active', 'lapsed', 'revoked', 'review')),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX declarations_one_evaluation_per_email ON declarations(email) WHERE intent = 'evaluation';

CREATE TABLE issuances (
	issuance_id TEXT PRIMARY KEY,
	lid TEXT NOT NULL REFERENCES declarations(lid),
	seq INTEGER NOT NULL,
	issued TEXT NOT NULL,
	expires TEXT NOT NULL,
	install TEXT,
	payload_json TEXT NOT NULL,
	token TEXT NOT NULL,
	email_state TEXT NOT NULL DEFAULT 'pending' CHECK (email_state IN ('pending', 'sent', 'failed')),
	email_message_id TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE (lid, seq)
);

CREATE TABLE downloads (
	download_id TEXT PRIMARY KEY,
	lid TEXT,
	kid TEXT NOT NULL,
	licensee TEXT NOT NULL,
	install TEXT,
	artifact TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX downloads_by_lid ON downloads(lid, created_at);
```

- [ ] **Step 1: Write the failing tests** in `ledger.test.ts`: a declaration round-trips; `insertIssuance` answers `present` on a repeated `(lid, seq)`; `currentIssuance` returns the highest `seq`; a second evaluation row for one email throws a unique violation; `takePendingDeclarationSecret` answers the plaintext once and `null` after.
- [ ] **Step 2: Run** `yarn workspace @mailwoman/license-worker vitest run lib/ledger` — Expected: the run fails on missing tables and functions.
- [ ] **Step 3: Write the migration, the interfaces, `LEDGER_COLUMNS` entries and the functions.** `schema.test.ts` compares the applied DDL to `LEDGER_COLUMNS`, so every column appears in both.
- [ ] **Step 4: Run** — Expected: the run passes, `schema.test.ts` included.
- [ ] **Step 5: Commit** — `Add declaration, issuance and download tables to the license ledger`.

---

### Task 6: Declaration, evaluation and claim routes, and re-issuance on refresh

**Files:**

- Create: `packages/license-worker/lib/declare.ts`, `lib/declare.test.ts`
- Create: `packages/license-worker/lib/verify-source.ts`, `lib/verify-source.test.ts`
- Create: `packages/license-worker/lib/routes/declare.ts`, `lib/routes/evaluate.ts`
- Modify: `packages/license-worker/lib/routes/refresh.ts` (fall through to a declaration), `lib/app.ts` (register, `fetch` dependency), `lib/env.ts` (`DECLARE_LIMITER`, `EVALUATE_LIMITER`), `wrangler.toml` and `wrangler.sandbox.toml` (two `[[ratelimits]]` each: production `2004`, `2005`; sandbox `1004`, `1005`), `lib/email/provider.ts` (`agreement: string | null`), `lib/email/content.ts` (facts row only when `agreement` is set; subject `Your Mailwoman license (<intent>)` for a declared token), `lib/identifiers.ts` (`newClaimID(): string` = `clm_` + 22 url-safe characters)
- Test: `packages/license-worker/lib/routes.test.ts` (extend with the three routes)

**Interfaces:**

- Consumes: Task 1 constants, schema and `DeclarationRequest` from `@mailwoman/core/license/declaration`; Task 4 `expiryForIntent`; Task 5 functions.
- Produces:
  - `issueDeclaration(env, deps: FulfilDependencies & { fetch: typeof fetch }, request: DeclarationRequest): Promise<DeclarationOutcome>` where
    `DeclarationOutcome = { outcome: "issued"; lid; token; secret; issued; expires } | { outcome: "pending"; claim: string; lid } | { outcome: "refused"; reason: "evaluation_exists" | "missing_email" | "missing_source_url" | "issuance_disabled" }`.
  - `reissueDeclaration(env, deps, declaration: DeclarationRow, now): Promise<IssuanceRow>`: returns the current issuance when it expires more than `EXPIRY_NOTICE_DAYS` after today, otherwise mints `seq + 1` with a fresh expiry, runs `verifySourceURL` for `open-source`, and emails the token when the declaration has an email.
  - `verifySourceURL(fetchImpl: typeof fetch, url: string): Promise<"verified" | "unverified">`: for `https://github.com/<owner>/<repo>` fetch `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/LICENSE` then `LICENSE.md`; otherwise fetch `<url>/LICENSE`; `verified` when the body contains one of `GNU AFFERO GENERAL PUBLIC LICENSE`, `GNU GENERAL PUBLIC LICENSE`, `GNU LESSER GENERAL PUBLIC LICENSE`, `Apache License`, `MIT License`, `Mozilla Public License`, `BSD`.
  - Routes: `POST /v1/declarations` (body `DeclarationRequest` without `evaluation`; 200 `{ status: "issued", token, lid, secret, issued, expires }` or `{ status: "pending", claim }`; 400 on a missing field; 429), `GET /v1/declarations/{claimID}` (the `ClaimResponseSchema` shape, the secret once), `POST /v1/evaluations` (body `{ email, name, install? }`; 200 `{ status: "pending", claim }`; 409 `{ error: "evaluation exists" }`; 429).
  - Payload minted: `{ v: 1, kid: env.LICENSE_SIGNING_KID, licensee: name, issued, expires, scope: "all", terms: "AGPL-3.0-only", lid, intent, seq, install? }`.

- [ ] **Step 1: Write the failing tests** in `declare.test.ts` and `routes.test.ts`:

```ts
test("an open-source declaration answers the token and secret in the response", …) // status issued, decode payload: terms AGPL-3.0-only, intent open-source, seq 1
test("an academic declaration answers a claim id and emails the token", …) // status pending; email.send called once with to = the stated address; claim route answers issued with refresh_secret once, then without
test("a second evaluation for one address answers 409", …)
test("refresh of a declaration with 100 days left returns the current token", …)
test("refresh of a declaration with 10 days left mints seq 2 and runs source verification", …) // fetch stub returns an AGPL LICENSE body; declaration.verification becomes verified
test("verifySourceURL reads LICENSE then LICENSE.md on GitHub and is unverified on 404", …)
test("declarations refuse when ISSUANCE_ENABLED is false", …)
```

- [ ] **Step 2: Run** `yarn workspace @mailwoman/license-worker vitest run` — Expected: the run fails on the missing modules.
- [ ] **Step 3: Implement.** Register the routes in `createLicenseWorkerApp`; add `fetch?: typeof fetch` to `AppDependencies` defaulting to `globalThis.fetch`. In `refresh.ts`, when `findLicense` is null, `findDeclaration`; a wrong secret keeps the 404.
- [ ] **Step 4: Run** — Expected: the run passes.
- [ ] **Step 5: Commit** — `Issue declared and evaluation tokens and re-issue them on refresh`.

---

### Task 7: The download route, the catalog and presigning

**Files:**

- Modify: `packages/license-worker/package.json` (add `aws4fetch`), then `yarn install` and commit `yarn.lock`
- Create: `packages/license-worker/lib/artifacts/catalog.ts`, `lib/artifacts/presign.ts`, `lib/artifacts/presign.test.ts`
- Create: `packages/license-worker/lib/routes/download.ts`
- Modify: `lib/env.ts` (optional `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `PAID_ARTIFACTS_BUCKET`; `DOWNLOAD_LIMITER`), both wrangler files (`DOWNLOAD_LIMITER` namespaces `2006` and `1006`; no `REPLACE` var), `lib/app.ts` (register; `artifacts?: ArtifactCatalog` dependency), `README.md` (bindings table rows)
- Test: `lib/routes.test.ts` (extend)

**Interfaces:**

- Produces:
  - `ArtifactCatalog = Readonly<Record<string, { key: string; bytes: number | null }>>`; `PAID_ARTIFACTS: ArtifactCatalog = {}` with a comment that the operator fills it when the first paid artifact is published.
  - `presignedArtifactURL(env, key: string, expiresSeconds = 3600): Promise<string>` on `AwsClient` from `aws4fetch` with `service: "s3"`, `region: "auto"`, `signQuery: true`, host `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${PAID_ARTIFACTS_BUCKET}/${key}`.
  - `POST /v1/downloads` body `{ token: string; artifact: string; install?: string }`: 503 `{ error: "downloads unavailable" }` when the R2 vars are absent; 400 on an unknown artifact; 403 `{ error: "scope" | "lapsed" | "revoked" | "expired" | "invalid" | "unknown_key" }`; 200 `{ status: "granted", url, expires, bytes }` and one `downloads` row.
  - Verification order: `verifyLicenseKey(token, { trustedKeys: trustedLicenseSigningKeys() })` must be `valid`; `scopeAdmits(payload.scope, artifact)`; when `payload.lid` is set, the `licenses` or `declarations` row must be `active`; otherwise the token is admitted.

- [ ] **Step 1: Write the failing tests**: a lid-less hand-issued valid token is granted; a declaration in state `lapsed` is refused `lapsed`; a token with `scope: ["@mailwoman/neural-weights-en-gb"]` asking for `tier:gb-streets` is refused `scope`; an unknown artifact answers 400; absent R2 vars answer 503; the presigned URL contains `X-Amz-Signature`, `X-Amz-Expires=3600` and the bucket host.
- [ ] **Step 2: Run** — Expected: the run fails on the missing route.
- [ ] **Step 3: Implement**, with the catalog injected in tests as `{ "tier:gb-streets": { key: "tiers/gb-streets/2026-10-01/gb-streets.db", bytes: 1 } }` and the R2 vars set to fixtures in the test env.
- [ ] **Step 4: Run** `yarn workspace @mailwoman/license-worker vitest run` and `yarn vitest run packages/core/lib/worker-bundle.integration.test.ts` — Expected: both runs pass, the bundle free of `node:` specifiers.
- [ ] **Step 5: Commit** — `Answer presigned downloads of paid artifacts to a token that admits them`.

---

### Task 8: The worker client in core

**Files:**

- Modify: `packages/core/lib/license/status.ts`
- Test: `packages/core/lib/license/status.test.ts`

**Interfaces:**

- Produces:
  - `DECLARATION_CLAIM_INTERVAL_MS = 3000`, `DECLARATION_CLAIM_DEADLINE_MS = 120_000`.
  - `declareLicense(request: DeclarationRequest, options?): Promise<DeclarationAnswer>` posting `/v1/declarations`.
  - `requestEvaluation(request: { email: string; name: string; install?: string }, options?): Promise<DeclarationAnswer>` posting `/v1/evaluations`; a 409 maps to `{ status: "refused", reason: "evaluation_exists" }`.
  - `claimDeclaration(claimID: string, options?): Promise<DeclarationClaimAnswer>` getting `/v1/declarations/{claimID}`; a 404 maps to `not_found`.
  - `requestDownload(request: DownloadRequest, options?): Promise<DownloadAnswer>` posting `/v1/downloads`; 403 maps to `{ status: "refused", reason }`, 503 to `{ status: "unavailable" }`.
  - Every request and answer type is imported from `@mailwoman/core/license/declaration` (Task 1); this module adds no type of its own.

- [ ] **Step 1: Write the failing tests** with the scripted transport under `packages/core/lib/api/test/`, one per function and one per mapped error status.
- [ ] **Step 2: Run** `yarn vitest run packages/core/lib/license/status.test.ts` — Expected: the run fails on the missing functions.
- [ ] **Step 3: Implement**, each function `await using api = client(options)` and `cache: false` as the existing two.
- [ ] **Step 4: Run** — Expected: the run passes.
- [ ] **Step 5: Commit** — `Add the declaration, evaluation, claim and download clients`.

---

### Task 9: `mailwoman license declare` and `mailwoman license evaluate`

**Files:**

- Modify: `packages/mailwoman/cli/native/commands/license.ts`
- Test: `packages/mailwoman/cli/native/commands/license.test.ts` (unit, with the transport scripted through `LicenseWorkerClientOptions.axios`)

**Interfaces:**

- Consumes: Task 3 `readOrMintInstallationID`; Task 8 clients.
- Produces: actions `declare` and `evaluate`; options `--intent <open-source|non-profit|academic|student>`, `--name <text>`, `--project <url>`, `--organization <text>`, `--email <address>`; `adoptIssued(token: string, lid: string | null, secret: string | null): Promise<{ keyPath: string; refreshPath: string | null }>` extracted from `adopt` and shared.

- [ ] **Step 1: Write the failing tests**: `declare --intent open-source --name "Example Project" --project https://github.com/example/project` writes the key file and `refresh.json`; `declare --intent academic` without `--email` is a usage error; `evaluate --email a@b.edu --name A` polls the claim route and adopts on `issued`; an `evaluation_exists` refusal prints the pricing URL and exits 1; `unreachable` exits 2.
- [ ] **Step 2: Run** `yarn vitest run packages/mailwoman/cli/native/commands/license.test.ts` — Expected: the run fails on the unknown actions.
- [ ] **Step 3: Implement.** The poll loop waits `DECLARATION_CLAIM_INTERVAL_MS` between claims and gives up at `DECLARATION_CLAIM_DEADLINE_MS` with the message `Check your inbox at <address>; run the adopt command from the message.`
- [ ] **Step 4: Run** — Expected: the run passes. Then `yarn compile` and `yarn vitest run packages/mailwoman/cli/commands/command-option-collisions.integration.test.ts`.
- [ ] **Step 5: Commit** — `Add license declare and license evaluate`.

---

### Task 10: `data pull` refuses a licensed bundle without a token and downloads with one

**Files:**

- Modify: `packages/mailwoman/lib/data/bundles.ts` (`DataBundle.access?: "licensed"`, `DataBundle.tier?: string`, `DataBundle.countries?: readonly string[]`)
- Create: `packages/mailwoman/lib/data/licensed.ts`, `lib/data/licensed.test.ts`
- Modify: `packages/mailwoman/cli/commands/data/pull.tsx`

**Interfaces:**

- Consumes: `verifyConfiguredLicenseKey`, Task 8 `requestDownload`, Task 3 `readInstallationID`.
- Produces:
  - `licensedPullDecision(bundle: DataBundle, key: LicenseKeyVerification | null): { kind: "free" } | { kind: "granted"; token: string } | { kind: "refused"; lines: string[] }`.
  - The refusal text, three lines after the header `<bundle> is a licensed artifact. Get a token by one of:`, where the bundle name is set in backticks:
    `mailwoman license declare --intent open-source --project <url> # free for an open-source project`,
    `mailwoman license evaluate --email <address> # thirty days`,
    `https://mailwoman.ai/license # commercial`; an expired key adds `Your key expired on <date>: mailwoman license refresh`.
  - In `pull.tsx`, a `granted` decision fetches each artifact through `requestDownload` and streams the answered URL where `artifactURL` is used today; `refused` prints the lines and exits 1 before any transfer.

- [ ] **Step 1: Write the failing tests**: a bundle without `access` is `free` with no key; a licensed bundle with no key is `refused` with the three commands; with an expired key the refresh line appears; with a valid key it is `granted`.
- [ ] **Step 2: Run** `yarn vitest run packages/mailwoman/lib/data/licensed.test.ts` — Expected: the run fails with the module not found.
- [ ] **Step 3: Implement.** No existing bundle gains `access: "licensed"`; the field is declared for the first paid artifact.
- [ ] **Step 4: Run** `yarn vitest run packages/mailwoman/lib/data` — Expected: the run passes.
- [ ] **Step 5: Commit** — `Refuse a licensed bundle in data pull without a token and download it through the worker with one`.

---

### Task 11: The precision ceiling in the geocode output

**Files:**

- Create: `packages/mailwoman/lib/data/ceiling.ts`, `lib/data/ceiling.test.ts`
- Modify: `packages/mailwoman/cli/native/commands/geocode.ts` (JSON `engine` and text output)

**Interfaces:**

- Consumes: `EngineCoverage` from Task 2; `BUNDLES`, `DataBundle.tier`, `DataBundle.countries` from Task 10; `RESOLUTION_TIERS` and `GeocodeResult` from `@mailwoman/core/geocode/result`.
- Produces:
  - `installedBundleNames(dataRoot: PathBuilderLike, bundles = BUNDLES): Promise<ReadonlySet<string>>` using `existingLocalPath` per artifact.
  - `precisionCeiling(result: Pick<GeocodeResult, "resolution_tier" | "hierarchy">, installed: ReadonlySet<string>, bundles = BUNDLES): EngineCoverage | null`: the country is the first `countryCode` in `hierarchy`; a bundle with `tier`, `countries` containing it, and absent from `installed` yields an entry whose `resolved` is `result.resolution_tier`, whose `tier` is `bundle.tier`, and whose `command` is `mailwoman data pull` followed by the bundle name, when `resolution_tier` is coarser than the street tiers, and `null` otherwise.
  - `coverageSentence(coverage: EngineCoverage): string` = `Resolved to ${resolved}. The ${tier} tier covers this country and is not installed: ${command}`.

- [ ] **Step 1: Write the failing tests** with a bundles fixture `{ "gb-streets": { tier: "tier:gb-streets", countries: ["GB"], access: "licensed", … } }`: a GB locality result with the tier uninstalled yields the entry; installed yields `null`; a US result yields `null`; a street-level GB result yields `null`.
- [ ] **Step 2: Run** — Expected: the run fails with the module not found.
- [ ] **Step 3: Implement**, reading `RESOLUTION_TIERS` to list the street-level tiers in one constant with a comment.
- [ ] **Step 4: Wire `geocode.ts`**: `engine: coverage ? { ...stamp, coverage } : stamp`; print `coverageSentence` after the text result. Run `yarn vitest run packages/mailwoman/lib/data/ceiling.test.ts` — Expected: the run passes.
- [ ] **Step 5: Commit** — `State the precision ceiling in the geocode engine block`.

---

### Task 12: `mailwoman setup`

**Files:**

- Create: `packages/mailwoman/cli/setup/plan.ts`, `cli/setup/plan.test.ts`
- Create: `packages/mailwoman/cli/commands/setup.tsx`
- Create: `packages/mailwoman/cli/commands/setup.integration.test.ts`

**Interfaces:**

- Consumes: `BUNDLES` with `access`, `tier`, `countries`; Task 10 decision; Task 9 commands; `mailwomanCLIPath()`.
- Produces:
  - `SETUP_SAMPLE_ADDRESS = "1600 Pennsylvania Avenue NW, Washington, DC 20500"`.
  - `SetupRoute = "declare" | "evaluate" | "buy" | "skip"`.
  - `tiersFor(countries: readonly string[], bundles = BUNDLES): Array<{ name: string; tier: string | null; bytes: number; access: "free" | "licensed"; installed: boolean }>`.
  - `setupSummary(checks: { dataRoot: string; configRoot: string; parse: "ok" | "failed" }, tiers: ReturnType<typeof tiersFor>): string[]`, the lines the non-interactive run prints.
  - `spec = { name: "setup", options: { interactive: { type: "boolean", default: true }, countries: { type: "string", multiple: true } } }`.
  - The interactive flow: check roots → run `mailwoman parse --json <sample>` through `runFile(process.execPath, [cliBin, …])` and show the components → `TextInput` for countries when none passed → `tiersFor` table → `Select` of `SetupRoute` → for `declare` and `evaluate`, prompt the fields and call the Task 9 actions' functions → `data pull` of the chosen bundles → the doctor's license line.

- [ ] **Step 1: Write the failing tests**: `tiersFor(["GB"])` lists the GB bundle with `access` and `installed`; `setupSummary` prints one line per tier and the parse verdict; the integration test runs `setup --no-interactive --countries GB` on the compiled CLI and asserts exit 0 and the `Parsed:` line.
- [ ] **Step 2: Run** — Expected: the run fails with the module not found.
- [ ] **Step 3: Implement** the pure module, then the Ink command with `@inkjs/ui` `Select`, `TextInput`, `ConfirmInput` and `useCommandTask` from `#cli-kit`. Render with `interactive: true` in any PTY test, per `packages/mailwoman/AGENTS.md`.
- [ ] **Step 4: Run** `yarn compile && yarn vitest run packages/mailwoman/cli/setup packages/mailwoman/cli/commands/setup.integration.test.ts` — Expected: the run passes.
- [ ] **Step 5: Commit** — `Add the setup wizard`.

---

### Task 13: Pages, citation, release ordering and the worker README

**Files:**

- Modify: `docs/articles/pricing.mdx` (the tier table), `docs/src/pages/license.mdx` (a "Get a token" section with the three routes and the declaration intents), `docs/articles/developers/get-started/install-and-first-parse.mdx` and `ten-minute-trial.mdx` (open with `mailwoman setup`; `verified-with` bumped to the release that ships it)
- Create: `docs/articles/solutions/research-and-teaching.mdx` (the academic and student routes, the citation, the data-terms caveats), `CITATION.cff` (type software, authors `Teffen Ellis`, repository URL, license `AGPL-3.0-only OR LicenseRef-Commercial`, version from the root manifest, and without a DOI)
- Modify: `RELEASING.md` (a "Release ordering for license routes" section: the release with the `terms` union precedes the first declared token and the first withheld artifact), `packages/license-worker/README.md` (bindings rows for the three limiters and the four R2 vars, and the catalog)
- Regenerate: the CLI reference through `yarn workspace @mailwoman/docs` `generate-cli-reference` so `license declare`, `license evaluate` and `setup` appear

The pricing table has three columns, `Open source`, `Commercial` and `Enterprise`, and these rows: parser and
geocoder; base weights; country weights overlays; atlas tiers beyond the base; release from the AGPL source offer; OEM
redistribution; support; custom fine-tunes and acceptance suites; price (`Free`, `$250 a month or $2,400 a year`,
`From $15,000 a year`); who it is for. Under `Open source`, the rows `Open-source project`, `Academic`, `Student`,
`Non-profit` and `Thirty-day evaluation` each read `Declare with mailwoman license …` and link the license page.

- [ ] **Step 1: Write the pages and the citation file.**
- [ ] **Step 2: Run** `node config/vale/lint-prose.ts code <each file>` and `yarn workspace @mailwoman/docs build` — Expected: exit 0.
- [ ] **Step 3: Commit** — `Describe the license routes on the pricing, license, getting-started and research pages`.

---

### Task 14: Verification and the pull request

- [ ] **Step 1:** `yarn compile`, then `yarn lint > <scratchpad>/lint.log 2>&1; echo EXIT=$?`, read the log for the changed paths, and state errors and warnings separately.
- [ ] **Step 2:** `yarn typecheck` likewise.
- [ ] **Step 3:** `yarn vitest run packages/core/lib/license packages/api-kit packages/mailwoman/lib/data packages/mailwoman/cli` and `yarn workspace @mailwoman/license-worker vitest run`; the worker's suite is excluded from the root sweep and runs on its own.
- [ ] **Step 4:** Update the task list on #2773 with `mwdev_issue update_tasks`, then `mwdev_pull_request create` with the issue number, and follow CI through `mwdev_job`.
