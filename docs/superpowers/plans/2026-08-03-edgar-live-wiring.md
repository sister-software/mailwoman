# EDGAR Live Wiring Implementation Plan

> **For agentic workers:** required sub-skill: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@mailwoman/filer`'s EDGAR chain work against real SEC filings. The parser currently recovers 45 subsidiaries from 13 real Exhibit 21 documents that list 142, and 18 of those 45 are fabricated.

**Architecture:** Phase 3b built the EDGAR chain as separately testable pieces (`sec-client.ts` → `edgar-filings.ts` → `exhibit21.ts` → `buildFilerDatabase({edgarRows})`) and verified each against hand-written fixtures. On 2026-08-03 the assembled chain ran against 24 real telecom registrants, and the results showed that the fixtures were not representative. 10 of 21 reachable filings yielded zero subsidiaries. The filings that yielded results included header rows, SGML wrapper tokens and bullet characters as subsidiary names. This plan vendors the real documents as fixtures and fixes `parseExhibit21` against them. It also adds the one missing link in the chain, which finds the Exhibit 21 document within a filing.

**Tech Stack:** TypeScript (`erasableSyntaxOnly`, without `enum`), vitest. The plan adds no HTML-parser dependency, so `@mailwoman/filer`'s runtime deps stay `@mailwoman/*` + kysely + type-fest.

## Global Constraints

- **Decision 6 applies everywhere: abstain, never guess.** A row or line that cannot be confidently reduced to a subsidiary name is counted in `unparseable` and dropped. Every new rule below either abstains or aligns columns, and none of them invents a value.
- **Every emitted value must be a substring of the document.** Each emitted `name`/`jurisdiction` must appear in the document as a contiguous string after tags are stripped, entities decoded and whitespace collapsed. This check is necessary but not sufficient. `exhibit21-real.test.ts` has fabrication assertions because the 2026-08-03 run emitted `"EX-21.1"`, `"3"`, `"q42025exh211listofsubsidia.htm"` and `"•"` as subsidiary names, and all of them pass the substring check.
- **`filer/test-fixtures/edgar/expected.json` is the interface, and it was not derived from `parseExhibit21`.** It came from an independent DOM-based reference implementation and was hand-checked against the source documents. Do not edit it to match implementation output. If you believe an expectation is wrong, say so in your report and stop. Editing it without saying so would turn the regression suite into a record of whatever the code does.
- Do not use `enum` (`erasableSyntaxOnly`). Acronyms are whole components in identifiers (`CIK`, `SEC`, `HTML`, `SGML`, `URL`).
- Use tabs for indentation and double quotes, and omit semicolons, matching the surrounding file exactly.
- `yarn typecheck:tests` must pass alongside `yarn vitest run filer/`, because neither vitest nor `tsc -b` checks `satisfies` pins in test files.
- Run `yarn vitest run filer/` (350 tests green at branch point) before reporting done. No test may be deleted or weakened to pass.

---

## File Structure

| File                                      | Responsibility                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filer/test-fixtures/edgar/*.htm` (13)    | Real EDGAR Exhibit 21 documents, vendored verbatim including the SGML `<DOCUMENT>` wrapper EDGAR serves them inside. **Already committed by Task 1 — do not modify.** |
| `filer/test-fixtures/edgar/manifest.json` | Provenance: registrant, CIK, accession, filing date, source URL, shape note. **Already committed — do not modify.**                                                   |
| `filer/test-fixtures/edgar/expected.json` | Ground truth per fixture. **Already committed — do not modify.**                                                                                                      |
| `filer/sdk/exhibit21-real.test.ts`        | The regression suite over the real corpus. Written in Task 1, extended by nobody.                                                                                     |
| `filer/sdk/exhibit21.ts`                  | Parser. Task 2 rewrites the document-window + line strategy; Task 3 rewrites the table strategy.                                                                      |
| `filer/sdk/edgar-filings.ts`              | Task 4 adds Exhibit 21 document discovery + accession URL construction.                                                                                               |

---

### Task 1: Real-corpus fixtures and the failing regression suite

**Status: complete, committed at the branch point.** The fixtures, `manifest.json`, `expected.json` and `exhibit21-real.test.ts` are on the branch, and the suite fails. Tasks 2 and 3 make it pass. Read `filer/sdk/exhibit21-real.test.ts` before starting Task 2, because it is the spec in executable form.

---

### Task 2: Document window and the line/list strategy

**Files:**

- Modify: `filer/sdk/exhibit21.ts`
- Test: `filer/sdk/exhibit21.test.ts` (existing suite must stay green), `filer/sdk/exhibit21-real.test.ts` (fixtures `bandwidth-2025.htm`, `shentel-2025.htm`, `alti-global-2025.htm` must reach their expected values)

**Interfaces:**

- Consumes: no output from other tasks.
- Produces: an exported `documentWindow(html: string): string` used by Task 3's table strategy as well. Signature: takes the raw archive document, returns the substring `parseExhibit21` should reason about.

**Why:** EDGAR's archive serves an exhibit wrapped in its SGML submission envelope. `bandwidth-2025.htm` begins:

```
<DOCUMENT>
<TYPE>EX-21.1
<SEQUENCE>3
<FILENAME>q42025exh211listofsubsidia.htm
<DESCRIPTION>EX-21.1
<TEXT>
<html><head><title>Document</title></head><body>…
```

`stripTags` turns `<TYPE>EX-21.1` into the bare line `EX-21.1`, `<SEQUENCE>3` into `3`, `<FILENAME>…` into the filename and `<title>Document</title>` into `Document`. On 2026-08-03 all four were emitted as subsidiaries of Bandwidth Inc., alongside twelve rows whose `name` was the bullet character `•` and whose `jurisdiction` was the actual company name. Every one of Bandwidth's 18 reported subsidiaries was wrong.

- [ ] **Step 1: Run the failing test to see the red bar**

Run: `yarn vitest run filer/sdk/exhibit21-real.test.ts`
Expected: FAIL. Among the failures, `bandwidth-2025.htm` reports 18 subsidiaries where 12 are expected, and the fabrication assertions name `"EX-21.1"`, `"3"` and `"•"`.

- [ ] **Step 2: Add `documentWindow` and route both strategies through it**

Exported, with a docstring explaining the SGML envelope (a reviewer must not have to guess why this exists):

```ts
const SGML_TEXT_OPEN = /<TEXT>/i
const SGML_TEXT_CLOSE = /<\/TEXT>/i
const HEAD_BLOCK = /<head[^>]*>[\s\S]*?<\/head>/gi
const SCRIPT_OR_STYLE_BLOCK = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi

export function documentWindow(html: string): string {
	const open = SGML_TEXT_OPEN.exec(html)
	const afterOpen = open ? html.slice(open.index + open[0].length) : html
	const close = SGML_TEXT_CLOSE.exec(afterOpen)
	const body = close ? afterOpen.slice(0, close.index) : afterOpen

	return body.replaceAll(HEAD_BLOCK, "").replaceAll(SCRIPT_OR_STYLE_BLOCK, "")
}
```

`parseExhibit21` calls it once, first thing, and every downstream strategy sees only the window.

- [ ] **Step 3: Strip list markers before splitting a candidate line**

A leading bullet or list marker is markup rather than part of a name. Strip `/^[•●▪◦∙·*–—-]+\s*/` from a candidate line before the name/jurisdiction split runs, so `"•  Bandwidth.com CLEC, LLC (Delaware, United States)"` becomes `"Bandwidth.com CLEC, LLC (Delaware, United States)"` and the existing trailing-parenthetical rule yields `{name: "Bandwidth.com CLEC, LLC", jurisdiction: "Delaware, United States"}` rather than `{name: "•", jurisdiction: …}`. A line consisting only of markers is blank after stripping and is skipped rather than counted.

- [ ] **Step 4: Recognize document titles and section headings as non-entities**

Extend the line strategy's header recognition (a candidate matching any of these exactly, case-insensitively, is counted in `unparseable` and dropped). These are whole-string patterns, deliberately not keyword sniffing:

```ts
const TITLE_LINE_PATTERNS = [
	/^exhibit\s*21(\.\d+)?(\s*[-–—:]\s*list of subsidiaries)?$/i,
	/^list of subsidiaries( of .+)?$/i,
	/^subsidiaries of .+$/i,
	/^.+ and subsidiaries$/i,
	/^(domestic|foreign|significant|principal) subsidiaries$/i,
	/^as of .+$/i,
]
```

`shentel-2025.htm` needs the first, third and fourth of these; it currently emits `"EXHIBIT 21 LIST OF SUBSIDIARIES"` and `"SHENANDOAH TELECOMMUNICATIONS COMPANY AND SUBSIDIARIES"` as subsidiaries.

- [ ] **Step 5: Abstain on a candidate line longer than 12 words**

```ts
const MAX_ENTITY_NAME_WORDS = 12
```

A candidate whose whitespace-separated token count exceeds this is counted in `unparseable` and dropped. Two real cases need this rule. The first is Shenandoah's preamble sentence ("The following are all measured subsidiaries of Shenandoah Telecommunications Company, and are organized in the Commonwealth of Virginia.", 20 tokens). The second is `alti-global-2025.htm`, whose markup separates entries with only a double space. Its five text runs are 20-to-90-token concatenations of several entity names, and no split rule can recover the boundaries without inventing them. The longest legitimate name in the corpus is `"Voxbone Telekomunikasyon ve Iletisim Hizmetleri Ticaret Limited Sirketi"` at 8 tokens.

`alti-global-2025.htm` is therefore expected to yield zero subsidiaries and a non-zero `unparseable`. That is the correct answer for that document.

- [ ] **Step 6: Run the suites**

Run: `yarn vitest run filer/ && yarn typecheck:tests`
Expected: `exhibit21.test.ts` is fully green, and no existing assertion changes. In `exhibit21-real.test.ts`, `bandwidth-2025.htm` (12), `shentel-2025.htm` (17) and `alti-global-2025.htm` (0) pass. The table-shaped fixtures still fail, and Task 3 fixes them.

- [ ] **Step 7: Commit**

```bash
git add filer/sdk/exhibit21.ts
git commit -m "fix(filer): parse the exhibit rather than EDGAR's SGML envelope around it"
```

---

### Task 3: Table strategy

**Files:**

- Modify: `filer/sdk/exhibit21.ts`
- Test: `filer/sdk/exhibit21.test.ts` (stays green), `filer/sdk/exhibit21-real.test.ts` (all ten table-shaped fixtures reach their expected values)

**Interfaces:**

- Consumes: `documentWindow` from Task 2.
- Produces: no new interface for later tasks.

**Why:** Every table-shaped rule below is failing against a real filing today. The counts are from the 2026-08-03 run over the vendored corpus.

| Defect                                                                         | Evidence                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only the first top-level table is read                                         | Lumen's list spans 5 sibling tables (207 rows); 42 were read. Comcast's spans 33 (1530 rows); 47 were read. In the vendored corpus: `att-2025.htm` (2), `widepoint-2025.htm` (2), `atn-international-2025.htm` (7), `echostar-2025.htm` (5), `idt-2025.htm` (4). |
| An all-blank spacer column makes every data row look 3-wide                    | `cable-one-2025.htm`, `ooma-2025.htm`, `verizon-2025.htm`, `att-2025.htm`, `anterix-2025.htm` — 0 subsidiaries each, everything counted `unparseable`.                                                                                                           |
| Header rows whose labels are not on the known list get emitted as subsidiaries | `liberty-broadband-2025.htm` emits `{name: "Entity Name", jurisdiction: "Domicile"}`; `widepoint-2025.htm` emits `{name: "Full Legal Name", jurisdiction: "State or Country of Incorporation"}`.                                                                 |
| A real third column makes the row abstain                                      | `att-2025.htm` (adds "Conducts Business Under"), `atn-international-2025.htm` (adds "Other name(s) under which entity does business"), `echostar-2025.htm` (adds "% of Ownership" and "Name Doing Business As").                                                 |
| Footnote tables read as subsidiary rows                                        | `widepoint-2025.htm` table 2 is `[(1), "In January 2019, WidePoint Solutions Corp. was merged into…"]`; `echostar-2025.htm` has four such tables.                                                                                                                |

- [ ] **Step 1: Read all top-level tables rather than the outermost one**

Replace `extractOutermostTableHTML` with a function returning every depth-0 `<table>…</table>` block in document order. Nesting handling is unchanged: a table nested inside a cell belongs to its parent and is not returned separately, and an unclosed final table still yields everything after its opening tag. Rows are then classified per table, and the results concatenated.

- [ ] **Step 2: Drop columns that are blank in every row of a table**

Per table, right-pad every row to the table's maximum cell count, then drop each column index whose value is blank in every row. `cable-one-2025.htm`'s rows go from `["Bluffton Telephone Company, LLC", "", "South Carolina"]` to `["Bluffton Telephone Company, LLC", "South Carolina"]`.

Do this per table and by column, never per row. Filtering blanks row by row loses the fact that a row's leading cell was blank. That blank cell is what distinguishes an indented child row from a subsidiary row, and the parser cannot tell them apart from one row alone.

- [ ] **Step 3: Extend the header/decoration label list**

Add every label the real corpus uses. Same rule as today: exact whole-cell case-insensitive match, never substring sniffing.

```
"entity name", "legal name", "legal entity", "full legal name", "name of entity",
"subsidiary name", "subsidiary companies", "domicile", "country",
"state of incorporation / organization", "state of incorporation or formation",
"state of incorporation/formation", "state or country of incorporation",
"state/country of organization", "state/country of formation",
"jurisdiction of formation", "jurisdiction of incorporation or formation",
"name doing business as", "conducts business under", "d/b/a", "dba",
"other name(s) under which entity does business", "% of ownership",
"ownership percentage", "domestic subsidiaries", "foreign subsidiaries"
```

- [ ] **Step 4: Header-driven column mapping, carried across sibling tables**

When a table's header row labels exactly one column with a jurisdiction label, record a mapping. The jurisdiction column is that column. The name column is the first other column that does not carry an "other" label (`% of ownership`, `conducts business under`, `d/b/a`, `name doing business as`, `other name(s) under which entity does business`, `ein`). Data rows in that table then read name and jurisdiction from those column indices and ignore the rest.

The parser does not guess what each column means, because the document labels the columns.

The mapping carries forward to later sibling top-level tables until another header row replaces it. EDGAR filings can split one logical table across page-break tables, and only the first carries the header. For example, `att-2025.htm`'s second table holds AT&T Mobility, Cricket Wireless, Teleport Communications America and BellSouth Telecommunications with no header of its own. The footnote rule (Step 5) still catches footnote rows before the mapping is consulted, so a footnote table that follows a labeled list does not inherit the mapping.

Two rules govern what happens when the mapped name column is blank on a row:

1. **Indented corporate tree.** If the mapped name column is blank, take the first non-blank column strictly between the name column and the jurisdiction column. Telephone and Data Systems indents each subsidiary one column right of its parent, as in `["", "ADI FINANCIAL, LLC", "", "ILLINOIS"]` under a header of `["SUBSIDIARY COMPANIES", "", "STATE OF ORGANIZATION"]`, and 132 of its 183 subsidiaries sit on such rows. The parser discards the nesting depth, since an Exhibit 21 row becomes a registrant→subsidiary edge either way. The name itself is certain, because the header places the jurisdiction to its right. A row like `["", "Delaware", ""]` under a mapping whose jurisdiction column is index 1 has no column between 0 and 1, so it still abstains.
2. **Otherwise fall through** instead of abstaining. A row the mapping cannot name goes to the generic rules below instead of being counted immediately. A ragged table (`anterix-2025.htm`'s rows have 5 and 6 cells under a 6-cell header) misaligns the mapping, but the row is still readable.

Add a hand-written indented-tree case to `exhibit21.test.ts` for rule 1: a 4-row table with a two-column header, one top-level row and two indented rows. Also add the `["", "Delaware", ""]` counter-case, which must still abstain. The TDS document is 176 KB and is not vendored.

- [ ] **Step 5: Four new abstention rules**

Each rule counts the row in `unparseable` and drops it. Apply them in this order, after the existing blank-row and header/decoration checks.

**The plan deliberately has no per-row "this jurisdiction looks like a company name" rule.** An earlier draft had one, and it was wrong. Charter Communications writes its jurisdiction column as `"Delaware limited liability company"`, so such a rule abstains on 135 of Charter's 139 subsidiaries. Rule 4 below replaces it at the table level, where there is enough evidence to tell the two cases apart.

1. **Footnote marker.** The row's first non-blank value matches `/^[([]?\d{1,3}[)\]]?$/` or `/^\*{1,3}$/`. Covers the footnote tables in `widepoint-2025.htm`, `atn-international-2025.htm` and `echostar-2025.htm`.
2. **Section heading.** The row has exactly one non-blank value and the table is not a plain single-column name list (a table qualifies as one only when every row has at most one non-blank value and at least two rows have one). Covers `idt-2025.htm`'s `"Domestic Subsidiaries"` / `"Foreign Subsidiaries"` rows and its single-row trailing footnote tables.
3. **Multi-value cell.** The row's name cell contains a block boundary (`</p>`, `</div>`, `<br>`, `</li>`) with non-blank text on both sides of it. The source kept several values apart, and cleaning joined them. `ooma-2025.htm`'s last row is one `<td>` holding five `<p>` blocks. Without this rule it emits `{name: "Trunking.IO, LLC FluentStream Corp. FluentStream Intermediate, LLC FluentStream Technologies, LLC Phone.Com, Inc.", jurisdiction: "Delaware Delaware Delaware Colorado Delaware"}`. This check needs the cell's raw HTML, so keep the raw HTML alongside the cleaned text on `TableCell`.
4. **Name/name table.** When no header mapping is in force, a table counts as a two-across list of entity names with no jurisdiction column. The whole table abstains when all three of these conditions hold over its two-value data rows:
   - there are at least 4 of them,
   - more than half of their second values carry a legal designation, and
   - the number of DISTINCT second values exceeds 70% of the row count.

   `idt-2025.htm`'s "Domestic Subsidiaries" table is `["IDT America, Corp. (NJ)", "IDT Payment Services, Inc*. (DE)"]` and four more like it: 5 rows, 5/5 carrying a designation, 5 distinct. Without this rule each emits a company as another company's jurisdiction.

   **The distinctness condition is required. Without it, Charter Communications loses all 135 of its subsidiaries.** Charter writes its jurisdiction column as `"Delaware limited liability company"`, so 135 of 135 second values carry a designation (`limited`, `company`) in a table that is an ordinary name/jurisdiction list. Repetition separates the two cases. A jurisdiction column repeats values (Charter has 9 distinct over 135 rows, 0.07; Comcast 0.05; Uniti 0.13; T-Mobile 0.15; Lumen 0.26), and a second name column does not (IDT 1.00). These ratios were measured on 2026-08-03 across the seven large filings that are not vendored.

   Use `canonicalizeOrganizationName` from `@mailwoman/record` for designation detection instead of writing a token list by hand. It is already a dependency and already used by `edgar-filings.ts`. It returns a `designations` array that is non-empty exactly when the value carries a designation. On 2026-08-03 it was checked against these values: `"IDT Payment Services, Inc*. (DE)"` → `["inc"]`, and `"South Carolina"` / `"Delaware"` / `"British Columbia, Canada"` / `"England and Wales"` / `"DE"` → `[]`.

- [ ] **Step 6: Reconcile the blank-table fallthrough Task 2 already added**

`parseExhibit21` used to commit to the table strategy as soon as a `<table>` existed. `shentel-2025.htm` has two entirely blank decorative tables, with the real list as block text outside them, so it returned no subsidiary. Task 2 added `isEntirelyBlankTable`: when every cell of every row is blank, `parseExhibit21` proceeds as if no table were present.

**An earlier draft of this plan specified a broader rule, "when the table strategy produces zero subsidiaries, fall through and take the fallback's result", and that rule is wrong.** It also fires on `exhibit21-mangled.html`. In that fixture, a blank `<td></td>` beside a real `<td>Delaware</td>` becomes an isolated `"Delaware"` line once tags are stripped. The line strategy accepts that line as a name-only subsidiary, fabricates `{name: "Delaware"}`, and breaks the currently green "deliberately mangled fixture yields zero subsidiaries" test.

Keep `isEntirelyBlankTable` as the condition. Read it before you write anything here. It may already be correct for every fixture. In that case, confirm it, leave it alone, and say so in your report. Widen it only if a vendored fixture requires it, and only in a way that still leaves `exhibit21-mangled.html` at zero subsidiaries.

- [ ] **Step 7: Run the suites**

Run: `yarn vitest run filer/ && yarn typecheck:tests`
Expected: all green, including all 13 fixtures in `exhibit21-real.test.ts` at their `expected.json` counts and lists.

- [ ] **Step 8: Commit**

```bash
git add filer/sdk/exhibit21.ts
git commit -m "fix(filer): read every table in an Exhibit 21, and the columns its header names"
```

---

### Task 4: Exhibit 21 document discovery

**Files:**

- Modify: `filer/sdk/edgar-filings.ts`
- Test: `filer/sdk/edgar-filings.test.ts`

**Interfaces:**

- Consumes: `TenKFiling` and `CIK` from the same file; `SECDocumentClient` from `exhibit21.ts`.
- Produces:
  ```ts
  export interface ExhibitDocument {
  	type: string
  	filename: string
  	url: string
  }
  export function accessionArchiveURL(cik: CIK, accessionNumber: string): string
  export function parseFilingDocuments(cik: CIK, accessionNumber: string, headerHTML: string): ExhibitDocument[]
  export function findExhibit21Documents(cik: CIK, accessionNumber: string, headerHTML: string): ExhibitDocument[]
  export async function fetchExhibit21Documents(
  	client: SECDocumentClient,
  	filing: TenKFiling
  ): Promise<ExhibitDocument[]>
  ```

**Why:** This is the one link the chain is missing. `fetchExhibit21` takes a URL and states that finding the URL is out of scope, and no caller supplies one. EDGAR's accession `index.json` types every file as a GIF icon name (`"type":"text.gif"`), so it cannot identify the Exhibit 21 document. The accession's `…-index-headers.html` can, because it carries the submission's SGML manifest, HTML-escaped, with one block per document. From `filer/test-fixtures/edgar/lumen-2025-index-headers.html` (162 documents, one of type `EX-21`):

```
&lt;DOCUMENT&gt;
&lt;TYPE&gt;EX-21
&lt;SEQUENCE&gt;6
&lt;FILENAME&gt;lumn20251231ex21.htm
&lt;DESCRIPTION&gt;EX-21
&lt;TEXT&gt;
<a href="lumn20251231ex21.htm">Document 6 - file: lumn20251231ex21.htm</a><br>
&lt;/DOCUMENT&gt;
```

- [ ] **Step 1: Write the failing tests**

```ts
const headerHTML = readFileSync(
	join(import.meta.dirname, "..", "test-fixtures", "edgar", "lumen-2025-index-headers.html"),
	"utf8"
)
const LUMEN_CIK = "0000018926" as CIK

