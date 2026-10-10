# `@mailwoman/ofcom`

This private package reads Ofcom's Connected Nations fixed-coverage files at two levels: the unit
postcode and the census output area. It returns one typed row per area for the fields a caller
requests, with the snapshot month, premises set and revision that the published file name states.

Source record: [`docs/records/research/2026-10-05-uk-infrastructure-source-audit.md`](../../docs/records/research/2026-10-05-uk-infrastructure-source-audit.md).

## What a row means

A row describes every premises that Ofcom's premises base assigns to one area, so it is area context.
It states no result for any building in that area. Ofcom names no network at either level and
withholds full-fiber availability at both.

A postcode file publishes seventeen percentages and no premises count. Ofcom's guide lists
`All Premises`, `All Matched Premises` and every `Number of premises…` field as present in "all
except pc". The output-area file is the finest level with a premises denominator. A request for a
field that the file does not publish throws `OfcomCoverageFieldError`, which names each missing field
and the level. A request for a premises count at postcode level therefore throws rather than returning
an absent or zero count.

## Usage

```ts
import { OfcomCoverageField, readOfcomCoverageFile } from "@mailwoman/ofcom"

const { source, rows } = await readOfcomCoverageFile("202601_fixed_oa_coverage_r1.csv", [
	OfcomCoverageField.AllPremises,
	OfcomCoverageField.GigabitPremises,
])

source.snapshot // "2026-01"
rows.get("E00005233")?.values // { "All Premises": 509, "Number of premises with Gigabit availability": 371 }
```

The reader requires the published file name, because the snapshot month (`202601`), the premises set
(`res`) and the revision (`r2`) appear nowhere else. It accepts the ZIP's `pc` spelling and the guide's
`postcode` spelling of the postcode token. It throws on an empty or non-numeric requested value, a
repeated area, a row whose width differs from the header's, a postcode whose compact form or postcode
area disagrees with the file, and a parsed row count that differs from the file's line count.

## Data and license

Ofcom publishes the files in its Connected Nations releases. The Spring 2026 update (published
2026-05-13, January 2026 snapshot) carries 121 all-premises postcode files at revision 2, 121
residential postcode files, and one output-area file for each premises set. Ofcom licenses the data
under OGL v3.0. Its website terms ask that reproduced material be "reproduced accurately and not used
in a misleading context" and acknowledged as Ofcom copyright. The package ships no Ofcom data. Its
test fixtures copy a few published rows and cite their snapshot.

The fixture rows carry this attribution:

> Ofcom, Connected Nations update Spring 2026, fixed coverage data (January 2026). © Ofcom. Licensed
> under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
