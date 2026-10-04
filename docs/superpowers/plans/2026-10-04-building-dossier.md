# Implementation Plan: the Building Dossier Package

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new workspace, `@mailwoman/dossier`, that checks supplied property records for dangling references, duplicates and malformed dates and projects the admitted ones into a reviewable building dossier, proven by executable fixtures for the eight synthetic scenarios in the inventory and rendered as a report an operator can read.

**Architecture:** Pure TypeScript with no database and no network. Entities (parcel, building, entrance, unit) carry namespaced external identifiers; aliases and containment links carry their evidence; every claim names its subject, axis, value, `EpistemicStatus`, source record and three time concepts; counts stay interpretable by stage, scope and date; commercial events stay distinct; a dossier is built for an explicit `asOf` date and returns conclusions beside the unresolved questions and the one record that would resolve each. The report renderer turns a dossier into Markdown.

**Tech Stack:** TypeScript on Node 24 with type stripping, `@mailwoman/evidence` (`EpistemicStatus`, `CoverageBasis`, `supportsExclusion`, `Observation`, `Relation`), `@mailwoman/record` (`PostalAddress`, `AddressGeocode`), Vitest (root fast sweep).

**Spec:** `docs/superpowers/specs/2026-10-04-building-dossier-contract-inventory.md`, with the decisions recorded in issue #2285's comment of 2026-10-04 (package home, vocabulary reuse, prohibitions, report deliverable) and the program context in #2291, #1571 and #1680.

## Global Constraints

- Read `AGENTS.md` at the repository root and `packages/release-kit/AGENTS.md` ("A new workspace joins SEVEN registers") before the first edit.
- The package is `packages/dossier`, npm name `@mailwoman/dossier`, published (`publishConfig.access: public`), version `10.1.0` to match the sibling packages. It depends on `@mailwoman/evidence` and `@mailwoman/record` with `workspace:*`. Until the operator runs the `bless-package` first publish, the workspace is held in `SANCTIONED_RELEASE_ABSENCES` with the reason stated verbatim in Task 1; it joins `.release-it.json` only after the bless.
- Every `packages/*` workspace keeps its library under `lib/`, exports `.`, `./package.json` and `./*`, and the `imports` map mirrors `#*`. A directory module is a sibling file `<dir>.ts`; the one index file is `lib/index.ts`.
- Relative imports include `.ts`. Use `import type` for types. A constant object plus a derived union replaces `enum`. Constructor parameter properties and runtime namespaces are both excluded.
- A declaration has one home: import `EpistemicStatus`, `CoverageBasis`, `supportsExclusion`, `Observation`, `Relation` from `@mailwoman/evidence` and `PostalAddress`, `AddressGeocode` from `@mailwoman/record`. Re-export none of them.
- The library imports no Node builtin: every module under `lib/` must run in a browser, because #2289 renders the dossier in a map application.
- Status values on a claim are `designated`, `observed`, `derived` or `inferred` from `EpistemicStatus`; an unresolved question is a separate type and never a claim value. An inferred claim and an observed claim are distinct union members and cannot be assigned to one another.
- Three time fields on a source record: `observedAt` (when the source observed the fact), `availableAt` (when the record became available), `retrievedAt` (when the application retrieved it); each optional and ISO 8601 (`YYYY-MM-DD` or full timestamp). A claim's applicability interval is `validFrom` / `validTo` on the claim. An `asOf` dossier admits a record only when `availableAt` is known and not after `asOf`; a record with unknown `availableAt` is listed as undated and excluded from conclusions.
- A unit total is computed only when every contributing count shares the stage, the date and a declared disjoint membership; otherwise the total is `unresolved` and lists the conflicting counts. An unresolved total is never `0` and never a sum.
- Six commercial event kinds: `inquiry`, `commitment`, `order`, `active_subscription`, `landlord_permission`, `accepted_build`. A permission's scope is exactly the entity list on the event.
- Provider availability is a dated relation; `availabilityAt` answers `available`, `withdrawn` or `unknown` for one date and never implies uptake.
- A layer reading classifies as `unknown` when the layer has no survey for the extent, `surveyed_empty` when the layer's `basis` passes `supportsExclusion` and the survey returned zero records, `source_present_empty` when the basis is `source_present` and zero records (which supports no exclusion), and `conflicting` when a positive observation disagrees.
- A reader that cannot produce part of a requested result throws or returns the unresolved value with its reason; it never returns zero, an empty collection or `unchanged` in place of a missing input.
- Comments state the rule or invariant in plain register; JSDoc starts with a complete sentence.
- Shell commands may not write files inside the repository; use the Write and Edit tools. Stage by path; never `git add -A`; `git add` new files before `yarn lint`.
- Root `yarn test` collects `packages/dossier/lib/**/*.test.ts` by default; `yarn vitest run packages/dossier` runs the package alone.

## Review Focus

1. A record whose `availableAt` is after `asOf` but whose `observedAt` is before it: the dossier excludes the record from conclusions and lists it under excluded records with both dates. Test in Task 6.
2. Two aliases that each link to a different candidate building with the same alias text: the identity section lists both candidates as unresolved rather than picking one. Test in Task 2.
3. A unit count whose `membership` key equals another's but whose stage differs (planned 24 vs completed 20): the two never sum and both display. Test in Task 3.
4. An `active_subscription` event with no `date`: validation reports it and the dossier excludes it from any count of active subscriptions. Test in Task 4.
5. A layer reading with `basis: "source_present"` and zero records: classified as `source_present_empty`, which the report words as "the source looked and found no record; absence is unknown", never as absence. Test in Task 5.

---

## File Structure

```text
packages/dossier/
  package.json
  tsconfig.json
  tsconfig.test.json
  README.md
  lib/
    index.ts                 the package's one index: re-exports every public declaration below
    identifiers.ts           ExternalID, EntityID, entity id construction
    time.ts                  ISODate, SourceTime, ClaimInterval, admitsAsOf
    sources.ts               SourceRecord, SourceRecordID, sourceIndex
    entities.ts              Parcel, Building, Entrance, Unit, Entity, EntityKind
    links.ts                 Alias, AliasCandidate, Containment, ContainmentRelation, resolveAlias, buildingsOf
    claims.ts                ClaimAxis, Claim (discriminated by status), claimsFor
    counts.ts                UnitStage, UnitCount, totalUnits, UnitTotal
    events.ts                CommercialEventKind, CommercialEvent, eventsByKind, permissionScopes
    availability.ts          ProviderAvailability, availabilityAt
    coverage.ts              LayerReading, LayerReadingClass, classifyReading
    filings.ts               FilingRow, distinctBlocks (the US denominator control)
    validate.ts              validateRecords, ValidationIssue
    dossier.ts               DossierInput, Dossier, buildDossier, Unresolved
    report.ts                renderReport (Markdown)
    *.test.ts                beside each module
  test/
    fixtures/example-house.ts  the fictional Example House, Example Annex and Example Parcel records
```

Each scenario in the spec is one `describe` block in the test beside the module that decides it; `dossier.test.ts` holds the scenarios that span modules.

---

### Task 1: Workspace, identifiers and time

**Files:**

- Create: `packages/dossier/package.json`, `tsconfig.json`, `tsconfig.test.json`, `README.md`
- Create: `packages/dossier/lib/index.ts`, `lib/identifiers.ts`, `lib/identifiers.test.ts`, `lib/time.ts`, `lib/time.test.ts`
- Modify: root `tsconfig.json` (two reference entries, beside the `packages/evidence` ones at lines 62 and 121)
- Modify: `packages/release-kit/lib/release/stage.ts` (`SANCTIONED_RELEASE_ABSENCES`)
- Modify: `packages/release-kit/lib/release/smoke/clean-install.ts` (the pack set map at line 19)
- Modify: `docs/engineering/reference/workspaces.mdx` (one row), `AGENTS.md` (workspace counts)

**Interfaces:**

- Produces from `#identifiers`: `interface ExternalID { namespace: string; value: string }`, `type EntityID = string`, `entityID(kind: EntityKind, key: string): EntityID` producing `"<kind>:<key>"`, `sameExternalID(a, b): boolean`.
- Produces from `#time`: `type ISODate = string`, `interface SourceTime { observedAt?: ISODate; availableAt?: ISODate; retrievedAt?: ISODate }`, `interface ClaimInterval { validFrom?: ISODate; validTo?: ISODate }`, `type Admission = "admitted" | "excluded" | "undated"`, `admitsAsOf(time: SourceTime, asOf: ISODate): Admission`, `appliesAt(interval: ClaimInterval, date: ISODate): boolean | "unknown"`, `compareISODate(a: ISODate, b: ISODate): -1 | 0 | 1`, `isISODate(text: string): boolean`.

- [ ] **Step 1: Create the workspace manifest and configs**

`packages/dossier/package.json`:

```json
{
	"name": "@mailwoman/dossier",
	"version": "10.1.0",
	"description": "Building opportunity dossiers: sourced identity, premises, network, access and demand claims over parcels, buildings, entrances and units, projected for an explicit as-of date with every unresolved question and the record that would resolve it.",
	"keywords": ["building", "dossier", "evidence", "premises", "provenance"],
	"license": "AGPL-3.0-only OR LicenseRef-Commercial",
	"contributors": [{ "name": "Teffen Ellis", "email": "teffen@sister.software" }],
	"repository": {
		"type": "git",
		"url": "https://github.com/sister-software/mailwoman.git",
		"directory": "packages/dossier"
	},
	"files": ["out/**/*.js", "out/**/*.js.map", "out/**/*.d.ts", "out/**/*.d.ts.map", "lib/**/*.ts", "!**/*.test.ts"],
	"type": "module",
	"sideEffects": false,
	"imports": {
		"#test/*": "./test/*.ts",
		"#*": { "types": "./out/*.d.ts", "node": "./lib/*.ts", "default": "./out/*.js" }
	},
	"exports": {
		"./package.json": "./package.json",
		".": { "types": "./out/index.d.ts", "node": "./lib/index.ts", "default": "./out/index.js" },
		"./*": { "types": "./out/*.d.ts", "node": "./lib/*.ts", "default": "./out/*.js" }
	},
	"publishConfig": { "access": "public" },
	"dependencies": {
		"@mailwoman/evidence": "workspace:*",
		"@mailwoman/record": "workspace:*"
	},
	"engines": { "node": ">=24.18.0" }
}
```

`packages/dossier/tsconfig.json` is `packages/evidence/tsconfig.json` with `"references": [{ "path": "../evidence" }, { "path": "../record" }]`. `packages/dossier/tsconfig.test.json` is `packages/evidence/tsconfig.test.json` unchanged.