it("builds an accession archive URL with an UNPADDED cik and an undashed accession", () => {
	expect(accessionArchiveURL(LUMEN_CIK, "0000018926-26-000014")).toBe(
		"https://www.sec.gov/Archives/edgar/data/18926/000001892626000014"
	)
})

it("finds exactly one EX-21 among the filing's 162 documents, with an absolute URL", () => {
	expect(findExhibit21Documents(LUMEN_CIK, "0000018926-26-000014", headerHTML)).toEqual([
		{
			type: "EX-21",
			filename: "lumn20251231ex21.htm",
			url: "https://www.sec.gov/Archives/edgar/data/18926/000001892626000014/lumn20251231ex21.htm",
		},
	])
})

it("reads every document in the manifest rather than only the exhibits", () => {
	const documents = parseFilingDocuments(LUMEN_CIK, "0000018926-26-000014", headerHTML)

	expect(documents.length).toBe(162)
	expect(documents[0]).toMatchObject({ type: "10-K", filename: "lumn-20251231.htm" })
})

it("accepts every EX-21 spelling EDGAR actually uses", () => {
	for (const type of ["EX-21", "EX-21.1", "EX-21.01", "ex-21.2"]) {
		const html = `&lt;DOCUMENT&gt;\n&lt;TYPE&gt;${type}\n&lt;FILENAME&gt;x.htm\n&lt;/DOCUMENT&gt;`

		expect(findExhibit21Documents(LUMEN_CIK, "0000018926-26-000014", html)).toHaveLength(1)
	}
})

