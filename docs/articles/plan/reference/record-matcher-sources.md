---
sidebar_position: 90
title: Record-matcher source-data catalog
tags:
  - reference
  - record-matching
---

# Record-matcher source-data catalog

The public datasets the record-matcher resolves, their schemas, the column mappings, and the join keys.
These are **real public compliance/reporting datasets** with **no shared entity key across them** and heavy
within-dataset repetition — resolving them into deduplicated, cross-linked entities is what makes them
analyzable. Our scope is the **resolution**; whatever correlations surface are the data consumer's to
interpret.

Data lives at `/mnt/playpen/mailwoman-data/record-matcher/sources/` (persistent — not `/tmp`). The NPPES
registry is 4.8 GB / 9.6M rows, so everything streams (`streamRows`, #616) — never `readFileSync`.

The committed `ColumnMapping`s live in the benchmark + correlation scripts
(`scripts/record-matcher/{nppes-dedup-benchmark,cross-dataset-correlation}.ts`); this page is the
human-readable index of them.

## The datasets

| file                                                              | rows | entity id                          | what it is                                                                 |
| ----------------------------------------------------------------- | ---: | ---------------------------------- | -------------------------------------------------------------------------- |
| `nppes_npi-registry_20260607.tsv`                                 | 9.6M | `NPI`                              | National Provider registry — every provider + org with an NPI              |
| `nppes_other-names_20260607.tsv`                                  | 855K | `NPI`                              | Alternate organization names per NPI (the name-drift source)               |
| `nppes_practice-locations_20260607.tsv`                           | 1.2M | `NPI`                              | Secondary practice locations per NPI                                       |
| `fcc-rhc_commitments-disbursements_form462-466-466a_20260615.tsv` | 470K | `Filing HCP` / `Participating HCP` | FCC Rural Health Care funding commitments — **two HCPs per row**           |
| `fcc-rhc_posted-services_form461-465_20260615.tsv`                |  94K | `HCP Number`                       | FCC RHC posted-services filings (the enrollment side)                      |
| `fcc-rhc_spin-lookup_20260615.tsv`                                |  22K | `SPIN`                             | Service Provider Identification Number lookup                              |
| `txhhsc_nursing-facilities_20260611.tsv`                          | 1176 | `Facility ID`                      | TX HHSC licensed nursing facilities — **carries a `Geo Location` lat,lon** |
| `txhhsc_nursing-facility-closures_20260608.tsv`                   |  403 | `Facility ID`                      | TX HHSC closed nursing facilities                                          |
| `txhhsc_hospital-based-nursing-facilities_20260611.tsv`           |    6 | `Facility ID`                      | TX HHSC hospital-based nursing facilities                                  |

## Column mappings

### NPPES registry → `SourceRecord`

| field          | column(s)                                                                             |
| -------------- | ------------------------------------------------------------------------------------- |
| `id`           | `NPI`                                                                                 |
| `organization` | `Provider Organization Name (Legal Business Name)` (Entity Type Code `2`)             |
| `name`         | `Provider First Name` + `Provider Last Name (Legal Name)` (Entity Type Code `1`)      |
| `address`      | `Provider First Line Business Practice Location Address` + City + State + Postal Code |
| `phone`        | `Provider Business Practice Location Address Telephone Number`                        |

The mailing-address columns (`Provider First Line Business Mailing Address` + …) give the address-variation
records in the dedup benchmark. Practice-location secondary addresses live in the separate
`practice-locations` file (same `NPI` key).

### FCC RHC posted-services → `SourceRecord`

| field          | column(s)                                                            |
| -------------- | -------------------------------------------------------------------- |
| `id`           | `HCP Number`                                                         |
| `organization` | `HCP Name`                                                           |
| `address`      | `Site Address Line 1` + `Site City` + `Site State` + `Site ZIP Code` |
| `phone`        | `Contact Phone`                                                      |
| `email`        | `Contact E-mail`                                                     |

### FCC RHC commitments → `SourceRecord` (explode: two records per row)

Each row carries a **Filing HCP** and a **Participating HCP** — explode into two records:

| field          | Filing HCP                                    | Participating HCP                                    |
| -------------- | --------------------------------------------- | ---------------------------------------------------- |
| `id`           | `Filing HCP`                                  | `Participating HCP`                                  |
| `organization` | `Filing HCP Name`                             | `Participating HCP Name`                             |
| `address`      | `Filing HCP Street` + City + State + Zip Code | `Participating HCP Street` + City + State + Zip Code |

`Service Provider ID` joins to `fcc-rhc_spin-lookup` (`SPIN`).

### TX HHSC nursing-facilities → `SourceRecord`

| field          | column(s)                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `id`           | `Facility ID`                                                                                        |
| `organization` | `Facility Name`                                                                                      |
| `address`      | `Physical Address` + `Physical Address CITY` + `Physical Address State` + `Physical Address Zipcode` |
| `phone`        | `Facility Phone Number`                                                                              |
| `coordinate`   | `Geo Location` (`lat,lon` — the pre-geocoded seed + geocoder-validation ground truth, #619)          |

`Medicare Provider Number` / `Medicaid Provider Number` are present and could later join to NPPES via CMS
certification data.

## Join structure

- **Within NPPES:** the `NPI` keys registry ↔ other-names ↔ practice-locations. This is what makes the
  dedup benchmark's NPI-as-ground-truth possible (#617).
- **Across sources:** there is **no shared key.** NPPES (`NPI`), FCC RHC (`HCP Number` / `Filing HCP`), and
  TX HHSC (`Facility ID`) are independent id spaces. Resolution across them is by **geocoded location +
  name/org agreement** — the cross-dataset correlation (#618). A resolved entity spanning ≥2 sources is the
  link we surface for review.
- **Latent bridges** (not yet used): `Medicare/Medicaid Provider Number` (TX HHSC ↔ CMS ↔ NPPES), `SPIN`
  (FCC commitments ↔ spin-lookup). These would corroborate geo-resolved links where present.

## Provenance

All files are public downloads: NPPES from the NPPES NPI Registry, FCC RHC from the USAC/FCC open-data
portal, TX HHSC from the Texas Health and Human Services open-data site. Dates in the filenames are
download dates. No credentials, no scraping — public compliance disclosures in a useless shape, which is
exactly the problem the matcher addresses.