`packages/dossier/README.md`: three paragraphs. What a dossier is (the spec's definition). What the package does and does not do (validates and projects supplied records; acquires no source, computes no cost). Where the scenarios live (`lib/*.test.ts`, fixtures in `test/fixtures/example-house.ts`).

- [ ] **Step 2: Register the workspace**

Root `tsconfig.json`: add `{ "path": "./packages/dossier" }` after the `./packages/evidence` entry and `{ "path": "./packages/dossier/tsconfig.test.json" }` after the `./packages/evidence/tsconfig.test.json` entry.

`packages/release-kit/lib/release/stage.ts`, in `SANCTIONED_RELEASE_ABSENCES`:

```ts
	"packages/dossier":
		"published package awaiting the bless-package first publish of its npm name; move it to .release-it.json once blessed",
```

`packages/release-kit/lib/release/smoke/clean-install.ts`: add `"@mailwoman/dossier": "packages/dossier",` beside the `@mailwoman/evidence` entry at line 19, and read the file's header to confirm the pack set admits a workspace that is held out of the release list; if it refuses one, leave the entry out and say so in the report.

`docs/engineering/reference/workspaces.mdx`: one row after `packages/evidence/`:

```text
| `packages/dossier/` | `@mailwoman/dossier` | Building opportunity dossiers — parcels, buildings, entrances and units with namespaced identifiers; sourced claims on eight independent axes with observed, available and retrieved dates; interpretable unit counts by stage and scope; six distinct commercial events; dated provider availability; coverage readings classified through `supportsExclusion`; an `asOf` projection that returns conclusions beside unresolved questions and the record that would resolve each; a Markdown report. Depends on `@mailwoman/evidence` and `@mailwoman/record`. Spec: `docs/superpowers/specs/2026-10-04-building-dossier-contract-inventory.md` |
```

`AGENTS.md` line 3 to 5: the scoped package count rises by one (74 → 75), the workspace count by one (76 → 77), and the private count stays at fifteen while the published count stays at sixty, because the new workspace is held out. Rewrite the sentences as if the new counts had always held.

Run `yarn install`, then the workspace check from `packages/release-kit/AGENTS.md` line 51, and `yarn vitest run packages/release-kit/lib/release-stage.integration.test.ts`. Expected: the check prints `packages/dossier` among the held-out workspaces and the `publishCount` pin stays at 60.

- [ ] **Step 3: Write the failing tests**

`packages/dossier/lib/identifiers.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { entityID, sameExternalID } from "#identifiers"

describe("entityID", () => {
	test("joins the kind and the key with a colon", () => {
		expect(entityID("building", "example-house")).toBe("building:example-house")
	})

	test("refuses an empty key", () => {
		expect(() => entityID("unit", "")).toThrow(/empty key/)
	})
})

describe("sameExternalID", () => {
	test("compares namespace and value exactly", () => {
		expect(sameExternalID({ namespace: "nyc:bin", value: "3000001" }, { namespace: "nyc:bin", value: "3000001" })).toBe(
			true
		)
		expect(sameExternalID({ namespace: "nyc:bin", value: "3000001" }, { namespace: "nyc:bbl", value: "3000001" })).toBe(
			false
		)
	})
})
```

`packages/dossier/lib/time.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { admitsAsOf, appliesAt, compareISODate, isISODate } from "#time"

describe("isISODate", () => {
	test.each(["2022-03-01", "2022-03-01T10:00:00Z", "2022-03-01T10:00:00+01:00"])("accepts %s", (text) => {
		expect(isISODate(text)).toBe(true)
	})

	test.each(["03/01/2022", "2022-3-1", "yesterday", ""])("refuses %s", (text) => {
		expect(isISODate(text)).toBe(false)
	})
})

describe("compareISODate", () => {
	test("orders a date before a later timestamp on the same day", () => {
		expect(compareISODate("2022-03-01", "2022-03-01T10:00:00Z")).toBe(-1)
		expect(compareISODate("2022-03-02", "2022-03-01T10:00:00Z")).toBe(1)
		expect(compareISODate("2022-03-01", "2022-03-01")).toBe(0)
	})
})

describe("admitsAsOf", () => {
	test("admits a record available on or before the cutoff", () => {
		expect(admitsAsOf({ availableAt: "2022-01-15" }, "2022-06-30")).toBe("admitted")
		expect(admitsAsOf({ availableAt: "2022-06-30" }, "2022-06-30")).toBe("admitted")
	})

	test("excludes a record available after the cutoff even when observed before it", () => {
		expect(admitsAsOf({ observedAt: "2021-12-01", availableAt: "2023-01-01" }, "2022-06-30")).toBe("excluded")
	})

	test("reports a record with no availability date as undated", () => {
		expect(admitsAsOf({ observedAt: "2021-12-01" }, "2022-06-30")).toBe("undated")
	})
})

describe("appliesAt", () => {
	test("is true inside the interval and false outside it", () => {
		expect(appliesAt({ validFrom: "2022-01-01", validTo: "2022-12-31" }, "2022-06-30")).toBe(true)
		expect(appliesAt({ validFrom: "2022-01-01", validTo: "2022-12-31" }, "2023-01-01")).toBe(false)
	})

	test("is unknown when the interval has neither bound", () => {
		expect(appliesAt({}, "2022-06-30")).toBe("unknown")
	})

	test("treats an open end as applying from the start onward", () => {
		expect(appliesAt({ validFrom: "2022-01-01" }, "2030-01-01")).toBe(true)
	})
})
```

- [ ] **Step 4: Run the tests and confirm they fail**

Run: `yarn vitest run packages/dossier`
Expected: FAIL. `#identifiers` and `#time` cannot be resolved.

- [ ] **Step 5: Implement `identifiers.ts` and `time.ts`**

`packages/dossier/lib/identifiers.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Identifiers for the physical objects a dossier describes. An external identifier keeps the namespace
 *   of the authority that issued it, so two systems' numbers for one building never collide. An entity
 *   id is the application's own key, used for objects that no authority has numbered yet.
 */

export const EntityKind = {
	Parcel: "parcel",
	Building: "building",
	Entrance: "entrance",
	Unit: "unit",
} as const

export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind]

export interface ExternalID {
	/** The issuing authority's namespace, such as `nyc:bin` or `os:uprn`. */
	namespace: string
	value: string
}

/**
 * The application's key for an entity: `<kind>:<key>`.
 */
export type EntityID = string

export function entityID(kind: EntityKind, key: string): EntityID {
	if (key === "") throw new Error(`entityID: empty key for a ${kind}`)

	return `${kind}:${key}`
}

export function sameExternalID(a: ExternalID, b: ExternalID): boolean {
	return a.namespace === b.namespace && a.value === b.value
}
```

`packages/dossier/lib/time.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The three time concepts a claim needs: when the source observed the fact, when the record became
 *   available, and when the application retrieved it. A dossier built for an `asOf` date admits a record
 *   by its availability date alone, so a decision dated 2022 cannot rest on a record published in 2023.
 */

/**
 * An ISO 8601 date (`YYYY-MM-DD`) or timestamp.
 */
export type ISODate = string

export interface SourceTime {
	observedAt?: ISODate
	availableAt?: ISODate
	retrievedAt?: ISODate
}

export interface ClaimInterval {
	validFrom?: ISODate
	validTo?: ISODate
}

export type Admission = "admitted" | "excluded" | "undated"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/

export function isISODate(text: string): boolean {
	return ISO_DATE.test(text) && !Number.isNaN(Date.parse(text))
}

/**
 * A bare date sorts at the start of its day, so a date compares before a timestamp on the same day.
 */
export function compareISODate(a: ISODate, b: ISODate): -1 | 0 | 1 {
	const left = Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a)
	const right = Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b)

	if (Number.isNaN(left) || Number.isNaN(right)) throw new Error(`compareISODate: unparseable date in ${a}, ${b}`)

	return left < right ? -1 : left > right ? 1 : 0
}

/**
 * A record without an availability date cannot be placed before or after the cutoff, so it is undated
 * rather than admitted.
 */
export function admitsAsOf(time: SourceTime, asOf: ISODate): Admission {
	if (time.availableAt === undefined) return "undated"

	return compareISODate(time.availableAt, asOf) <= 0 ? "admitted" : "excluded"
}

export function appliesAt(interval: ClaimInterval, date: ISODate): boolean | "unknown" {
	if (interval.validFrom === undefined && interval.validTo === undefined) return "unknown"
	if (interval.validFrom !== undefined && compareISODate(date, interval.validFrom) < 0) return false
	if (interval.validTo !== undefined && compareISODate(date, interval.validTo) > 0) return false

	return true
}
```

`packages/dossier/lib/index.ts` begins with the package header and `export * from "#identifiers"` and `export * from "#time"`; each later task adds its module's line.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `yarn vitest run packages/dossier`
Expected: PASS, 13 tests.

- [ ] **Step 7: Lint, compile and commit**

Run: `git add packages/dossier tsconfig.json packages/release-kit docs/engineering/reference/workspaces.mdx AGENTS.md yarn.lock && yarn tsc -b packages/dossier && yarn lint`
Expected: zero errors; the `workspace-exports`, `workspace-files` and `nested-index` checks report the new workspace as conforming.

```bash
git commit -m "Add the dossier workspace with entity identifiers and the three time concepts" -- packages/dossier tsconfig.json packages/release-kit docs/engineering/reference/workspaces.mdx AGENTS.md yarn.lock
```

---

### Task 2: Sources, entities, aliases and containment

**Files:**

- Create: `packages/dossier/lib/sources.ts`, `lib/entities.ts`, `lib/links.ts`, `lib/links.test.ts`, `test/fixtures/example-house.ts`

**Interfaces:**

- Produces from `#sources`: `type SourceRecordID = string`, `interface SourceRecord extends SourceTime { id: SourceRecordID; publisher: string; title: string; url?: string }`, `sourceIndex(records: readonly SourceRecord[]): ReadonlyMap<SourceRecordID, SourceRecord>` (throws on a duplicate id).
- Produces from `#entities`: `interface EntityBase { id: EntityID; kind: EntityKind; externalIDs: readonly ExternalID[]; label: string }`, `interface Parcel extends EntityBase { kind: "parcel" }`, `Building`, `Entrance`, `Unit` likewise, `type Entity = Parcel | Building | Entrance | Unit`, `entityIndex(entities: readonly Entity[]): ReadonlyMap<EntityID, Entity>` (throws on a duplicate id).
- Produces from `#links`: `interface Evidence { source: SourceRecordID; observedAt?: ISODate } & ClaimInterval`, `interface AliasCandidate { entity: EntityID; evidence: Evidence }`, `interface Alias { text: string; address?: PostalAddress; candidates: readonly AliasCandidate[] }`, `const ContainmentRelation = { EntranceOf: "entrance_of", UnitOf: "unit_of", BuildingOn: "building_on" }`, `interface Containment { child: EntityID; parent: EntityID; relation: ContainmentRelation; evidence: Evidence }`, `resolveAlias(alias: Alias): { kind: "resolved"; entity: EntityID; evidence: Evidence } | { kind: "ambiguous"; candidates: readonly AliasCandidate[] } | { kind: "unlinked" }`, `entrancesOf(building: EntityID, links: readonly Containment[]): readonly Containment[]`, `buildingsOn(parcel: EntityID, links: readonly Containment[]): readonly Containment[]`.

Spec scenarios decided here: **Two frontages** (one building, two entrances, both aliases preserved with their evidence) and the identity half of **Shared parcel** (two buildings on one parcel).

- [ ] **Step 1: Write the fixtures**

`packages/dossier/test/fixtures/example-house.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fictional Example House, Example Annex and Example Parcel that every scenario in the spec uses.
 *   Dates are chosen so that an `asOf` of 2022-06-30 admits the permit and the first inspection and
 *   excludes the later manager statement.
 */

import type { Entity } from "#entities"
import { entityID } from "#identifiers"
import { type Alias, type Containment, ContainmentRelation } from "#links"
import type { SourceRecord } from "#sources"

export const PARCEL = entityID("parcel", "example-parcel")
export const HOUSE = entityID("building", "example-house")
export const ANNEX = entityID("building", "example-annex")
export const NORTH = entityID("entrance", "example-house-north")
export const SOUTH = entityID("entrance", "example-house-south")

export const SOURCES: SourceRecord[] = [
	{
		id: "permit-2021",
		publisher: "Example City Buildings Department",
		title: "New building permit",
		observedAt: "2021-05-10",
		availableAt: "2021-05-12",
		retrievedAt: "2026-10-04",
	},
	{
		id: "inspection-2022",
		publisher: "Example City Buildings Department",
		title: "Inspection record",
		observedAt: "2022-04-01",
		availableAt: "2022-04-03",
		retrievedAt: "2026-10-04",
	},
	{
		id: "manager-2023",
		publisher: "Example Management Co",
		title: "Manager statement",
		observedAt: "2023-02-01",
		availableAt: "2023-02-01",
		retrievedAt: "2026-10-04",
	},
	{
		id: "survey-2022",
		publisher: "Example Surveyor",
		title: "Entrance survey",
		observedAt: "2022-03-15",
		availableAt: "2022-03-20",
		retrievedAt: "2026-10-04",
	},
	{ id: "undated-listing", publisher: "Example Listings", title: "Rental listing", retrievedAt: "2026-10-04" },
]

export const ENTITIES: Entity[] = [
	{ id: PARCEL, kind: "parcel", externalIDs: [{ namespace: "example:lot", value: "12-34" }], label: "Example Parcel" },
	{ id: HOUSE, kind: "building", externalIDs: [{ namespace: "example:bin", value: "1001" }], label: "Example House" },
	{ id: ANNEX, kind: "building", externalIDs: [{ namespace: "example:bin", value: "1002" }], label: "Example Annex" },
	{ id: NORTH, kind: "entrance", externalIDs: [], label: "North entrance" },
	{ id: SOUTH, kind: "entrance", externalIDs: [], label: "South entrance" },
]

export const ALIASES: Alias[] = [
	{
		text: "North entrance, Example House",
		candidates: [{ entity: NORTH, evidence: { source: "survey-2022", observedAt: "2022-03-15" } }],
	},
	{
		text: "South entrance, Example House",
		candidates: [{ entity: SOUTH, evidence: { source: "survey-2022", observedAt: "2022-03-15" } }],
	},
]

export const CONTAINMENT: Containment[] = [
	{
		child: NORTH,
		parent: HOUSE,
		relation: ContainmentRelation.EntranceOf,
		evidence: { source: "survey-2022", observedAt: "2022-03-15" },
	},
	{
		child: SOUTH,
		parent: HOUSE,
		relation: ContainmentRelation.EntranceOf,
		evidence: { source: "survey-2022", observedAt: "2022-03-15" },
	},
	{
		child: HOUSE,
		parent: PARCEL,
		relation: ContainmentRelation.BuildingOn,
		evidence: { source: "permit-2021", observedAt: "2021-05-10" },
	},
	{
		child: ANNEX,
		parent: PARCEL,
		relation: ContainmentRelation.BuildingOn,
		evidence: { source: "permit-2021", observedAt: "2021-05-10" },
	},
]
```

- [ ] **Step 2: Write the failing test**

`packages/dossier/lib/links.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { entityIndex } from "#entities"
import { buildingsOn, entrancesOf, resolveAlias } from "#links"
import { sourceIndex } from "#sources"
import {
	ALIASES,
	ANNEX,
	CONTAINMENT,
	ENTITIES,
	HOUSE,
	NORTH,
	PARCEL,
	SOURCES,
	SOUTH,
} from "#test/fixtures/example-house"

describe("two frontages", () => {
	test("both aliases resolve to distinct entrances of one building, each with its evidence", () => {
		const resolved = ALIASES.map(resolveAlias)

		expect(resolved).toEqual([
			{ kind: "resolved", entity: NORTH, evidence: { source: "survey-2022", observedAt: "2022-03-15" } },
			{ kind: "resolved", entity: SOUTH, evidence: { source: "survey-2022", observedAt: "2022-03-15" } },
		])
		expect(entrancesOf(HOUSE, CONTAINMENT).map((link) => link.child)).toEqual([NORTH, SOUTH])
		expect(ALIASES.map((alias) => alias.text)).toEqual([
			"North entrance, Example House",
			"South entrance, Example House",
		])
	})

	test("an alias with two candidates is ambiguous and keeps both", () => {
		const alias = { text: "Example House", candidates: [...ALIASES[0]!.candidates, ...ALIASES[1]!.candidates] }

		expect(resolveAlias(alias)).toEqual({ kind: "ambiguous", candidates: alias.candidates })
	})

	test("an alias with no candidate is unlinked", () => {
		expect(resolveAlias({ text: "Nowhere House", candidates: [] })).toEqual({ kind: "unlinked" })
	})
})

describe("shared parcel", () => {
	test("two buildings stand on the parcel and each keeps its identity", () => {
		expect(buildingsOn(PARCEL, CONTAINMENT).map((link) => link.child)).toEqual([HOUSE, ANNEX])
		expect(entityIndex(ENTITIES).get(ANNEX)?.externalIDs).toEqual([{ namespace: "example:bin", value: "1002" }])
	})
})

describe("indexes", () => {
	test("refuse a duplicate id", () => {
		expect(() => sourceIndex([...SOURCES, SOURCES[0]!])).toThrow(/duplicate source id permit-2021/)
		expect(() => entityIndex([...ENTITIES, ENTITIES[1]!])).toThrow(/duplicate entity id building:example-house/)
	})
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `yarn vitest run packages/dossier/lib/links.test.ts`
Expected: FAIL. `#sources`, `#entities` and `#links` cannot be resolved.

- [ ] **Step 4: Implement the three modules**

`packages/dossier/lib/sources.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A source record is the document a claim cites. It carries the publisher, a title, and the three time
 *   concepts, so a dossier can say when a fact was observed, when the record became available, and when
 *   this application read it.
 */

import type { SourceTime } from "#time"

export type SourceRecordID = string

export interface SourceRecord extends SourceTime {
	id: SourceRecordID
	publisher: string
	title: string
	url?: string
}

export function sourceIndex(records: readonly SourceRecord[]): ReadonlyMap<SourceRecordID, SourceRecord> {
	const index = new Map<SourceRecordID, SourceRecord>()

	for (const record of records) {
		if (index.has(record.id)) throw new Error(`sourceIndex: duplicate source id ${record.id}`)

		index.set(record.id, record)
	}

	return index
}
```

`packages/dossier/lib/entities.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The physical objects: a parcel holds buildings, a building has entrances and units. Each is its own
 *   entity with its own identifiers, so a count or a permission attaches to the object it describes.
 */

import type { EntityID, EntityKind, ExternalID } from "#identifiers"

export interface EntityBase {
	id: EntityID
	kind: EntityKind
	externalIDs: readonly ExternalID[]
	label: string
}

export interface Parcel extends EntityBase {
	kind: "parcel"
}

export interface Building extends EntityBase {
	kind: "building"
}

export interface Entrance extends EntityBase {
	kind: "entrance"
}

export interface Unit extends EntityBase {
	kind: "unit"
}

export type Entity = Parcel | Building | Entrance | Unit

export function entityIndex(entities: readonly Entity[]): ReadonlyMap<EntityID, Entity> {
	const index = new Map<EntityID, Entity>()

	for (const entity of entities) {
		if (index.has(entity.id)) throw new Error(`entityIndex: duplicate entity id ${entity.id}`)

		index.set(entity.id, entity)
	}

	return index
}
```

`packages/dossier/lib/links.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Aliases and containment. An alias is text that may refer to an entity; it resolves only when exactly
 *   one candidate carries evidence, and two candidates stay two. A containment link relates a child to a
 *   parent through one source record, so a parcel with two buildings keeps both.
 */

import type { PostalAddress } from "@mailwoman/record"

import type { EntityID } from "#identifiers"
import type { SourceRecordID } from "#sources"
import type { ClaimInterval, ISODate } from "#time"

export interface Evidence extends ClaimInterval {
	source: SourceRecordID
	observedAt?: ISODate
}

export interface AliasCandidate {
	entity: EntityID
	evidence: Evidence
}

export interface Alias {
	text: string
	address?: PostalAddress
	candidates: readonly AliasCandidate[]
}

export const ContainmentRelation = {
	EntranceOf: "entrance_of",
	UnitOf: "unit_of",
	BuildingOn: "building_on",
} as const

export type ContainmentRelation = (typeof ContainmentRelation)[keyof typeof ContainmentRelation]

export interface Containment {
	child: EntityID
	parent: EntityID
	relation: ContainmentRelation
	evidence: Evidence
}

export type AliasResolution =
	| { kind: "resolved"; entity: EntityID; evidence: Evidence }
	| { kind: "ambiguous"; candidates: readonly AliasCandidate[] }
	| { kind: "unlinked" }

export function resolveAlias(alias: Alias): AliasResolution {
	if (alias.candidates.length === 0) return { kind: "unlinked" }

	const distinct = new Set(alias.candidates.map((candidate) => candidate.entity))

	if (distinct.size > 1) return { kind: "ambiguous", candidates: alias.candidates }

	const [first] = alias.candidates

	return { kind: "resolved", entity: first!.entity, evidence: first!.evidence }
}

export function entrancesOf(building: EntityID, links: readonly Containment[]): readonly Containment[] {
	return links.filter((link) => link.parent === building && link.relation === ContainmentRelation.EntranceOf)
}

export function unitsOf(building: EntityID, links: readonly Containment[]): readonly Containment[] {
	return links.filter((link) => link.parent === building && link.relation === ContainmentRelation.UnitOf)
}

export function buildingsOn(parcel: EntityID, links: readonly Containment[]): readonly Containment[] {
	return links.filter((link) => link.parent === parcel && link.relation === ContainmentRelation.BuildingOn)
}
```

Add `export * from "#sources"`, `"#entities"`, `"#links"` to `lib/index.ts`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `yarn vitest run packages/dossier`
Expected: PASS, 18 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/dossier
git commit -m "Model parcels, buildings, entrances and units with sourced aliases and containment" -- packages/dossier
```

---

### Task 3: Claims and interpretable counts

**Files:**

- Create: `packages/dossier/lib/claims.ts`, `lib/claims.test.ts`, `lib/counts.ts`, `lib/counts.test.ts`

**Interfaces:**

- Produces from `#claims`: `const ClaimAxis = { Identity, Premises, Network, Access, Engineering, Product, Demand, Evidence }` with snake-case values, `interface ClaimBase<V> { id: string; subject: EntityID; axis: ClaimAxis; predicate: string; value: V; evidence: Evidence }`, `type Claim<V = unknown> = (ClaimBase<V> & { status: "designated" }) | (… "observed") | (… "derived"; derivedFrom: readonly string[]) | (… "inferred"; derivedFrom: readonly string[]; explanation: string)`, `claimsFor(subject, claims, axis?)`, `assertStatusDistinct()` is a type-level test only (see Step 1).
- Produces from `#counts`: `const UnitStage = { Planned: "planned", Completed: "completed", Occupied: "occupied" }`, `interface UnitCount { id: string; subject: EntityID; stage: UnitStage; count: number; at: ISODate; membership: string; evidence: Evidence }`, `type UnitTotal = { status: "resolved"; stage; at; total: number; parts: readonly UnitCount[] } | { status: "unresolved"; stage; at; reason: string; conflicting: readonly UnitCount[] }`, `totalUnits(counts: readonly UnitCount[], query: { subjects: readonly EntityID[]; stage: UnitStage; at: ISODate }): UnitTotal`, `countsByStage(counts, subject): Record<UnitStage, readonly UnitCount[]>`.

`membership` is a key the supplier states for the set of units a count covers (for example `"example-house:all"`); two counts with the same subject, stage, date and membership but different numbers conflict; counts with distinct subjects and distinct memberships sum.

Spec scenarios decided here: **Shared parcel** (12 + 8 = 20 completed units across two buildings) and **Conflicting counts** (24 planned, 20 completed, 18 occupied displayed separately; 20 versus 22 completed at the same date and scope stays unresolved).

- [ ] **Step 1: Write the failing tests**

`packages/dossier/lib/claims.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, expectTypeOf, test } from "vitest"

import { type Claim, ClaimAxis, claimsFor } from "#claims"
import { HOUSE } from "#test/fixtures/example-house"

const observed: Claim<number> = {
	id: "c1",
	subject: HOUSE,
	axis: ClaimAxis.Premises,
	predicate: "storeys",
	value: 13,
	status: "observed",
	evidence: { source: "permit-2021", observedAt: "2021-05-10" },
}

const inferred: Claim<string> = {
	id: "c2",
	subject: HOUSE,
	axis: ClaimAxis.Network,
	predicate: "nearest_cabinet_connects",
	value: "unknown",
	status: "inferred",
	derivedFrom: ["c1"],
	explanation: "A cabinet within 40 m is an observation of proximity, and connection requires its own record.",
	evidence: { source: "survey-2022" },
}

describe("Claim", () => {
	test("an inferred claim is a different union member from an observed one", () => {
		expectTypeOf<Extract<Claim, { status: "inferred" }>>().not.toEqualTypeOf<Extract<Claim, { status: "observed" }>>()
		expectTypeOf<Extract<Claim, { status: "inferred" }>>().toHaveProperty("explanation")
		expectTypeOf<Extract<Claim, { status: "observed" }>>().not.toHaveProperty("explanation")
	})

	test("claimsFor filters by subject and optionally by axis", () => {
		expect(claimsFor(HOUSE, [observed, inferred]).map((claim) => claim.id)).toEqual(["c1", "c2"])
		expect(claimsFor(HOUSE, [observed, inferred], ClaimAxis.Network).map((claim) => claim.id)).toEqual(["c2"])
	})
})
```

`packages/dossier/lib/counts.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { countsByStage, totalUnits, type UnitCount, UnitStage } from "#counts"
import { ANNEX, HOUSE } from "#test/fixtures/example-house"

const inspection = { source: "inspection-2022", observedAt: "2022-04-01" }

const SHARED: UnitCount[] = [
	{
		id: "u1",
		subject: HOUSE,
		stage: UnitStage.Completed,
		count: 12,
		at: "2022-04-01",
		membership: "example-house:all",
		evidence: inspection,
	},
	{
		id: "u2",
		subject: ANNEX,
		stage: UnitStage.Completed,
		count: 8,
		at: "2022-04-01",
		membership: "example-annex:all",
		evidence: inspection,
	},
]

describe("shared parcel", () => {
	test("sums two buildings' completed units when memberships are distinct", () => {
		const total = totalUnits(SHARED, { subjects: [HOUSE, ANNEX], stage: UnitStage.Completed, at: "2022-04-01" })

		expect(total).toEqual({ status: "resolved", stage: "completed", at: "2022-04-01", total: 20, parts: SHARED })
	})
})

describe("conflicting counts", () => {
	const planned: UnitCount = {
		id: "p",
		subject: HOUSE,
		stage: UnitStage.Planned,
		count: 24,
		at: "2021-05-10",
		membership: "example-house:all",
		evidence: { source: "permit-2021" },
	}
	const completed20: UnitCount = {
		id: "c20",
		subject: HOUSE,
		stage: UnitStage.Completed,
		count: 20,
		at: "2022-04-01",
		membership: "example-house:all",
		evidence: inspection,
	}
	const completed22: UnitCount = {
		id: "c22",
		subject: HOUSE,
		stage: UnitStage.Completed,
		count: 22,
		at: "2022-04-01",
		membership: "example-house:all",
		evidence: { source: "undated-listing" },
	}
	const occupied: UnitCount = {
		id: "o",
		subject: HOUSE,
		stage: UnitStage.Occupied,
		count: 18,
		at: "2023-02-01",
		membership: "example-house:all",
		evidence: { source: "manager-2023" },
	}

	test("keeps planned, completed and occupied apart", () => {
		const byStage = countsByStage([planned, completed20, occupied], HOUSE)

		expect(byStage.planned.map((count) => count.count)).toEqual([24])
		expect(byStage.completed.map((count) => count.count)).toEqual([20])
		expect(byStage.occupied.map((count) => count.count)).toEqual([18])
	})

	test("two completed counts at the same date and scope stay unresolved, never zero and never a sum", () => {
		const total = totalUnits([completed20, completed22], {
			subjects: [HOUSE],
			stage: UnitStage.Completed,
			at: "2022-04-01",
		})

		expect(total.status).toBe("unresolved")

		if (total.status === "unresolved") {
			expect(total.conflicting.map((count) => count.count)).toEqual([20, 22])
			expect(total.reason).toMatch(/same subject, stage, date and membership/)
		}
	})

	test("a planned count and a completed count with the same membership never combine", () => {
		const total = totalUnits([planned, completed20], {
			subjects: [HOUSE],
			stage: UnitStage.Completed,
			at: "2022-04-01",
		})

		expect(total).toMatchObject({ status: "resolved", total: 20 })
	})

	test("a query with no matching count is unresolved for want of a record", () => {
		const total = totalUnits([planned], { subjects: [HOUSE], stage: UnitStage.Occupied, at: "2022-04-01" })

		expect(total).toMatchObject({ status: "unresolved", reason: expect.stringMatching(/no occupied count/) })
	})

	test("two counts with the same membership key on different subjects are refused as overlapping", () => {
		const overlapping = { ...SHARED[1]!, membership: "example-house:all" }
		const total = totalUnits([SHARED[0]!, overlapping], {
			subjects: [HOUSE, ANNEX],
			stage: UnitStage.Completed,
			at: "2022-04-01",
		})

		expect(total).toMatchObject({
			status: "unresolved",
			reason: expect.stringMatching(/membership example-house:all is claimed by two subjects/),
		})
	})
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn vitest run packages/dossier/lib/claims.test.ts packages/dossier/lib/counts.test.ts`
Expected: FAIL. `#claims` and `#counts` cannot be resolved.

- [ ] **Step 3: Implement `claims.ts` and `counts.ts`**

`packages/dossier/lib/claims.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A claim is one statement about one entity on one axis, with the record that supports it and the
 *   status that says how it was established. The status is the discriminant of the union, so an inferred
 *   claim carries its explanation and derivation and can never be assigned where an observed claim is
 *   expected.
 */

import type { EpistemicStatus } from "@mailwoman/evidence"

import type { EntityID } from "#identifiers"
import type { Evidence } from "#links"

export const ClaimAxis = {
	Identity: "identity",
	Premises: "premises",
	Network: "network",
	Access: "access",
	Engineering: "engineering",
	Product: "product",
	Demand: "demand",
	Evidence: "evidence",
} as const

export type ClaimAxis = (typeof ClaimAxis)[keyof typeof ClaimAxis]

export interface ClaimBase<V> {
	id: string
	subject: EntityID
	axis: ClaimAxis
	predicate: string
	value: V
	evidence: Evidence
}

/**
 * The claim statuses a supplied record can carry. `unresolved` is a question, represented by
 * {@link Unresolved} in the dossier, and never a claim value.
 */
export type ClaimStatus = Exclude<EpistemicStatus, "unresolved">

export type Claim<V = unknown> =
	| (ClaimBase<V> & { status: "designated" })
	| (ClaimBase<V> & { status: "observed" })
	| (ClaimBase<V> & { status: "derived"; derivedFrom: readonly string[] })
	| (ClaimBase<V> & { status: "inferred"; derivedFrom: readonly string[]; explanation: string })

export function claimsFor(subject: EntityID, claims: readonly Claim[], axis?: ClaimAxis): readonly Claim[] {
	return claims.filter((claim) => claim.subject === subject && (axis === undefined || claim.axis === axis))
}
```

`packages/dossier/lib/counts.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit counts stay interpretable. Each count states what it counts (the stage), for which object, on
 *   which date, over which set of units (the membership key), and from which record. A total exists only
 *   when the contributing counts share stage and date and cover disjoint memberships; otherwise the
 *   result is unresolved and lists the counts that conflict.
 */

import type { EntityID } from "#identifiers"
import type { Evidence } from "#links"
import type { ISODate } from "#time"

export const UnitStage = {
	Planned: "planned",
	Completed: "completed",
	Occupied: "occupied",
} as const

export type UnitStage = (typeof UnitStage)[keyof typeof UnitStage]

export interface UnitCount {
	id: string
	subject: EntityID
	stage: UnitStage
	count: number
	at: ISODate
	/** The supplier's key for the set of units this count covers. Two counts over one key describe the same units. */
	membership: string
	evidence: Evidence
}

export type UnitTotal =
	| { status: "resolved"; stage: UnitStage; at: ISODate; total: number; parts: readonly UnitCount[] }
	| { status: "unresolved"; stage: UnitStage; at: ISODate; reason: string; conflicting: readonly UnitCount[] }

export interface UnitTotalQuery {
	subjects: readonly EntityID[]
	stage: UnitStage
	at: ISODate
}

export function countsByStage(
	counts: readonly UnitCount[],
	subject: EntityID
): Record<UnitStage, readonly UnitCount[]> {
	const mine = counts.filter((count) => count.subject === subject)

	return {
		planned: mine.filter((count) => count.stage === UnitStage.Planned),
		completed: mine.filter((count) => count.stage === UnitStage.Completed),
		occupied: mine.filter((count) => count.stage === UnitStage.Occupied),
	}
}

export function totalUnits(counts: readonly UnitCount[], query: UnitTotalQuery): UnitTotal {
	const subjects = new Set(query.subjects)
	const matching = counts.filter(
		(count) => subjects.has(count.subject) && count.stage === query.stage && count.at === query.at
	)
	const unresolved = (reason: string, conflicting: readonly UnitCount[]): UnitTotal => ({
		status: "unresolved",
		stage: query.stage,
		at: query.at,
		reason,
		conflicting,
	})

	if (matching.length === 0)
		return unresolved(`no ${query.stage} count on ${query.at} for ${[...subjects].join(", ")}`, [])

	const byMembership = new Map<string, UnitCount[]>()

	for (const count of matching)
		byMembership.set(count.membership, [...(byMembership.get(count.membership) ?? []), count])

	for (const [membership, group] of byMembership) {
		const subjectsInGroup = new Set(group.map((count) => count.subject))

		if (subjectsInGroup.size > 1) {
			return unresolved(
				`membership ${membership} is claimed by two subjects: ${[...subjectsInGroup].join(", ")}`,
				group
			)
		}

		const values = new Set(group.map((count) => count.count))

		if (values.size > 1) {
			return unresolved(
				`${group.length} counts share the same subject, stage, date and membership (${membership}) and disagree: ${[...values].join(" versus ")}`,
				group
			)
		}
	}

	const parts = [...byMembership.values()].map((group) => group[0]!)

	return {
		status: "resolved",
		stage: query.stage,
		at: query.at,
		total: parts.reduce((sum, count) => sum + count.count, 0),
		parts: matching,
	}
}
```

Add `export * from "#claims"` and `export * from "#counts"` to `lib/index.ts`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn vitest run packages/dossier`
Expected: PASS, 26 tests. The shared-parcel assertion compares `parts` to `SHARED`, so `parts` is the matching counts in input order.

- [ ] **Step 5: Commit**

```bash
git add packages/dossier
git commit -m "Add sourced claims on eight axes and unit totals that stay unresolved when counts conflict" -- packages/dossier
```

---

### Task 4: Commercial events and authority

**Files:**

- Create: `packages/dossier/lib/events.ts`, `lib/events.test.ts`

**Interfaces:**

- Produces: `const CommercialEventKind = { Inquiry: "inquiry", Commitment: "commitment", Order: "order", ActiveSubscription: "active_subscription", LandlordPermission: "landlord_permission", AcceptedBuild: "accepted_build" }`, `interface Party { name: string; role: string }`, `interface CommercialEvent { id: string; kind: CommercialEventKind; parties: readonly Party[]; scope: readonly EntityID[]; date?: ISODate; evidence: Evidence }`, `eventsByKind(events, kind): readonly CommercialEvent[]`, `activeSubscriptionsAt(events, subject, date): { count: number; events: readonly CommercialEvent[]; undated: readonly CommercialEvent[] }`, `permissionCovers(events, entity): readonly CommercialEvent[]`, `const OrganizationRole = { Owner: "owner", Manager: "manager", Developer: "developer", Architect: "architect", Contractor: "contractor", Lender: "lender" }`, `interface OrganizationRelation { organization: string; role: OrganizationRole; subject: EntityID; signingAuthority: "yes" | "no" | "unknown"; evidence: Evidence }`, `signingAuthorityFor(relations, subject): { known: readonly OrganizationRelation[]; unknown: readonly OrganizationRelation[] }`, `interface ConstructionWindow { subject: EntityID; start?: ISODate; end?: ISODate; stage: string; evidence: Evidence }`.

Spec scenarios decided here: **Separate customer events** (three households, three different events; permission scoped to the north entrance) and **Construction and authority** (a window from the permit, an owner and a manager, signing authority unknown for both).

- [ ] **Step 1: Write the failing test**

`packages/dossier/lib/events.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import {
	activeSubscriptionsAt,
	type CommercialEvent,
	CommercialEventKind,
	eventsByKind,
	type OrganizationRelation,
	OrganizationRole,
	permissionCovers,
	signingAuthorityFor,
} from "#events"
import { HOUSE, NORTH, SOUTH } from "#test/fixtures/example-house"

const EVENTS: CommercialEvent[] = [
	{
		id: "e1",
		kind: CommercialEventKind.Inquiry,
		parties: [{ name: "Household A", role: "resident" }],
		scope: [HOUSE],
		date: "2022-05-01",
		evidence: { source: "manager-2023" },
	},
	{
		id: "e2",
		kind: CommercialEventKind.Order,
		parties: [{ name: "Household B", role: "resident" }],
		scope: [HOUSE],
		date: "2022-05-02",
		evidence: { source: "manager-2023" },
	},
	{
		id: "e3",
		kind: CommercialEventKind.ActiveSubscription,
		parties: [{ name: "Household C", role: "resident" }],
		scope: [HOUSE],
		date: "2022-05-03",
		evidence: { source: "manager-2023" },
	},
	{
		id: "e4",
		kind: CommercialEventKind.LandlordPermission,
		parties: [{ name: "Example Management Co", role: "manager" }],
		scope: [NORTH],
		date: "2022-05-10",
		evidence: { source: "manager-2023" },
	},
	{
		id: "e5",
		kind: CommercialEventKind.ActiveSubscription,
		parties: [{ name: "Household D", role: "resident" }],
		scope: [HOUSE],
		evidence: { source: "undated-listing" },
	},
]

describe("separate customer events", () => {
	test("three households produce one event of each kind, and one active subscription", () => {
		expect(eventsByKind(EVENTS, CommercialEventKind.Inquiry).map((event) => event.id)).toEqual(["e1"])
		expect(eventsByKind(EVENTS, CommercialEventKind.Order).map((event) => event.id)).toEqual(["e2"])

		const active = activeSubscriptionsAt(EVENTS, HOUSE, "2022-06-30")

		expect(active.count).toBe(1)
		expect(active.events.map((event) => event.id)).toEqual(["e3"])
	})

	test("an undated active subscription is listed and never counted", () => {
		const active = activeSubscriptionsAt(EVENTS, HOUSE, "2022-06-30")

		expect(active.undated.map((event) => event.id)).toEqual(["e5"])
		expect(active.count).toBe(1)
	})

	test("a permission covers only the entrance in its scope", () => {
		expect(permissionCovers(EVENTS, NORTH).map((event) => event.id)).toEqual(["e4"])
		expect(permissionCovers(EVENTS, SOUTH)).toEqual([])
		expect(permissionCovers(EVENTS, HOUSE)).toEqual([])
	})
})

describe("construction and authority", () => {
	const relations: OrganizationRelation[] = [
		{
			organization: "Example Holdings LLC",
			role: OrganizationRole.Owner,
			subject: HOUSE,
			signingAuthority: "unknown",
			evidence: { source: "permit-2021" },
		},
		{
			organization: "Example Management Co",
			role: OrganizationRole.Manager,
			subject: HOUSE,
			signingAuthority: "unknown",
			evidence: { source: "manager-2023" },
		},
	]

	test("owner and manager roles are shown and signing authority stays unknown for both", () => {
		const authority = signingAuthorityFor(relations, HOUSE)

		expect(authority.known).toEqual([])
		expect(authority.unknown.map((relation) => relation.role)).toEqual(["owner", "manager"])
	})
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `yarn vitest run packages/dossier/lib/events.test.ts`
Expected: FAIL. `#events` cannot be resolved.

- [ ] **Step 3: Implement `events.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Commercial events and organizational roles. An inquiry, a commitment, an order, an active subscription,
 *   a landlord's permission and an accepted build are six different events, each with its own parties,
 *   physical scope and date. A permission reaches only the entities in its scope. An ownership or
 *   management record says who holds the role; signing authority is a separate fact that stays unknown
 *   until a record states it.
 */

import type { EntityID } from "#identifiers"
import type { Evidence } from "#links"
import { compareISODate, type ISODate } from "#time"

export const CommercialEventKind = {
	Inquiry: "inquiry",
	Commitment: "commitment",
	Order: "order",
	ActiveSubscription: "active_subscription",
	LandlordPermission: "landlord_permission",
	AcceptedBuild: "accepted_build",
} as const

export type CommercialEventKind = (typeof CommercialEventKind)[keyof typeof CommercialEventKind]

export interface Party {
	name: string
	role: string
}

export interface CommercialEvent {
	id: string
	kind: CommercialEventKind
	parties: readonly Party[]
	/** The entities the event applies to, and no wider. */
	scope: readonly EntityID[]
	date?: ISODate
	evidence: Evidence
}

export function eventsByKind(
	events: readonly CommercialEvent[],
	kind: CommercialEventKind
): readonly CommercialEvent[] {
	return events.filter((event) => event.kind === kind)
}

export interface ActiveSubscriptions {
	count: number
	events: readonly CommercialEvent[]
	/** Subscriptions without a date cannot be placed at the query date, so they are listed and never counted. */
	undated: readonly CommercialEvent[]
}

export function activeSubscriptionsAt(
	events: readonly CommercialEvent[],
	subject: EntityID,
	date: ISODate
): ActiveSubscriptions {
	const subscriptions = eventsByKind(events, CommercialEventKind.ActiveSubscription).filter((event) =>
		event.scope.includes(subject)
	)
	const undated = subscriptions.filter((event) => event.date === undefined)
	const active = subscriptions.filter((event) => event.date !== undefined && compareISODate(event.date, date) <= 0)

	return { count: active.length, events: active, undated }
}

export function permissionCovers(events: readonly CommercialEvent[], entity: EntityID): readonly CommercialEvent[] {
	return eventsByKind(events, CommercialEventKind.LandlordPermission).filter((event) => event.scope.includes(entity))
}

export const OrganizationRole = {
	Owner: "owner",
	Manager: "manager",
	Developer: "developer",
	Architect: "architect",
	Contractor: "contractor",
	Lender: "lender",
} as const

export type OrganizationRole = (typeof OrganizationRole)[keyof typeof OrganizationRole]

export interface OrganizationRelation {
	organization: string
	role: OrganizationRole
	subject: EntityID
	signingAuthority: "yes" | "no" | "unknown"
	evidence: Evidence
}

export function signingAuthorityFor(
	relations: readonly OrganizationRelation[],
	subject: EntityID
): { known: readonly OrganizationRelation[]; unknown: readonly OrganizationRelation[] } {
	const mine = relations.filter((relation) => relation.subject === subject)

	return {
		known: mine.filter((relation) => relation.signingAuthority !== "unknown"),
		unknown: mine.filter((relation) => relation.signingAuthority === "unknown"),
	}
}

export interface ConstructionWindow {
	subject: EntityID
	start?: ISODate
	end?: ISODate
	/** The stage the source states, such as `permit issued` or `rough-in`. */
	stage: string
	evidence: Evidence
}
```

Add `export * from "#events"` to `lib/index.ts`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn vitest run packages/dossier`
Expected: PASS, 30 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/dossier
git commit -m "Keep six commercial event kinds, permission scope and signing authority distinct" -- packages/dossier
```

---

### Task 5: Provider availability, coverage readings and the filing denominator

**Files:**

- Create: `packages/dossier/lib/availability.ts`, `lib/availability.test.ts`, `lib/coverage.ts`, `lib/coverage.test.ts`, `lib/filings.ts`, `lib/filings.test.ts`

**Interfaces:**

- Produces from `#availability`: `interface ProviderAvailability { provider: string; subject: EntityID; product: string; from: ISODate; to?: ISODate; evidence: Evidence }`, `availabilityAt(records, provider, subject, date): { status: "available" | "withdrawn" | "unknown"; records: readonly ProviderAvailability[] }`.
- Produces from `#coverage`: `interface LayerReading { layer: string; extent: string; basis: CoverageBasis | null; surveyedAt?: ISODate; records: number | null; evidence: Evidence }` (`records: null` means the layer has no survey for the extent), `const LayerReadingClass = { Unknown: "unknown", SurveyedEmpty: "surveyed_empty", SourcePresentEmpty: "source_present_empty", Records: "records", Conflicting: "conflicting" }`, `classifyReading(reading): LayerReadingClass`, `classifyReadings(readings: readonly LayerReading[]): { class: LayerReadingClass; readings }` where a positive reading beside an empty one is `conflicting`.
- Produces from `#filings`: `interface FilingRow { block: string; provider: string; technology: string; speedTier: string; evidence: Evidence }`, `distinctBlocks(rows): { blocks: number; buildings: "unknown"; units: "unknown"; subscribers: "unknown" }`.

Spec scenarios decided here: **Dated availability**, **Missing and empty coverage**, **US denominator control**.

- [ ] **Step 1: Write the failing tests**

`packages/dossier/lib/availability.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { availabilityAt, type ProviderAvailability } from "#availability"
import { HOUSE } from "#test/fixtures/example-house"

const RECORDS: ProviderAvailability[] = [
	{
		provider: "Example Fibre",
		subject: HOUSE,
		product: "1 Gbps",
		from: "2022-03-01",
		to: "2022-09-30",
		evidence: { source: "survey-2022" },
	},
]

describe("dated availability", () => {
	test("answers available inside the advertised interval", () => {
		expect(availabilityAt(RECORDS, "Example Fibre", HOUSE, "2022-06-30")).toEqual({
			status: "available",
			records: RECORDS,
		})
	})

	test("answers withdrawn after the product was withdrawn", () => {
		expect(availabilityAt(RECORDS, "Example Fibre", HOUSE, "2022-12-01").status).toBe("withdrawn")
	})

	test("answers unknown before the first record and for a provider with no record", () => {
		expect(availabilityAt(RECORDS, "Example Fibre", HOUSE, "2021-01-01").status).toBe("unknown")
		expect(availabilityAt(RECORDS, "Other Co", HOUSE, "2022-06-30")).toEqual({ status: "unknown", records: [] })
	})
})
```

`packages/dossier/lib/coverage.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { classifyReading, classifyReadings, type LayerReading, LayerReadingClass } from "#coverage"

const evidence = { source: "survey-2022" }

describe("missing and empty coverage", () => {
	const missing: LayerReading = { layer: "ducts", extent: "cell-1", basis: null, records: null, evidence }
	const surveyedEmpty: LayerReading = {
		layer: "cabinets",
		extent: "cell-1",
		basis: "surveyed",
		surveyedAt: "2022-03-15",
		records: 0,
		evidence,
	}
	const sourcePresentEmpty: LayerReading = {
		layer: "poles",
		extent: "cell-1",
		basis: "source_present",
		records: 0,
		evidence,
	}
	const positive: LayerReading = {
		layer: "cabinets",
		extent: "cell-1",
		basis: "source_present",
		records: 1,
		evidence: { source: "undated-listing" },
	}

	test("a layer with no survey is unknown", () => {
		expect(classifyReading(missing)).toBe(LayerReadingClass.Unknown)
	})

	test("zero records in a surveyed layer is surveyed empty", () => {
		expect(classifyReading(surveyedEmpty)).toBe(LayerReadingClass.SurveyedEmpty)
	})

	test("zero records in a source-present layer supports no exclusion", () => {
		expect(classifyReading(sourcePresentEmpty)).toBe(LayerReadingClass.SourcePresentEmpty)
	})

	test("a positive reading beside an empty one on the same layer and extent is conflicting", () => {
		expect(classifyReadings([surveyedEmpty, positive])).toEqual({
			class: LayerReadingClass.Conflicting,
			readings: [surveyedEmpty, positive],
		})
	})

	test("readings on different layers are classified separately", () => {
		expect(classifyReadings([missing, surveyedEmpty]).class).toBe(LayerReadingClass.Unknown)
	})
})
```

`packages/dossier/lib/filings.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { distinctBlocks, type FilingRow } from "#filings"

describe("US denominator control", () => {
	test("two speed groups in one block are one distinct block, and every other total stays unknown", () => {
		const rows: FilingRow[] = [
			{
				block: "360470001001000",
				provider: "Example Cable",
				technology: "cable",
				speedTier: "100/20",
				evidence: { source: "survey-2022" },
			},
			{
				block: "360470001001000",
				provider: "Example Cable",
				technology: "cable",
				speedTier: "1000/35",
				evidence: { source: "survey-2022" },
			},
		]

		expect(distinctBlocks(rows)).toEqual({ blocks: 1, buildings: "unknown", units: "unknown", subscribers: "unknown" })
	})
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn vitest run packages/dossier/lib/availability.test.ts packages/dossier/lib/coverage.test.ts packages/dossier/lib/filings.test.ts`
Expected: FAIL. The three modules cannot be resolved.

- [ ] **Step 3: Implement the three modules**

`packages/dossier/lib/availability.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Provider presence as a dated relation between a provider and an entity. The answer for a date is
 *   available, withdrawn or unknown; it says what the provider advertised and nothing about uptake.
 */

import type { EntityID } from "#identifiers"
import type { Evidence } from "#links"
import { compareISODate, type ISODate } from "#time"

export interface ProviderAvailability {
	provider: string
	subject: EntityID
	product: string
	from: ISODate
	to?: ISODate
	evidence: Evidence
}

export interface AvailabilityAnswer {
	status: "available" | "withdrawn" | "unknown"
	records: readonly ProviderAvailability[]
}

export function availabilityAt(
	records: readonly ProviderAvailability[],
	provider: string,
	subject: EntityID,
	date: ISODate
): AvailabilityAnswer {
	const mine = records.filter((record) => record.provider === provider && record.subject === subject)

	if (mine.length === 0) return { status: "unknown", records: [] }

	const current = mine.filter(
		(record) =>
			compareISODate(record.from, date) <= 0 && (record.to === undefined || compareISODate(date, record.to) <= 0)
	)

	if (current.length > 0) return { status: "available", records: mine }

	const past = mine.filter((record) => record.to !== undefined && compareISODate(date, record.to) > 0)

	return { status: past.length > 0 ? "withdrawn" : "unknown", records: mine }
}
```

`packages/dossier/lib/coverage.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A reading of one spatial layer over one extent. Zero records means absence only when the layer's
 *   coverage basis supports an exclusion; a `source_present` layer that found no record says the source
 *   looked, and absence stays unknown. A positive reading beside an empty one is a conflict to show.
 */

import { type CoverageBasis, supportsExclusion } from "@mailwoman/evidence"

import type { Evidence } from "#links"
import type { ISODate } from "#time"

export interface LayerReading {
	layer: string
	/** The surveyed extent as the layer states it, such as an H3 cell or a named area. */
	extent: string
	basis: CoverageBasis | null
	surveyedAt?: ISODate
	/** `null` when the layer has no survey for the extent. */
	records: number | null
	evidence: Evidence
}

export const LayerReadingClass = {
	Unknown: "unknown",
	SurveyedEmpty: "surveyed_empty",
	SourcePresentEmpty: "source_present_empty",
	Records: "records",
	Conflicting: "conflicting",
} as const

export type LayerReadingClass = (typeof LayerReadingClass)[keyof typeof LayerReadingClass]

export function classifyReading(reading: LayerReading): LayerReadingClass {
	if (reading.records === null) return LayerReadingClass.Unknown
	if (reading.records > 0) return LayerReadingClass.Records

	return supportsExclusion({ basis: reading.basis })
		? LayerReadingClass.SurveyedEmpty
		: LayerReadingClass.SourcePresentEmpty
}

/**
 * Classifies readings of one layer and extent together. Readings on other layers or extents are left out
 * of the combined class and should be classified by their own call.
 */
export function classifyReadings(readings: readonly LayerReading[]): {
	class: LayerReadingClass
	readings: readonly LayerReading[]
} {
	const [first] = readings

	if (!first) throw new Error("classifyReadings: no readings supplied")

	const same = readings.filter((reading) => reading.layer === first.layer && reading.extent === first.extent)
	const classes = new Set(same.map(classifyReading))

	if (classes.has(LayerReadingClass.Records) && classes.size > 1)
		return { class: LayerReadingClass.Conflicting, readings: same }

	return { class: classifyReading(first), readings: same }
}
```

`packages/dossier/lib/filings.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The US filing denominator control. A broadband filing row describes a provider, technology and speed
 *   tier for a census block; several rows can describe one block. The only count the rows support is the
 *   number of distinct blocks. Buildings, units and subscribers need their own records.
 */

import type { Evidence } from "#links"

export interface FilingRow {
	block: string
	provider: string
	technology: string
	speedTier: string
	evidence: Evidence
}

export interface FilingDenominators {
	blocks: number
	buildings: "unknown"
	units: "unknown"
	subscribers: "unknown"
}

export function distinctBlocks(rows: readonly FilingRow[]): FilingDenominators {
	return {
		blocks: new Set(rows.map((row) => row.block)).size,
		buildings: "unknown",
		units: "unknown",
		subscribers: "unknown",
	}
}
```

Add the three `export *` lines to `lib/index.ts`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn vitest run packages/dossier`
Expected: PASS, 39 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/dossier
git commit -m "Date provider availability, classify layer readings by coverage basis, and hold filing totals to blocks" -- packages/dossier
```

---

### Task 6: Validation, the as-of dossier, and the report

**Files:**

- Create: `packages/dossier/lib/validate.ts`, `lib/validate.test.ts`, `lib/dossier.ts`, `lib/dossier.test.ts`, `lib/report.ts`, `lib/report.test.ts`

**Interfaces:**

- Produces from `#validate`: `interface DossierRecords { sources; entities; aliases; containment; claims; counts; events; relations: OrganizationRelation[]; windows: ConstructionWindow[]; availability; readings; filings }` (every field a readonly array), `interface ValidationIssue { severity: "error" | "warning"; code: string; message: string; ref?: string }`, `validateRecords(records): readonly ValidationIssue[]`. Errors: a duplicate source or entity id; a claim, count, event, link or reading whose `evidence.source` is absent from `sources`; a containment whose child or parent is absent from `entities`; a date that fails `isISODate`. Warnings: a source without `availableAt`; an event without `date`; a relation with `signingAuthority: "unknown"`.
- Produces from `#dossier`: `interface Unresolved { question: string; subject?: EntityID; candidates: readonly string[]; missingRecord: string }`, `interface BuildingSection { building: Building; entrances; aliases: readonly { text: string; resolution: AliasResolution }[]; counts: Record<UnitStage, UnitTotal>; events: readonly CommercialEvent[]; permissions; authority; windows; availability: readonly { provider; product; answer: AvailabilityAnswer }[]; readings: readonly { layer; extent; class: LayerReadingClass }[]; claims: readonly Claim[]; unresolved: readonly Unresolved[] }`, `interface Dossier { asOf: ISODate; admitted: readonly SourceRecordID[]; excluded: readonly { id; availableAt; observedAt? }[]; undated: readonly SourceRecordID[]; buildings: readonly BuildingSection[]; unresolved: readonly Unresolved[]; issues: readonly ValidationIssue[] }`, `buildDossier(records: DossierRecords, options: { asOf: ISODate }): Dossier` (throws when `validateRecords` reports an error).
- Produces from `#report`: `renderReport(dossier: Dossier): string` (Markdown).

A record is admitted when `admitsAsOf(source, asOf)` is `admitted`; every claim, count, event, link, availability and reading whose evidence cites an excluded or undated source is left out of the sections and the source is listed under `excluded` or `undated`. An `Unresolved` is produced for: an ambiguous or unlinked alias; an unresolved unit total per stage; an unknown signing authority (one per relation); a construction window with no end; an availability answer of `unknown`; a reading classed `unknown`, `source_present_empty` or `conflicting`. Each states the record that would resolve it, in words a reader can act on (for example "a dated record naming the signatory for Example House").

- [ ] **Step 1: Write the failing tests**

`packages/dossier/lib/validate.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { validateRecords } from "#validate"
import { EMPTY_RECORDS, EXAMPLE_RECORDS } from "#test/fixtures/example-house"

describe("validateRecords", () => {
	test("the example records produce warnings only", () => {
		const issues = validateRecords(EXAMPLE_RECORDS)

		expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
		expect(issues.map((issue) => issue.code)).toContain("source_without_available_date")
		expect(issues.map((issue) => issue.code)).toContain("signing_authority_unknown")
	})

	test("a claim citing an unknown source is an error", () => {
		const issues = validateRecords({
			...EMPTY_RECORDS,
			sources: EXAMPLE_RECORDS.sources,
			entities: EXAMPLE_RECORDS.entities,
			claims: [
				{
					id: "x",
					subject: "building:example-house",
					axis: "premises",
					predicate: "storeys",
					value: 13,
					status: "observed",
					evidence: { source: "no-such-source" },
				},
			],
		})

		expect(issues).toContainEqual(expect.objectContaining({ severity: "error", code: "unknown_source", ref: "x" }))
	})

	test("a malformed date is an error", () => {
		const issues = validateRecords({
			...EMPTY_RECORDS,
			sources: [{ id: "s", publisher: "p", title: "t", availableAt: "03/01/2022" }],
		})

		expect(issues).toContainEqual(expect.objectContaining({ severity: "error", code: "malformed_date", ref: "s" }))
	})

	test("an event without a date is a warning", () => {
		expect(validateRecords(EXAMPLE_RECORDS)).toContainEqual(
			expect.objectContaining({ severity: "warning", code: "event_without_date", ref: "e5" })
		)
	})
})
```

Extend `test/fixtures/example-house.ts` with `EXAMPLE_RECORDS: DossierRecords` that assembles `SOURCES`, `ENTITIES`, `ALIASES`, `CONTAINMENT`, the counts, events, relations, window, availability and readings used in Tasks 3 to 5 (copy the literals from those tests into the fixture and have the tests import them), and `EMPTY_RECORDS: DossierRecords` with every array empty. Add a `ConstructionWindow` for `HOUSE`: `{ subject: HOUSE, start: "2021-06-01", stage: "permit issued", evidence: { source: "permit-2021" } }` with no `end`.

`packages/dossier/lib/dossier.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { buildDossier } from "#dossier"
import { EXAMPLE_RECORDS, HOUSE, NORTH } from "#test/fixtures/example-house"

describe("buildDossier as of 2022-06-30", () => {
	const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })
	const house = dossier.buildings.find((section) => section.building.id === HOUSE)!

	test("admits the permit, inspection and survey; excludes the 2023 statement; lists the undated listing", () => {
		expect(dossier.admitted).toEqual(["permit-2021", "inspection-2022", "survey-2022"])
		expect(dossier.excluded).toEqual([{ id: "manager-2023", availableAt: "2023-02-01", observedAt: "2023-02-01" }])
		expect(dossier.undated).toEqual(["undated-listing"])
	})

	test("the 2023 occupied count and the undated 22 do not reach the sections", () => {
		expect(house.counts.occupied).toMatchObject({
			status: "unresolved",
			reason: expect.stringMatching(/no occupied count/),
		})
		expect(house.counts.completed).toMatchObject({ status: "resolved", total: 20 })
	})

	test("the north entrance permission is scoped to the entrance", () => {
		expect(house.permissions.map((event) => event.scope)).toEqual([[NORTH]])
	})

	test("signing authority and the open construction window are unresolved with the record that would resolve them", () => {
		const questions = house.unresolved.map((item) => item.question)

		expect(questions).toContainEqual(expect.stringMatching(/signing authority.*Example Holdings LLC/))
		expect(questions).toContainEqual(expect.stringMatching(/construction window.*no end/))
		expect(house.unresolved.every((item) => item.missingRecord.length > 0)).toBe(true)
	})

	test("a record observed before the cutoff but available after it is excluded", () => {
		const late = buildDossier(
			{
				...EXAMPLE_RECORDS,
				sources: [
					...EXAMPLE_RECORDS.sources,
					{ id: "late", publisher: "p", title: "t", observedAt: "2022-01-01", availableAt: "2022-12-01" },
				],
			},
			{ asOf: "2022-06-30" }
		)

		expect(late.excluded).toContainEqual({ id: "late", availableAt: "2022-12-01", observedAt: "2022-01-01" })
	})

	test("refuses records with a validation error", () => {
		expect(() =>
			buildDossier(
				{
					...EXAMPLE_RECORDS,
					containment: [
						{ child: "entrance:ghost", parent: HOUSE, relation: "entrance_of", evidence: { source: "survey-2022" } },
					],
				},
				{ asOf: "2022-06-30" }
			)
		).toThrow(/unknown_entity/)
	})
})

describe("buildDossier as of 2023-06-30", () => {
	test("admits the manager statement and resolves the occupied count", () => {
		const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2023-06-30" })
		const house = dossier.buildings.find((section) => section.building.id === HOUSE)!

		expect(house.counts.occupied).toMatchObject({ status: "resolved", total: 18 })
	})
})
```

`packages/dossier/lib/report.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { buildDossier } from "#dossier"
import { renderReport } from "#report"
import { EXAMPLE_RECORDS } from "#test/fixtures/example-house"

describe("renderReport", () => {
	const report = renderReport(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }))

	test("states the cutoff and the admitted, excluded and undated records", () => {
		expect(report).toContain("as of 2022-06-30")
		expect(report).toContain("manager-2023")
		expect(report).toMatch(/undated.*undated-listing/i)
	})

	test("shows each building's counts by stage, with unresolved totals worded as unresolved", () => {
		expect(report).toMatch(/Example House/)
		expect(report).toMatch(/completed.*20/)
		expect(report).toMatch(/occupied.*unresolved/)
	})

	test("words a source-present empty reading as unknown absence", () => {
		expect(report).toMatch(/looked and found no record; absence is unknown/)
	})

	test("lists each unresolved question with the record that would resolve it", () => {
		expect(report).toMatch(/signing authority[\s\S]*would resolve/)
	})
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn vitest run packages/dossier`
Expected: FAIL. `#validate`, `#dossier`, `#report` cannot be resolved, and the fixture lacks `EXAMPLE_RECORDS`.

- [ ] **Step 3: Implement `validate.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Validation of supplied records before a dossier is built. An error is a record the dossier cannot use
 *   (a dangling reference, a duplicate id, a malformed date); a warning is a record the dossier will use
 *   with a stated limit (no availability date, no event date, unknown signing authority).
 */

import type { ProviderAvailability } from "#availability"
import type { Claim } from "#claims"
import type { UnitCount } from "#counts"
import type { LayerReading } from "#coverage"
import type { Entity } from "#entities"
import type { CommercialEvent, ConstructionWindow, OrganizationRelation } from "#events"
import type { FilingRow } from "#filings"
import type { Alias, Containment } from "#links"
import type { SourceRecord } from "#sources"
import { isISODate } from "#time"

export interface DossierRecords {
	sources: readonly SourceRecord[]
	entities: readonly Entity[]
	aliases: readonly Alias[]
	containment: readonly Containment[]
	claims: readonly Claim[]
	counts: readonly UnitCount[]
	events: readonly CommercialEvent[]
	relations: readonly OrganizationRelation[]
	windows: readonly ConstructionWindow[]
	availability: readonly ProviderAvailability[]
	readings: readonly LayerReading[]
	filings: readonly FilingRow[]
}

export interface ValidationIssue {
	severity: "error" | "warning"
	code: string
	message: string
	ref?: string
}

export function validateRecords(records: DossierRecords): readonly ValidationIssue[] {
	const issues: ValidationIssue[] = []
	const sources = new Set<string>()
	const entities = new Set<string>()

	for (const source of records.sources) {
		if (sources.has(source.id))
			issues.push({
				severity: "error",
				code: "duplicate_source",
				message: `source ${source.id} appears twice`,
				ref: source.id,
			})

		sources.add(source.id)

		for (const [field, value] of Object.entries({
			observedAt: source.observedAt,
			availableAt: source.availableAt,
			retrievedAt: source.retrievedAt,
		})) {
			if (value !== undefined && !isISODate(value)) {
				issues.push({
					severity: "error",
					code: "malformed_date",
					message: `source ${source.id} ${field} ${value} is not an ISO 8601 date`,
					ref: source.id,
				})
			}
		}

		if (source.availableAt === undefined) {
			issues.push({
				severity: "warning",
				code: "source_without_available_date",
				message: `source ${source.id} has no availability date and is undated in every as-of dossier`,
				ref: source.id,
			})
		}
	}

	for (const entity of records.entities) {
		if (entities.has(entity.id))
			issues.push({
				severity: "error",
				code: "duplicate_entity",
				message: `entity ${entity.id} appears twice`,
				ref: entity.id,
			})

		entities.add(entity.id)
	}

	const checkSource = (ref: string, source: string) => {
		if (!sources.has(source))
			issues.push({
				severity: "error",
				code: "unknown_source",
				message: `${ref} cites source ${source}, which is not supplied`,
				ref,
			})
	}
	const checkEntity = (ref: string, entity: string) => {
		if (!entities.has(entity))
			issues.push({
				severity: "error",
				code: "unknown_entity",
				message: `${ref} refers to entity ${entity}, which is not supplied`,
				ref,
			})
	}
	const checkDate = (ref: string, field: string, value: string | undefined) => {
		if (value !== undefined && !isISODate(value))
			issues.push({
				severity: "error",
				code: "malformed_date",
				message: `${ref} ${field} ${value} is not an ISO 8601 date`,
				ref,
			})
	}

	records.aliases.forEach((alias, index) =>
		alias.candidates.forEach((candidate) => {
			checkSource(`alias ${index}`, candidate.evidence.source)
			checkEntity(`alias ${index}`, candidate.entity)
		})
	)
	records.containment.forEach((link, index) => {
		checkSource(`containment ${index}`, link.evidence.source)
		checkEntity(`containment ${index}`, link.child)
		checkEntity(`containment ${index}`, link.parent)
	})
	for (const claim of records.claims) {
		checkSource(claim.id, claim.evidence.source)
		checkEntity(claim.id, claim.subject)
	}
	for (const count of records.counts) {
		checkSource(count.id, count.evidence.source)
		checkEntity(count.id, count.subject)
		checkDate(count.id, "at", count.at)
	}
	for (const event of records.events) {
		checkSource(event.id, event.evidence.source)
		event.scope.forEach((entity) => checkEntity(event.id, entity))
		checkDate(event.id, "date", event.date)

		if (event.date === undefined)
			issues.push({
				severity: "warning",
				code: "event_without_date",
				message: `event ${event.id} has no date and is never counted`,
				ref: event.id,
			})
	}
	records.relations.forEach((relation, index) => {
		checkSource(`relation ${index}`, relation.evidence.source)
		checkEntity(`relation ${index}`, relation.subject)

		if (relation.signingAuthority === "unknown") {
			issues.push({
				severity: "warning",
				code: "signing_authority_unknown",
				message: `${relation.organization} holds the ${relation.role} role for ${relation.subject}; signing authority is unknown`,
				ref: `relation ${index}`,
			})
		}
	})
	records.windows.forEach((window, index) => {
		checkSource(`window ${index}`, window.evidence.source)
		checkEntity(`window ${index}`, window.subject)
		checkDate(`window ${index}`, "start", window.start)
		checkDate(`window ${index}`, "end", window.end)
	})
	records.availability.forEach((record, index) => {
		checkSource(`availability ${index}`, record.evidence.source)
		checkEntity(`availability ${index}`, record.subject)
		checkDate(`availability ${index}`, "from", record.from)
		checkDate(`availability ${index}`, "to", record.to)
	})
	records.readings.forEach((reading, index) => checkSource(`reading ${index}`, reading.evidence.source))
	records.filings.forEach((row, index) => checkSource(`filing ${index}`, row.evidence.source))

	return issues
}
```

- [ ] **Step 4: Implement `dossier.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The as-of projection. Records are admitted by their availability date, so a dossier for a 2022
 *   decision contains what a reader could have known in 2022. Each building section assembles the
 *   admitted identity, count, event, authority, window, availability and reading evidence, and lists each
 *   unresolved question beside the record that would resolve it.
 */

import { availabilityAt, type AvailabilityAnswer } from "#availability"
import { type Claim, claimsFor } from "#claims"
import { totalUnits, type UnitStage, type UnitTotal } from "#counts"
import { classifyReadings, type LayerReadingClass } from "#coverage"
import type { Building } from "#entities"
import {
	type CommercialEvent,
	type ConstructionWindow,
	type OrganizationRelation,
	permissionCovers,
	signingAuthorityFor,
} from "#events"
import type { EntityID } from "#identifiers"
import { type AliasResolution, type Containment, entrancesOf, resolveAlias } from "#links"
import type { SourceRecordID } from "#sources"
import { admitsAsOf, type ISODate } from "#time"
import { type DossierRecords, validateRecords, type ValidationIssue } from "#validate"

export interface Unresolved {
	question: string
	subject?: EntityID
	candidates: readonly string[]
	/** The record that would resolve the question, in words a reader can act on. */
	missingRecord: string
}

export interface BuildingSection {
	building: Building
	entrances: readonly Containment[]
	aliases: readonly { text: string; resolution: AliasResolution }[]
	counts: Record<UnitStage, UnitTotal>
	events: readonly CommercialEvent[]
	permissions: readonly CommercialEvent[]
	authority: ReturnType<typeof signingAuthorityFor>
	windows: readonly ConstructionWindow[]
	availability: readonly { provider: string; product: string; answer: AvailabilityAnswer }[]
	readings: readonly { layer: string; extent: string; class: LayerReadingClass }[]
	claims: readonly Claim[]
	unresolved: readonly Unresolved[]
}

export interface Dossier {
	asOf: ISODate
	admitted: readonly SourceRecordID[]
	excluded: readonly { id: SourceRecordID; availableAt: ISODate; observedAt?: ISODate }[]
	undated: readonly SourceRecordID[]
	buildings: readonly BuildingSection[]
	unresolved: readonly Unresolved[]
	issues: readonly ValidationIssue[]
}

const STAGES: readonly UnitStage[] = ["planned", "completed", "occupied"]

export function buildDossier(records: DossierRecords, options: { asOf: ISODate }): Dossier {
	const issues = validateRecords(records)
	const errors = issues.filter((issue) => issue.severity === "error")

	if (errors.length > 0)
		throw new Error(`buildDossier: ${errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`)

	const admitted: SourceRecordID[] = []
	const excluded: Dossier["excluded"] = []
	const undated: SourceRecordID[] = []

	for (const source of records.sources) {
		const admission = admitsAsOf(source, options.asOf)

		if (admission === "admitted") admitted.push(source.id)
		else if (admission === "excluded")
			excluded.push({ id: source.id, availableAt: source.availableAt!, observedAt: source.observedAt })
		else undated.push(source.id)
	}

	const admittedSet = new Set(admitted)
	const admittedOnly = <T extends { evidence: { source: SourceRecordID } }>(items: readonly T[]): readonly T[] =>
		items.filter((item) => admittedSet.has(item.evidence.source))

	const containment = admittedOnly(records.containment)
	const counts = admittedOnly(records.counts)
	const events = admittedOnly(records.events)
	const relations = admittedOnly(records.relations)
	const windows = admittedOnly(records.windows)
	const availability = admittedOnly(records.availability)
	const readings = admittedOnly(records.readings)
	const claims = admittedOnly(records.claims)
	const aliases = records.aliases.map((alias) => ({ ...alias, candidates: admittedOnly(alias.candidates) }))

	const buildings = records.entities.filter((entity): entity is Building => entity.kind === "building")
	const sections = buildings.map((building) =>
		sectionFor(building, options.asOf, {
			containment,
			counts,
			events,
			relations,
			windows,
			availability,
			readings,
			claims,
			aliases,
		})
	)

	return {
		asOf: options.asOf,
		admitted,
		excluded,
		undated,
		buildings: sections,
		unresolved: sections.flatMap((section) => section.unresolved),
		issues,
	}
}

interface Admitted {
	containment: readonly Containment[]
	counts: DossierRecords["counts"]
	events: readonly CommercialEvent[]
	relations: readonly OrganizationRelation[]
	windows: readonly ConstructionWindow[]
	availability: DossierRecords["availability"]
	readings: DossierRecords["readings"]
	claims: readonly Claim[]
	aliases: DossierRecords["aliases"]
}

function sectionFor(building: Building, asOf: ISODate, admitted: Admitted): BuildingSection {
	const unresolved: Unresolved[] = []
	const entrances = entrancesOf(building.id, admitted.containment)
	const mine = new Set<EntityID>([building.id, ...entrances.map((link) => link.child)])

	const aliases = admitted.aliases
		.filter((alias) => alias.candidates.some((candidate) => mine.has(candidate.entity)))
		.map((alias) => {
			const resolution = resolveAlias(alias)

			if (resolution.kind === "ambiguous") {
				unresolved.push({
					question: `Which entity does the alias "${alias.text}" refer to?`,
					subject: building.id,
					candidates: resolution.candidates.map((candidate) => candidate.entity),
					missingRecord: `a source that links "${alias.text}" to one of ${resolution.candidates.map((candidate) => candidate.entity).join(", ")}`,
				})
			}

			return { text: alias.text, resolution }
		})

	const counts = Object.fromEntries(
		STAGES.map((stage) => {
			const dates = admitted.counts
				.filter((count) => count.subject === building.id && count.stage === stage)
				.map((count) => count.at)
			const latest = dates.sort().at(-1) ?? asOf
			const total = totalUnits(admitted.counts, { subjects: [building.id], stage, at: latest })

			if (total.status === "unresolved") {
				unresolved.push({
					question: `How many ${stage} units does ${building.label} have?`,
					subject: building.id,
					candidates: total.conflicting.map((count) => `${count.count} (${count.evidence.source})`),
					missingRecord:
						total.conflicting.length > 0
							? `a record that settles ${total.reason}`
							: `a dated ${stage} unit count for ${building.label}`,
				})
			}

			return [stage, total]
		})
	) as Record<UnitStage, UnitTotal>

	const events = admitted.events.filter((event) => event.scope.some((entity) => mine.has(entity)))
	const permissions = [...mine].flatMap((entity) => permissionCovers(admitted.events, entity))
	const authority = signingAuthorityFor(admitted.relations, building.id)

	for (const relation of authority.unknown) {
		unresolved.push({
			question: `Does ${relation.organization} (${relation.role}) hold signing authority for ${building.label}?`,
			subject: building.id,
			candidates: [],
			missingRecord: `a dated record naming the signatory for ${building.label}`,
		})
	}

	const windows = admitted.windows.filter((window) => window.subject === building.id)

	for (const window of windows) {
		if (window.end === undefined) {
			unresolved.push({
				question: `When does the construction window that opened ${window.start ?? "on an unknown date"} (${window.stage}) close? The record states no end.`,
				subject: building.id,
				candidates: [],
				missingRecord: `a completion or occupancy record for ${building.label}`,
			})
		}
	}

	const providers = new Map<string, string>()

	for (const record of admitted.availability)
		if (record.subject === building.id) providers.set(record.provider, record.product)

	const availability = [...providers].map(([provider, product]) => {
		const answer = availabilityAt(admitted.availability, provider, building.id, asOf)

		if (answer.status === "unknown") {
			unresolved.push({
				question: `Was ${provider} available at ${building.label} on ${asOf}?`,
				subject: building.id,
				candidates: [],
				missingRecord: `a dated availability record from ${provider} covering ${asOf}`,
			})
		}

		return { provider, product, answer }
	})

	const byLayer = new Map<string, DossierRecords["readings"]>()

	for (const reading of admitted.readings) {
		const key = `${reading.layer}\u0001${reading.extent}`

		byLayer.set(key, [...(byLayer.get(key) ?? []), reading])
	}

	const readings = [...byLayer.values()].map((group) => {
		const classified = classifyReadings(group)
		const [first] = group

		if (classified.class !== "records" && classified.class !== "surveyed_empty") {
			unresolved.push({
				question: `What does the ${first!.layer} layer hold for ${first!.extent}?`,
				subject: building.id,
				candidates: group.map((reading) => `${reading.records ?? "no survey"} (${reading.evidence.source})`),
				missingRecord: `a surveyed or designated reading of ${first!.layer} over ${first!.extent}`,
			})
		}

		return { layer: first!.layer, extent: first!.extent, class: classified.class }
	})

	return {
		building,
		entrances,
		aliases,
		counts,
		events,
		permissions,
		authority,
		windows,
		availability,
		readings,
		claims: claimsFor(building.id, admitted.claims),
		unresolved,
	}
}
```

The implementer adjusts the reading-to-building association if the fixture gives readings an explicit subject; the brief above associates every admitted reading with every building, which is acceptable for the single-extent fixtures and must be stated in the report file as a limit for #2289 to refine.

- [ ] **Step 5: Implement `report.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The report an operator reads. Every section states what the admitted records support and lists each
 *   unresolved question with the record that would resolve it. Wording rules: an unresolved total is
 *   written as unresolved with its conflicting values; a source-present empty reading is written as the
 *   source having looked, with absence unknown.
 */

import type { UnitTotal } from "#counts"
import { LayerReadingClass } from "#coverage"
import type { Dossier } from "#dossier"

function totalLine(stage: string, total: UnitTotal): string {
	if (total.status === "resolved")
		return `- ${stage}: ${total.total} on ${total.at} (${total.parts.map((part) => part.evidence.source).join(", ")})`

	const values = total.conflicting.map((count) => `${count.count} per ${count.evidence.source}`).join("; ")

	return `- ${stage}: unresolved — ${total.reason}${values ? ` (${values})` : ""}`
}

function readingLine(reading: { layer: string; extent: string; class: LayerReadingClass }): string {
	switch (reading.class) {
		case LayerReadingClass.Records:
			return `- ${reading.layer} over ${reading.extent}: records present`
		case LayerReadingClass.SurveyedEmpty:
			return `- ${reading.layer} over ${reading.extent}: surveyed, zero records; absence is established for the surveyed extent`
		case LayerReadingClass.SourcePresentEmpty:
			return `- ${reading.layer} over ${reading.extent}: the source looked and found no record; absence is unknown`
		case LayerReadingClass.Conflicting:
			return `- ${reading.layer} over ${reading.extent}: conflicting readings; see unresolved questions`
		case LayerReadingClass.Unknown:
			return `- ${reading.layer} over ${reading.extent}: no survey; unknown`
	}
}

export function renderReport(dossier: Dossier): string {
	const lines: string[] = [`# Building dossier as of ${dossier.asOf}`, ""]

	lines.push("## Records", "", `Admitted (${dossier.admitted.length}): ${dossier.admitted.join(", ") || "none"}`)
	lines.push(
		`Excluded, available after the cutoff (${dossier.excluded.length}): ${dossier.excluded.map((record) => `${record.id} (available ${record.availableAt})`).join(", ") || "none"}`
	)
	lines.push(`Undated, no availability date (${dossier.undated.length}): ${dossier.undated.join(", ") || "none"}`, "")

	for (const section of dossier.buildings) {
		lines.push(`## ${section.building.label}`, "")
		lines.push(
			`Identifiers: ${section.building.externalIDs.map((id) => `${id.namespace} ${id.value}`).join(", ") || "application id only"}`
		)
		lines.push(
			`Entrances: ${section.entrances.length}; aliases: ${section.aliases.map((alias) => `"${alias.text}" (${alias.resolution.kind})`).join(", ") || "none"}`,
			""
		)
		lines.push("### Units", "", ...Object.entries(section.counts).map(([stage, total]) => totalLine(stage, total)), "")
		lines.push(
			"### Events",
			"",
			...section.events.map(
				(event) =>
					`- ${event.kind} on ${event.date ?? "an unknown date"} (${event.parties.map((party) => party.name).join(", ")}; scope ${event.scope.join(", ")})`
			),
			""
		)
		lines.push(
			"### Access",
			"",
			`Permissions: ${section.permissions.map((event) => `${event.parties[0]?.name ?? "unnamed"} for ${event.scope.join(", ")}`).join("; ") || "none on record"}`
		)
		lines.push(
			`Roles with known signing authority: ${section.authority.known.map((relation) => `${relation.organization} (${relation.role}, ${relation.signingAuthority})`).join("; ") || "none"}`
		)
		lines.push(
			`Roles with unknown signing authority: ${section.authority.unknown.map((relation) => `${relation.organization} (${relation.role})`).join("; ") || "none"}`,
			""
		)
		lines.push(
			"### Construction",
			"",
			...section.windows.map(
				(window) =>
					`- ${window.stage}: ${window.start ?? "unknown start"} to ${window.end ?? "no end stated"} (${window.evidence.source})`
			),
			""
		)
		lines.push(
			"### Providers",
			"",
			...section.availability.map(
				(entry) => `- ${entry.provider} ${entry.product}: ${entry.answer.status} on ${dossier.asOf}`
			),
			""
		)
		lines.push("### Layer readings", "", ...section.readings.map(readingLine), "")
		lines.push("### Unresolved", "")

		for (const item of section.unresolved) {
			lines.push(`- ${item.question}`)

			if (item.candidates.length > 0) lines.push(`  - candidates: ${item.candidates.join("; ")}`)

			lines.push(`  - would resolve: ${item.missingRecord}`)
		}

		lines.push("")
	}

	return lines.join("\n")
}
```

Add `export * from "#validate"`, `"#dossier"`, `"#report"` to `lib/index.ts`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `yarn vitest run packages/dossier`
Expected: PASS for every file. If `dossier.test.ts`'s admitted list differs in order, keep the input order of `records.sources`.

- [ ] **Step 7: Commit**

```bash
git add packages/dossier
git commit -m "Build an as-of dossier from validated records and render the operator report" -- packages/dossier
```

---

### Task 7: Repository checks, documentation and the issue task list

**Files:**

- Modify: `docs/superpowers/specs/2026-10-04-building-dossier-contract-inventory.md` (status line: "awaiting implementation" → the package name and the dossier's limits), `packages/dossier/README.md` (a worked example rendering the Example House report)

- [ ] **Step 1: Run every check on the tree**

Run: `yarn lint && yarn typecheck && yarn test`
Expected: each exits 0. `yarn lint` includes the repository-health checks that read the new workspace (`workspace-exports`, `workspace-files`, `nested-index`, `test-layout`, `no-cross-package-reexport`); fix each finding in `packages/dossier`. Also run the release-kit workspace check from `packages/release-kit/AGENTS.md` line 51 and `yarn vitest run packages/release-kit` and report their output.

- [ ] **Step 2: Update the spec status and the README**

In the inventory spec, replace "The proposed data model and cases below are awaiting implementation." with a sentence stating that `@mailwoman/dossier` implements the extension and the eight cases, and that readings are associated with every building in the dossier until #2289 adds a spatial key. In `README.md`, add the Markdown output of `renderReport(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }))`, captured from a run of a one-line script kept in the scratchpad directory.

Run `yarn vale --config config/vale/.vale.ini docs/superpowers/specs/2026-10-04-building-dossier-contract-inventory.md packages/dossier/README.md` and fix findings.

- [ ] **Step 3: Commit**

```bash
git add packages/dossier/README.md docs/superpowers/specs/2026-10-04-building-dossier-contract-inventory.md
git commit -m "Record the dossier package in the inventory and show the Example House report" -- packages/dossier/README.md docs/superpowers/specs/2026-10-04-building-dossier-contract-inventory.md
```

- [ ] **Step 4: Issue bookkeeping (controller)**

Through `mwdev_issue update_tasks` on #2285, check: fixtures for aliases/frontages, buildings on a parcel and conflicting counts; the six distinct events; provider presence as dated relations; the dossier explaining blockers, timing and next action. The "Inventory" item is already checked. Through `mwdev_issue append_comment` on #2291, check the second definition-of-done item ("A bounded set of synthetic ... building cases") by `update_tasks` with the test file paths as evidence.

---

## After the plan

Two operator steps remain, both outside the plan's reach:

1. `mwops release bless-package` for `@mailwoman/dossier`, then move `packages/dossier` from `SANCTIONED_RELEASE_ABSENCES` to `.release-it.json` (and update the `publishCount` pin from 60 to 61).
2. The One Park Point records: #2286 supplies independently retrieved sources with their three dates; when they exist, a fixture under `packages/dossier/test/fixtures/one-park-point.ts` produces the first real report, with `asOf` set to the 2022 decision date the operator chooses.