it("does NOT mistake EX-2, EX-210 or EX-23 for an Exhibit 21", () => {
	for (const type of ["EX-2", "EX-2.1", "EX-210", "EX-23", "EX-21A"]) {
		const html = `&lt;DOCUMENT&gt;\n&lt;TYPE&gt;${type}\n&lt;FILENAME&gt;x.htm\n&lt;/DOCUMENT&gt;`

		expect(findExhibit21Documents(LUMEN_CIK, "0000018926-26-000014", html)).toEqual([])
	}
})

it("returns an empty array — never throws — for a filing whose manifest has no EX-21", () => {
	expect(findExhibit21Documents(LUMEN_CIK, "0000018926-26-000014", "<html>no manifest here</html>")).toEqual([])
})

it("skips a block missing a FILENAME rather than emitting a URL ending in a slash", () => {
	const html = "&lt;DOCUMENT&gt;\n&lt;TYPE&gt;EX-21\n&lt;/DOCUMENT&gt;"

	expect(findExhibit21Documents(LUMEN_CIK, "0000018926-26-000014", html)).toEqual([])
})
```

Note the last three. A filing with no Exhibit 21 is ordinary. In the 2026-08-03 run, Consolidated Communications and United States Cellular both filed a 10-K whose latest accession has none. `parseCompanyTickers`/`parseTenKFilings` behave differently: they throw on a malformed payload, because those payloads are SEC's own documented API shapes. An absent exhibit is the filer's choice and makes no statement about the upstream interface. Say so in the docstring.

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn vitest run filer/sdk/edgar-filings.test.ts`
Expected: FAIL, "findExhibit21Documents is not a function".

