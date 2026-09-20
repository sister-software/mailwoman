# SIRENE — the publication, as retrieved

- Source: `https://www.data.gouv.fr/datasets/base-sirene-des-entreprises-et-de-leurs-etablissements-siren-siret/`
- Retrieved: 2026-09-21
- Publisher: Institut national de la statistique et des études économiques (INSEE)
- Terms named on the page: `Licence Ouverte / Open Licence version 2.0`, archived beside this as
  `licence-ouverte-2.0.md`
- Last update stated on the page: 2026-09-01

## What the publication offers

Twelve primary files, as six pairs in ZIP and Parquet: the stock of legal units, active and ceased; historicized values
of legal units; the stock of establishments, active and closed; historicized values of establishments; establishment
succession links; and SIREN duplicates. Twelve documentation files accompany them, in PDF and CSV.

## Personal data, quoted and paraphrased

The page states the dataset carries personal data subject to the GDPR and French data-protection law, and that a reuser
must respect its dissemination-status codes.

For a sole trader or a legal representative who has filed an opposition, INSEE masks specific fields:

> the identity of the entrepreneur (name, first names…), the address in the municipality and geolocation will be masked

Legal-representative contact information is not published by INSEE at all, whatever the opposition status, under
article R 123-232 of the commercial code.

## What this page does not settle

**Territory coverage.** The register maps nine overseas jurisdictions to SIRENE — BL, GF, GP, MF, MQ, PM, RE, WF and
YT — and this page lists national stock files rather than a per-territory breakdown. Whether every one of those nine is
present in the resource is a question the files answer and this page does not. Counsel's direction is explicit that the
mapping is not evidence of presence.

**Whether the masking suffices for what we do.** INSEE masks an opposed sole trader's identity, municipality address
and geolocation at the source, which is a stronger starting position than a dataset with no opt-out. Whether a model
trained on the unmasked remainder can memorize an address, and what measures that calls for, is a separate reading from
the license.
