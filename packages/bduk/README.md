# `@mailwoman/bduk`

This private package reads Building Digital UK's UPRN-level release, "OMR and premises in BDUK plans".
Its library returns one typed row per premises for the columns a caller requests. Its download step
stores one region's archive under the data root and extracts the archive's CSV files.

Source record: [`docs/records/research/2026-10-05-uk-infrastructure-source-audit.md`](../../docs/records/research/2026-10-05-uk-infrastructure-source-audit.md).

## What a row means

Each row is one UPRN that BDUK assessed in an Open Market Review (OMR), with its postcode, its subsidy
control status, whether it has a gigabit-capable connection now and in suppliers' plans, and the BDUK
contracts that include it. BDUK's premises base is OS AddressBase Premium filtered to postal addresses
that are not demolished. A UPRN the release omits is a premises that BDUK did not assess, and the release
gives it no status.

`current_gigabit` is BDUK's view from suppliers' returns to the OMR and from its own delivery data. The
user guide states that suppliers who send no return leave gaps, and that the view can differ from
Ofcom's and thinkbroadband's. A `false` therefore states BDUK's view rather than an observed absence of a
network. The release names no network for commercial coverage, and its Grey/Black status covers one
qualifying network or several.

## Usage

```ts
import { BDUK_EXTRACTED_DIRECTORY, bdukReleasePath, readBDUKReleaseDirectory } from "@mailwoman/bduk"

const london = await readBDUKReleaseDirectory(
	bdukReleasePath("2026-05", "london", BDUK_EXTRACTED_DIRECTORY),
	["current_gigabit", "subsidy_control_status", "bduk_recognised_premises"],
	{ postcodes: ["CR0 5BX"] }
)

london.files.length // 33
london.rowCount // 4478945, every row read and checked
london.rows.length // 73, the rows listed with CR0 5BX
```

`readBDUKReleaseFile` and `parseBDUKRelease` read one file. A requested column is one of the release's
header labels, and its cells read as typed values:

- The flag columns read `true` and `false`, as the release writes them.
- `subsidy_control_status` reads `Gigabit Grey/Black`, `Gigabit White` and `Gigabit Under Review`. The
  guide defines a fourth status, `Unassessed`, which no row of the May 2026 release holds, so the
  reader refuses it until a release shows its spelling.
- `bduk_gis_contract_scope` reads `Initial` and `Deferred`, and `country` reads `England` and `Wales`.
- `lot_id` reads a whole number, `bduk_gis_final_coverage_date` reads a date written `YYYY-MM-DD`, and
  every other column reads text.

An empty cell reads as `null`, so it stays distinct from `false` and from zero. A requested column that
the header lacks throws `BDUKColumnError`, whose message lists each missing column. A cell outside its
column's vocabulary or form throws `BDUKValueError`, whose message gives the value, its line and its UPRN.
The reader also
throws on an empty file, a repeated header label, a UPRN that is empty, longer than 12 digits or repeated
in a file, a row whose width differs from the header's, and a parsed row count that differs from the
file's line count. A directory read throws when the directory holds no CSV file, when its files state
different OMR months, and when a selected UPRN appears in two files.

The OMR month appears only in the published file name, such as
`202605_BDUK_uprn_release_london_croydon.csv`, so the reader requires that name.

## Download

`downloadBDUKRegion` in `sdk/download.ts` stores one region's archive as
`$MAILWOMAN_DATA_ROOT/bduk/<OMR month>/<region>/<archive name>`, extracts its CSV files into the `csv`
directory beside it, and returns the archive's size and SHA-256. GOV.UK's content item for the
publication, `https://www.gov.uk/api/content/government/publications/may-2026-omr-and-premises-in-bduk-plans-england-and-wales`,
lists each attachment's URL and byte size. The URL holds an opaque media identifier, so the caller passes
it from the content item, with the stated size. A transfer of another size throws and leaves no archive.
An archive already on disk is reused and hashed again.

From the repository root, with `MAILWOMAN_DATA_ROOT` set:

```sh
node --input-type=module -e '
import { downloadBDUKRegion } from "@mailwoman/bduk/sdk/download"
console.log(await downloadBDUKRegion({
	url: "https://assets.publishing.service.gov.uk/media/6aa9aa09f1f8d2a39605f870/2026-09-10_zipped_files_release_london.zip",
	expectedBytes: 57082748,
	release: "2026-05",
	region: "london",
}))'
```

## Data and license

BDUK published the May 2026 release on GOV.UK on 2026-09-17: a user guide, a sample of 900 rows, one ZIP
archive for each of ten regions of England and Wales, and one file of premises with no region. GOV.UK's
publication page states the Open Government Licence v3.0 except where otherwise stated, and the user
guide states no exception. The package ships no BDUK data. Its test fixture copies eight rows of the
published sample file under the sample's file name and header.

The fixture rows carry this attribution:

> Building Digital UK, May 2026 OMR and premises in BDUK plans (England and Wales), UPRN-level release,
> sample file. © Crown copyright 2026. Licensed under the
> [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