- [ ] **Step 3: Implement**

```ts
const DOCUMENT_BLOCK_PATTERN = /&lt;DOCUMENT&gt;([\s\S]*?)(?:&lt;\/DOCUMENT&gt;|$)/gi
const DOCUMENT_TYPE_PATTERN = /&lt;TYPE&gt;([^\r\n<]+)/i
const DOCUMENT_FILENAME_PATTERN = /&lt;FILENAME&gt;([^\r\n<]+)/i
const EXHIBIT_21_TYPE_PATTERN = /^ex-?21(\.\d+)?$/i

export function accessionArchiveURL(cik: CIK, accessionNumber: string): string {
	return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNumber.replaceAll("-", "")}`
}
```

`Number(cik)` strips the zero-padding. EDGAR's archive paths use the unpadded CIK (`.../data/18926/...`), while the submissions API uses the padded form. Both forms appear in this file, and the docstring must say which is which.

- [ ] **Step 4: Add the fetching pair**

`fetchExhibit21Documents(client, filing)` fetches `${accessionArchiveURL(filing.cik, filing.accessionNumber)}/${filing.accessionNumber}-index-headers.html` through `client.getDocument` and returns `findExhibit21Documents(...)` over the body. Take `SECDocumentClient` (the one-method structural type) rather than the concrete client, as the rest of this file does. A test then needs no axios harness.

- [ ] **Step 5: Run the suites**

Run: `yarn vitest run filer/ && yarn typecheck:tests`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add filer/sdk/edgar-filings.ts filer/sdk/edgar-filings.test.ts
git commit -m "feat(filer): find a filing's Exhibit 21 from its SGML document manifest"
```

