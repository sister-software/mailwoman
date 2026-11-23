# @mailwoman/license

This package decides, records and reports the rights of the third-party data sources Mailwoman reads. It holds
the license-decision shape every register uses, the operations a decision permits, the obligations an SPDX
expression imposes, the reading of a license string into separate facts, and the policies a corpus build or a
data layer applies to them.

Public library whose one runtime dependency is zod. Install with `npm install @mailwoman/license`.

It holds no source register. The address-source register is data in `@mailwoman/corpus`, and the structure register is
in `@mailwoman/structures`. A caller reads its register and passes the decisions in.

The `product/` modules hold Mailwoman's own product license as data: the wire format of the platform license key and
the commercial training grant, the trust register of public signing keys, the entitlement checks, the model
provenance manifest, and the published agreements and plans. The Rust crate in `crates/product-license` reads the same
`product/trust-register.json` and the fixtures under `test/fixtures/product/`.
`docs/engineering/reference/product-license-tokens.mdx` specifies the formats. The signatures themselves, the engine
stamp and the branch an installation runs under are `@mailwoman/core/license`.

## Modules

| Module        | What it answers                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `decision`    | A reviewer's license decision, the permission it records per operation and purpose, and its audit |
| `operations`  | The acts this repository performs on an address source                                            |
| `actions`     | The action table: the operations each build or release performs on a source, and its purposes     |
| `tree`        | The go/no-go decision tree: whether an action may proceed over a set of sources, and what it owes |
| `quote`       | Whether a source's rows may be quoted in published text, and the helper that prints a row         |
| `reservation` | A source held out of every training corpus for evaluation                                         |
| `obligations` | The obligations of an SPDX expression's identifiers, and whether a manifest may record it         |
| `expression`  | The one linear reader of an SPDX expression's terms                                               |
| `record`      | A license string read as an expression, a credit, mentions and obligations                        |
| `policy`      | Which corpus rows a license policy admits                                                         |
| `admission`   | A layer build's admission of its sources by their decisions                                       |
| `refusals`    | A customer's refusal of an obligation class                                                       |
| `mixed`       | The obligation class each source of a mixed layer counts under                                    |

| Product module        | What it answers                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `product/token`       | The `mwl1` platform key and `mwt1` training grant: prefixes, payload schemas, verification statuses |
| `product/trust`       | The license and provenance signing keys of `trust-register.json`, and their trust maps              |
| `product/entitlement` | Whether a verified grant admits a commercial training run, or commercial use of a trained model     |
| `product/provenance`  | The training record (`TRAINING.json`) and the signed provenance manifest beside a model             |
| `product/agreement`   | The published agreement versions and their pages                                                    |
| `product/plans`       | The published platform plans, prices and grace period                                               |
| `product/expiry`      | The expiry a declared or evaluation key takes from its intent                                       |
| `product/dates`       | UTC calendar-date arithmetic for key dates                                                          |

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
`operations`, `purpose`, `basis-floor` and `obligations`. The first node a source doesn't pass stops it,
except that `purpose` reads after `operations` either way, so the answer lists every unpermitted reading.
The `obligations` node collects what the source owes and has no refusal edge, so an obligation, an
indemnity included, never refuses an action. The `reservation` node refuses an action that requires
`train` over a source reserved for evaluation (`@mailwoman/license/reservation`), quoting the
reservation's reason. A register records a reservation by choice on the source, and lifts it by filling
`lifted`. A reservation by terms is computed for a decision that permits `evaluate` and refuses `train`.
The answer carries each step's node, outcome and quote, and the register's content digest.

The operations are named by what leaves this repository's hands: `fetch`, `extract`, `transform`,
`evaluate`, `train`, `distribute-rows`, `answer-queries`, `distribute-derived`, `distribute-model` and
`sublicense`, which no action performs. The `purpose` node reads two purposes beside them. Every action
is `commercial-use`, because Mailwoman is sold under `LicenseRef-Commercial`, and an offering under those
terms adds `sale`. A decision records a default reading per purpose in `purposes`, and a reading that
differs for one operation in `purposeExceptions`.

Each source's answer also carries `quotable`, which holds when its decision permits `distribute-rows`.
Text that will be published, such as a receipt, a document or an error message, prints a row through
`quoteRow` from `@mailwoman/license/quote`, which prints the row's id in place of a row that isn't
quotable.

The summary is a debugging aid and gives no legal advice.
