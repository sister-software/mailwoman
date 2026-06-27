---
title: Record-matcher data catalog
sidebar_label: Data catalog
---

# Record-matcher data catalog

The cross-dataset record-matcher resolves entities across several public datasets that share no common key. This page documents what each dataset is, where it lives, and how its columns map into the matcher — so a run is reproducible and the mappings are version-controlled rather than folklore.

These are **public compliance and reporting datasets**, published per-program in a fragmented, non-deduplicated shape. The matcher's job is **entity resolution**: given the same place described by different publishers under different operational names, recognize that it's one place. Whether any resulting correlation means anything is the data consumer's call, not ours.

The machine-readable catalog — provenance plus the `ColumnMapping` per source — is committed at [`registry/configs/record-matcher-sources.json`](https://github.com/sister-software/mailwoman/blob/main/registry/configs/record-matcher-sources.json). This page is its prose companion.

## The join model

There is **no shared key across publishers**. The NPI is internal to NPPES; the HCP Number is internal to the FCC; the Facility ID is internal to TX HHSC. So the matcher doesn't join on an identifier — it joins on the **geocoded location** (each address goes through mailwoman's parser + resolver to a coordinate) plus **name/organization agreement**. That geocode-first, label-free approach is the premise of the contact/org matcher ([#598](https://github.com/sister-software/mailwoman/issues/598), [#615](https://github.com/sister-software/mailwoman/issues/615)): the resolved _place_ is the key, not the address string.

## Sources

The files live under `$MAILWOMAN_DATA_ROOT/record-matcher/sources/`. Snapshot dates are encoded in each filename (`…_YYYYMMDD.tsv`).

### TX HHSC nursing facilities

- **Publisher / program:** Texas Health and Human Services Commission — long-term care facility registry.
- **File:** `txhhsc_nursing-facilities_20260611.tsv` (snapshot 2026-06-11) — 1,176 rows, 43 columns.
- **Within-source key:** `Facility ID`.
- **Maps to:** organization ← `Facility Name`; address ← `Physical Address` + `Physical Address CITY` + `Physical Address State` + `Physical Address Zipcode`; phone ← `Facility Phone Number`.
- No coordinate column — resolved by parse.

### FCC Rural Health Care — posted services

- **Publisher / program:** Federal Communications Commission — Rural Health Care, posted services (Form 461/465), the funding/enrollment side.
- **File:** `fcc-rhc_posted-services_form461-465_20260615.tsv` (snapshot 2026-06-15) — 94,350 rows, 71 columns.
- **Within-source key:** `HCP Number`.
- **Maps to:** organization ← `HCP Name`; address ← `Site Address Line 1` + `Site City` + `Site State` + `Site ZIP Code`; phone ← `Contact Phone`; email ← `Contact E-mail`.

### FCC Rural Health Care — funding commitments

- **Publisher / program:** Federal Communications Commission — Rural Health Care, funding commitments/disbursements (Form 462/466/466a).
- **File:** `fcc-rhc_commitments-disbursements_form462-466-466a_20260615.tsv` (snapshot 2026-06-15) — 470,647 rows, 53 columns.
- **Within-source key:** each row carries **two** addressable entities — a Filing HCP and a Participating HCP. The matcher explodes each in-state HCP into its own record (the [#618](https://github.com/sister-software/mailwoman/issues/618) two-entity-per-row case), keyed `${role}-${HCP}`.
- **Maps to:** organization ← `hcpName`; address ← `hcpStreet` + `hcpCity` + `hcpState` + `hcpZip` (assembled per role during the explode).

### NPPES NPI registry

- **Publisher / program:** Centers for Medicare & Medicaid Services — National Provider Identifier registry.
- **File:** `nppes_npi-registry_20260607.tsv` (snapshot 2026-06-07) — ~8.0M rows, 330 columns, 5.1 GB. Streamed, never loaded whole.
- **Within-source key:** `NPI`. NPPES is also the held-out truth set for the dedup benchmark (#615) — the NPI is a ground-truth within-registry identity.
- **Filter:** the matcher samples **Entity Type 2** (organization) NPIs in-state with a non-empty legal business name — the entities most likely to co-occur with the facilities in the other sources.
- **Maps to:** organization ← `Provider Organization Name (Legal Business Name)`; address ← the four `Provider … Business Practice Location Address …` columns; phone ← the practice-location telephone column.

## Auxiliary files

Carried alongside the primaries, used for enrichment rather than as primary record sources:

| file                                                    | purpose                                               |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `nppes_other-names_20260607.tsv`                        | NPI → other organization names (an alias bag per NPI) |
| `nppes_practice-locations_20260607.tsv`                 | NPI → secondary practice-location addresses           |
| `fcc-rhc_spin-lookup_20260615.tsv`                      | SPIN → service-provider name / DBA                    |
| `txhhsc_nursing-facility-closures_20260608.tsv`         | TX HHSC closed nursing facilities                     |
| `txhhsc_hospital-based-nursing-facilities_20260611.tsv` | TX HHSC hospital-based nursing facilities             |

## Refreshing a snapshot

The datasets are published on a rolling basis. To refresh: download the new per-program file, keep the `…_YYYYMMDD.tsv` naming (the date is the snapshot of record), drop it under the source root, and update the `snapshot` / `rows` fields in `registry/configs/record-matcher-sources.json`. The column mappings are stable across snapshots unless a publisher renames a column — if a run's geocode rate drops, check the header against the committed mapping first.

The persistent home is the lab data volume (`$MAILWOMAN_DATA_ROOT/record-matcher/sources/`); the files are too large for git (NPPES alone is 5.1 GB), so the catalog config is the version-controlled record of what was used, and the snapshot date pins reproducibility.