---

### Task 5: Collapse duplicate CIKs in candidate resolution

**Status: complete.** This task landed on this branch, and the three tests below are in `edgar-filings.test.ts`. Mutation testing verified the collapse in both directions. Removing it makes these tests fail, and keying it on the company name instead of the CIK makes the 3a namesake tests fail.

**Files:**

- Modify: `filer/sdk/edgar-filings.ts`
- Test: `filer/sdk/edgar-filings.test.ts`

**Interfaces:**

- Consumes: `CIKCandidate`, `resolveCIKCandidates` from the same file.
- Produces: no new exports; `resolveCIKCandidates`'s return value gains an invariant (CIKs are distinct).

**Why:** `company_tickers.json` has one row per ticker, so a registrant with several share classes appears several times under one CIK. On 2026-08-03, resolving `"Liberty Broadband Corporation"` returned CIK `0001611983` four times, each scoring 1.0. The tie rule exists to stop a caller from narrowing an actual collision between two different companies, and it reported a four-way tie. The same phantom tie appeared for Comcast, AT&T, T-Mobile and Telephone and Data Systems. The rule must fire on a collision between distinct CIKs and stay silent on one registrant's share classes.

- [ ] **Step 1: Write the failing tests**

```ts
const shareClasses: CompanyTickerEntry[] = [
	{ cik: "0001611983" as CIK, ticker: "LBRDA", title: "Liberty Broadband Corp" },
	{ cik: "0001611983" as CIK, ticker: "LBRDB", title: "Liberty Broadband Corp" },
	{ cik: "0001611983" as CIK, ticker: "LBRDK", title: "Liberty Broadband Corp" },
]

it("reports ONE candidate for a registrant with several share classes", () => {
	const candidates = resolveCIKCandidates("Liberty Broadband Corporation", shareClasses)

	expect(candidates).toHaveLength(1)
	expect(candidates[0]!.cik).toBe("0001611983")
})

it("still reports BOTH sides of a genuine tie between DIFFERENT companies, even at limit 1", () => {
	const collision: CompanyTickerEntry[] = [
		{ cik: "0000000001" as CIK, ticker: "ABL", title: "American Broadband LLC" },
		{ cik: "0000000002" as CIK, ticker: "ABI", title: "American Broadband, Inc." },
	]
	const candidates = resolveCIKCandidates("American Broadband", collision, { limit: 1 })

	expect(candidates).toHaveLength(2)
	expect(new Set(candidates.map((candidate) => candidate.cik))).toEqual(new Set(["0000000001", "0000000002"]))
})

it("keeps the highest-scoring row's spelling when collapsing share classes", () => {
	const mixed: CompanyTickerEntry[] = [
		{ cik: "0001611983" as CIK, ticker: "LBRDA", title: "Liberty Broadband Holdings" },
		{ cik: "0001611983" as CIK, ticker: "LBRDK", title: "Liberty Broadband Corporation" },
	]
	const candidates = resolveCIKCandidates("Liberty Broadband Corporation", mixed)

	expect(candidates).toHaveLength(1)
	expect(candidates[0]!.companyName).toBe("Liberty Broadband Corporation")
})
```

