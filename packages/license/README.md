# @mailwoman/license

This package decides, records and reports the rights of the third-party data sources Mailwoman reads. It holds
the license-decision shape every register uses, the operations a decision permits, the obligations an SPDX
expression imposes, the reading of a license string into separate facts, and the policies a corpus build or a
data layer applies to them.

Public library with no runtime dependencies. Install with `npm install @mailwoman/license`.

It holds no register. The address-source register is data in `@mailwoman/corpus`, and the structure register is
in `@mailwoman/structures`. A caller reads its register and passes the decisions in.

Mailwoman's own dual license, its key, its stamp and the branch an installation runs under, is
`@mailwoman/core/license`.

## Modules

| Module        | What it answers                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `decision`    | A reviewer's license decision, the permission it records per operation, and its audit             |
| `operations`  | The acts this repository performs on an address source                                            |
| `actions`     | The action table: the operations each build or release performs on a source                       |
| `tree`        | The go/no-go decision tree: whether an action may proceed over a set of sources, and what it owes |
| `obligations` | The obligations of an SPDX expression's identifiers, and whether a manifest may record it         |
| `expression`  | The one linear reader of an SPDX expression's terms                                               |
| `record`      | A license string read as an expression, a credit, mentions and obligations                        |
| `policy`      | Which corpus rows a license policy admits                                                         |
| `admission`   | A layer build's admission of its sources by their decisions                                       |
| `refusals`    | A customer's refusal of an obligation class                                                       |
| `mixed`       | The obligation class each source of a mixed layer counts under                                    |

## Quick start

```ts
import { LicenseAction } from "@mailwoman/license/actions"
import { summarizeLicense } from "@mailwoman/license/obligations"
import { evaluateLicense } from "@mailwoman/license/tree"

summarizeLicense("ODbL-1.0 AND CC-BY-4.0").obligations // ["attribution", "share_alike"]

const answer = evaluateLicense(
	{ action: LicenseAction.Ingest, offering: null, sources: [{ source: "example", licenseID: "example-license" }] },
	{ licenses: [] }
)

answer.verdict // "unknown"
answer.sources[0].problems // ['license "example-license" is not declared in the register']
```

The tree reads each source through seven nodes in order: `registered`, `review-state`, `reservation`,
`operations`, `purpose`, `basis-floor` and `obligations`. The first node a source doesn't pass stops it.
The `obligations` node collects what the source owes and has no refusal edge, so an obligation, an
indemnity included, never refuses an action. The answer carries each step's node, outcome and quote,
and the register's content digest.

The summary is a debugging aid and gives no legal advice.