The second test matters most. It checks that two different companies with a tied score stay reported as a tie, which is the false-identity-link case from 3a, and it must keep passing. Do not weaken it.

- [ ] **Step 2: Run them to verify the first and third fail**

Run: `yarn vitest run filer/sdk/edgar-filings.test.ts`
Expected: the share-class tests fail (3 candidates rather than 1); the actual-tie test passes already.

- [ ] **Step 3: Implement**

Collapse by CIK after scoring and before sorting. For each CIK, keep the highest-scoring entry. The first-seen entry wins a tie within one CIK, so the result is deterministic in ticker-file order. Leave the tie rule exactly as it is. It now operates on distinct CIKs, as its docstring always claimed. Update that docstring to say the collapse happens first and why.

- [ ] **Step 4: Run the suites**

Run: `yarn vitest run filer/ && yarn typecheck:tests`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add filer/sdk/edgar-filings.ts filer/sdk/edgar-filings.test.ts
git commit -m "fix(filer): one candidate per registrant — share classes are not a tie"
```

---

## Out of scope, and why

**Automatic name→CIK selection.** The 2026-08-03 run took the top candidate for 24 telecom company names and got two confidently wrong registrants: `"Altice USA, Inc."` resolved to AlTi Global, Inc. (SIC 6282, investment advice) at 0.829, and `"WideOpenWest, Inc."` to WidePoint Corp at 0.886. Both are vendored as fixtures under their true registrant names. Any ingest path must corroborate a candidate against something other than its name. The registrant's SIC code, which the submissions payload already carries, is the cheapest available check. That check belongs in a follow-up, together with the orchestrator that turns corroborated CIKs into `EdgarSubsidiaryRow`s. That follow-up decides what lands in `filer_family`.

**Comcast, Lumen, Uniti, TDS, Charter, T-Mobile and Cogent** were measured but are not vendored. Comcast's Exhibit 21 alone lists ~1,500 subsidiaries across 33 tables and is 960 KB, which is too large for the repository. The 13 vendored documents cover every defect class those seven filings show.
