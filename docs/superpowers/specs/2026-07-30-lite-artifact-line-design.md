# The Lite artifact line — free channel vs subscriber channel (design)

2026-07-30. Operator + Claude. GTM item D1. This is the companion to D2, the public
[database products catalog](../../records/site-2026-08/licensing/data-products.md), which lists the artifacts
this policy applies to. The pricing page shipped first (PRs #1353 / #1355) and
already publishes the OEM band that this doc's registration mechanism depends on.

**No legal counsel exists on this project** (see `docs/superpowers/plans/counsel-dossier.md`).
This document defines policy and mechanics only. It does not draft license text, terms of
service, or a data-use agreement. Every place where an instrument would eventually have to be
written carries a **PENDING COUNSEL** marker, and each such marker gets a numbered entry in the
counsel dossier before anything ships.

## 1. What is being sold

Mailwoman's engine is AGPL and stays AGPL. The commercial license sells release from the
copyleft condition, and it does not sell access to the code. Neither costs us anything on a recurring basis, so pricing
only those two things would mean selling a perpetual grant against a one-time build.

The recurring cost is the **data**. Rebuilding the admin gazetteer takes a ten-minute build on top
of a multi-hour ingest, a verify check, a swap, and a publish. poi.db is a four-country DuckDB
pass over a 13.68M-row Overture release, and the situs extracts are a 50-state ingest. Somebody has to
run those builds, grade them, and pay the R2 bill. That work repeats, so a subscription fits it.

This follows the MaxMind GeoLite model. The parts of that model are:

1. The engine is free and open, and the data channel does not affect it.
2. A free data channel exists on worse terms than the paid one. The difference is a
   published, mechanical rule and not a quality setting we can adjust.
3. The free channel requires **registration with a key**. Registration tells us who embeds
   the data and gives us a name to email.
4. The free channel requires **attribution**. The paid channel does not, beyond whatever the
   upstream data's own license demands, which no terms of ours can waive.

## 2. Delay rather than degradation

The first design choice is whether Lite differs from the subscriber artifact by being **older** or by
being **worse**.

**Decision: older.** Lite and subscriber are the same bytes at different times. There is one
build, one verify check, one artifact, and two publish dates.

The argument against degradation is operational. A degraded artifact is a
second product line with a second build recipe, a second verify baseline, a second set of eval
numbers, and a second thing that can regress. "Degraded" also has no natural stopping point, so every
support conversation would become an argument about whether a given miss is the degradation or a bug.
A delayed artifact has neither problem. Its quality is exactly the quality we already graded and
published, and anyone can compute how far behind it is by subtraction.

Delay also fits the data. An address register is a moving record of the world.
Subscribers pay for this quarter's buildings, and Lite users get last quarter's buildings at the same quality.

### 2.1 The cadence proposal

|             | Lite channel                                             | Subscriber channel                           |
| ----------- | -------------------------------------------------------- | -------------------------------------------- |
| Cadence     | the subscriber artifact, republished on a delay          | weekly, where the upstream supports it       |
| Delay       | **90 days** (proposed; operator's call)                  | none                                         |
| Price       | free                                                     | included in the commercial license and above |
| Access      | keyed registration, self-serve                           | keyed, issued with the license               |
| Attribution | required (§4)                                            | upstream obligations only                    |
| Coverage    | identical to the subscriber artifact of the same version | current                                      |
| Support     | none; community issues only                              | per the license tier                         |

Two constraints apply to the "weekly" claim, and both must hold before it appears anywhere
customer-facing:

- **Upstream releases limit how frequently an artifact can be refreshed, so weekly is a maximum and not a promise per artifact.** Overture releases
  roughly monthly, WOF changes continuously, TIGER is annual, BAN updates frequently, and the FCC BDC vintage
  is twice-yearly. An artifact cannot be fresher than its source. The subscriber commitment is
  therefore "we publish within one week of a source release we ingest," and not "a new artifact
  every Monday." The catalog page should give each artifact's verified source cadence in one column.
- **No implementation backs the cadence claim yet.** Today the gazetteer is rebuilt whenever
  the operator rebuilds it (`RELEASING.md`: "Rebuilt periodically as WOF upstream changes"), and
  the HF dataset card has not changed since 2026-05-28. Publishing a weekly commitment
  without a scheduled build would be a promise we would break immediately. §7 makes the scheduled
  build a prerequisite rather than a follow-up.

### 2.2 What the delay is measured against

The delay is measured on the **artifact version**, which every published
path already carries as a date (`gazetteer/2026-07-07a/candidate.db`, `poi/2026-07-20a/poi.db`,
`street/fr/2026-07-10/situs.db`). This needs no schema change or new field. An artifact becomes Lite when it is
re-published under the Lite prefix once its version date is 90 days old. The layer
manifest's `version` and `source_vintage` already tell a consumer exactly how old their copy
is, so a Lite user can always tell how far behind they are from the file itself,
offline. Keep that property. Do not move the channel into the manifest, because
the same bytes would then need two manifests, and the two would drift apart.

## 3. Keyed registration

A key serves to **build a relationship with the user and to collect telemetry**. It explicitly does not
enforce the license, and the docs must say so in those words. The AGPL grant
on everything already published is irrevocable, and the pricing page publishes that commitment
("Published releases stay published").

### 3.1 What a key provides us

- **A name.** A key attaches an email address and a company to a download. Today an embedder is
  invisible until they file an issue. GeoLite works the same way: MaxMind's free tier
  is a lead list that is also a useful product.
- **Volume and shape.** Keys show which artifacts and versions are downloaded, how frequently, and roughly how many
  distinct users download them. That is enough to answer "is anyone using the FR extract" without
  instrumenting anyone's runtime.
- **A notification channel.** When an artifact is rebuilt because the previous one had a bug
  (the #1015 class), we currently have no way to tell anyone.

### 3.2 What a key must never do

- **Never phone home from the runtime.** The key is presented at **download** time and nowhere
  else. Mailwoman parses and geocodes in-process against local files. That stays true, and this feature must
  not weaken the privacy page's architectural claim. A sealed artifact
  keeps working forever without a key, a network connection, or an expiry date.
- **Never expire an artifact.** A lapsed key stops future downloads. It does not disable, phase
  out, or degrade a copy already on disk. There is no kill switch, and adding one later would
  contradict a published commitment.
- **Never check the engine.** npm installs stay keyless.

### 3.3 Mechanics

Today artifacts are published to Cloudflare R2 behind `public.mailwoman.ai` without authentication. A
WAF rule blocks full-file downloads of byte-ranged `.db` objects, so the demo's range
requests keep working without the cost of whole-file egress. The channel split uses the same
infrastructure:

- **Two prefixes.** `lite/` and `subscriber/` sit under the existing artifact layout. Everything
  else stays unchanged: dated immutable paths, byte-range access, and immutable `Cache-Control`.
- **The demo keeps its own path.** The docs demo range-loads `candidate.db` and `poi.db` from
  the public prefix without a key. That is a first-party use of our own artifact and must keep
  working. It is also why the split cannot authenticate everything.
- **Key check at the edge.** The request presents a key, and a Worker validates it and grants a
  short-lived signed URL for the subscriber prefix. The Lite prefix also takes a key, which users obtain
  self-serve through a form.
- **Issuance and rotation.** Lite keys are self-serve, and subscriber keys are issued with the license. Holders can
  rotate both. Revocation exists for abuse (such as a key republished on a torrent), and
  revoking a key never affects artifacts already downloaded.
- **Telemetry scope.** The log records the key id, artifact, version, timestamp, and coarse request origin. IP addresses are
  kept only for the edge log's own window, and we make no attempt to fingerprint an end user. The
  privacy page needs a section on this before the endpoint exists.

> **PENDING COUNSEL — L1.** The registration form collects a name, an email, and a company, so
> it is a personal-data collection under GDPR/CCPA, however small. What notice text must appear
> at the point of collection, what retention period applies to the download log, and does the
> existing privacy page's "we architecturally do not collect" framing need a carve-out written
> rather than an edit? File in the counsel dossier before the form goes up.

> **PENDING COUNSEL — L2.** Under what instrument is the Lite key issued? The AGPL does not fit,
> because it governs code we wrote and not data we compiled, and the commercial license does not fit either. It
> needs to be a short data-use notice that carries the attribution condition of §4 and the
> expectation that the subscriber artifact is not redistributed, and it must sit correctly on top
> of the upstream licenses in §5. Counsel drafts that text. This document only
> specifies what the text must accomplish.

## 4. Attribution

The Lite channel requires visible attribution to Mailwoman, and the subscriber channel does not.
This is the clearest form of the GeoLite trade, and it is the part most likely to be
misunderstood internally, so the two layers are stated separately:

**Layer 1 — the upstream data's own attribution.** This layer is non-negotiable, applies to both channels, and is not
ours to sell. WOF, Overture (CDLA-Permissive-2.0), GeoNames (CC-BY 4.0), and BAN (license
Ouverte 2.0) each require attribution from anyone who redistributes their data, and paying us
does not release anyone from that. The catalog page lists these per artifact. Any marketing that
implies the subscriber tier removes attribution entirely is false and must be corrected.

**Layer 2 — our own attribution condition on the Lite channel.** Lite users must show a visible credit wherever the
artifact's output is user-facing, in the form "geocoding by Mailwoman". The subscriber tier
waives this condition, because it is ours to waive.

> **PENDING COUNSEL — L3.** Can we attach an attribution condition to a compiled
> artifact whose upstream inputs are public domain or CC0, and if so, on what basis? The answer likely differs by
> jurisdiction (database compilation right in the EU vs. contract in the US). The working assumption is that the condition is part of the **download agreement**
> and is not a claim of copyright over the facts. That assumption is exactly what needs checking, and
> the entire Lite line depends on it.

> **PENDING COUNSEL — L4.** What is the exact WOF license? The repo contradicts itself. The
> licensing pages say **CC0**, `resolver-wof-sqlite/README.md` and the Hugging Face dataset card
> say **CC-BY 4.0**, and `THIRD_PARTY_NOTICES.md` says WOF draws on several sources with their own
> licenses. If WOF is CC-BY, the gazetteer carries a standing attribution obligation in _both_
> channels, and the data-provenance table is wrong. Resolve this before publishing an attribution
> policy that depends on it. This is a fact-finding task first and a counsel task second, because
> the upstream license page may answer the question without a lawyer.

## 5. What is gateable, and what is not

The rule fits in one sentence: **an artifact can enter the two-channel line only if every upstream
source folded into it is permissive.** When a source is share-alike, its license sets the artifact's redistribution
terms, so restricting access would be both unenforceable and misleading.

### 5.1 Gateable — permissive upstreams only

| Artifact                                   | Upstreams                                      | Their terms                                                          |
| ------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------- |
| Admin/candidate gazetteer (`candidate.db`) | WOF, Overture divisions, GeoNames, Census ZCTA | CC0-or-CC-BY (see L4), CDLA-Permissive-2.0, CC-BY 4.0, public domain |
| `poi.db`                                   | Overture Places                                | CDLA-Permissive-2.0 (attribution)                                    |
| US situs extracts                          | Overture addresses, OpenAddresses              | CDLA-Permissive-2.0; OA is per-source — see the caveat below         |
| US interpolation extracts                  | Census TIGER/Line                              | public domain                                                        |
| FR situs extract                           | BAN                                            | Licence Ouverte 2.0 (we elect this over BAN's dual ODbL)             |
| `un-locode.db`                             | UNECE UN/LOCODE code list                      | public domain                                                        |
| Neural weights bundles                     | corpus filtered with `--exclude-share-alike`   | permissive by construction                                           |
| `bdc.db` (planned)                         | FCC BDC availability filings                   | US government public record                                          |

Two caveats are mandatory:

- **OpenAddresses is an aggregator and has no single license.** Its collection mixes CC0, CC-BY, OGL,
  and ODbL/CC-BY-SA rows, depending on the source. The US situs line currently rests on a **measurement**. A
  2026-06-14 audit found the US Overture address set to be NAD (68%, US public domain) plus
  OpenAddresses (32%, government open data) with **zero** ODbL rows, which is why the build
  applies no license filter. A measurement is the right basis for a decision and the wrong basis
  for a standing product. Before the US situs extracts enter the line, that audit becomes a
  build-time filter over the per-row `source` column, with a test. If a future Overture release
  silently adds an ODbL contributor, the build then fails.
- **Copy the corpus filter.** `SHARE_ALIKE_PATTERN` /
  `--exclude-share-alike` already does this job on the training side, and it is why the
  weights contain no share-alike data. The artifact side needs the same filter, wired to the per-row `source`
  column the address-point schema already carries.

### 5.2 Not gateable — share-alike, stays unconditional and opt-in

| Artifact                              | Why                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| OSM rooftop extracts (`osm/`)         | ODbL. Already publish-blocked pending counsel; a paid channel would be the wrong direction of travel.                                 |
| OSM-derived POI/infrastructure layers | ODbL. The layer interface already puts these at `build-local`: we ship the builder, the user builds on their own disk.                |
| Overture `base`-theme derivatives     | ODbL. Overture does not launder OSM's license.                                                                                        |
| `timezone.db`                         | timezone-boundary-builder is ODbL; attribution and share-alike apply to the built database. The builder ships; the database does not. |

The reasoning is stated once here so that it is not argued again for each artifact. ODbL share-alike on a
Derivative Database means every recipient may redistribute it under the same terms. A paid access check
on such an artifact cannot be enforced. Charging for it would also tell the
buyer they had bought something exclusive, when they had bought a copy of something they
are obliged to pass on. The `build-local` tier exists to avoid that, and it
stays the answer.

**`nuts.db` is unresolved.** The repo records an attribution string (© EuroGeographics) for
Eurostat GISCO NUTS boundaries and no license identifier at all. Until the actual terms are
known, we cannot say whether it is gateable. Its status is unknown, and an artifact with unknown status
stays out of the line.

> **PENDING COUNSEL — L5.** What are the Eurostat GISCO NUTS boundary terms (the EuroGeographics component in
> particular), and may a compiled `nuts.db` be redistributed at all? Fact-finding comes first.

> **PENDING COUNSEL — L6.** Does a _permissively-sourced_ artifact built in the same build
> system as ODbL artifacts stay free of ODbL obligations? Confirm there is no argument that sharing
> one pipeline, one data root, or one publish path creates a derivative-database relationship.
> The architecture already assumes there is none (data-provenance's four quarantine mechanisms). This question asks
> counsel to confirm the assumption now instead of discovering a problem later.

## 6. What the Lite line explicitly does not do

These constraints are permanent. Each exists because its opposite is a commitment we would have to break
later, and the pricing page already publishes durable commitments we intend to keep.

1. **No retroactive withdrawal.** An artifact published on the Lite channel stays published at
   that URL. Immutable dated paths make this the default. Do not add a cleanup job that removes
   published artifacts.
2. **No silent quality difference.** If the two channels ever differ in anything other than date, the catalog page
   documents the difference before it ships.
3. **No runtime metering.** This repeats §3.2 because a well-meaning feature request is more likely to
   erode this claim than any other.
4. **No restrictions on anything AGPL.** The weights bundles ship on npm under the same dual license
   as the code and stay there. If a weights bundle ever enters the Lite line, it does so as an
   _additional_ distribution channel and never as a replacement for the npm package.
5. **No third channel.** There are two channels and one rule. An "academic tier" or a "startup tier" is a
   discount on the subscriber channel and not a new artifact line.

## 7. Prerequisites, in order

These items ship as separate changes. The order matters because the early items are what
make the later claims true.

1. **Resolve the WOF license question (L4).** This is fact-finding. It blocks any published attribution
   policy that covers the gazetteer.
2. **Publish the catalog page (D2).** It is already drafted alongside this doc. The Lite line is
   meaningless without a public inventory that lists each artifact and its tier.
3. **Build the share-alike filter for situs extracts.** Add a per-row `source`-column filter with a
   test, following the corpus-side `--exclude-share-alike`. Until it lands, the US situs line
   stays out of §5.1.
4. **Put the artifact builds on a schedule.** A cadence claim needs a scheduled build behind it.
   This is the largest item and the one most likely to be underestimated.
5. **Set up key issuance and the edge check.** This covers the Worker, the form, and the download log. It is blocked on L1.
6. **Write the instruments.** L2 and L3 are written with counsel, once counsel exists.
7. **Publish the channel terms** in the OEM section of the pricing page and on the catalog page.

Steps 1–4 are ours and need no lawyer. Steps 5–7 are the ones likely to stall, so do
1–4 first regardless of when counsel appears.

## 8. Open questions for the operator

1. **Is 90 days the right delay?** It is a proposal and not a finding. A shorter delay makes Lite a real
   product and weakens the subscription. A longer one makes Lite a demo. MaxMind's GeoLite equivalent
   differentiates on accuracy instead of delay, so there is no directly comparable number to
   copy.
2. **Does the OEM band get its own channel behavior?** The pricing page sets OEM bands by customer
   reach. The Worker design changes depending on whether an OEM's _end customers_ need their own keys or the OEM redistributes
   under one key. The cheapest answer is that the OEM's key
   covers their redistribution and their customers never see ours.
3. **Which artifact goes first?** `poi.db` is the cleanest candidate. It has one permissive upstream,
   a manifest that already records tier and license, and a version already on a dated path, and the
   OpenAddresses caveat does not apply to it. The gazetteer is the most valuable but depends on L4.
4. **Does the free channel need a coverage floor?** If Lite is 90 days behind, an artifact
   rebuilt less frequently than every 90 days is identical in Lite and subscriber, and the tier
   distinction disappears for that artifact. That is acceptable, but the docs should state it
   before users discover it.

## See also

- [Database products catalog](../../records/site-2026-08/licensing/data-products.md) — the artifact
  inventory this policy applies to (D2).
- [Pricing](../../records/site-2026-08/licensing/pricing.mdx) — the published tiers and the OEM band.
- [Data licensing & provenance](../../records/site-2026-08/licensing/data-provenance.md) — the per-source
  license table and the ODbL boundary this document's §5 rule is derived from.
- [Spatial-layer interface](../../engineering/reference/layer-interface.mdx) — the
  shipped/build-local/private tiers.
- `docs/superpowers/plans/counsel-dossier.md` — where every PENDING COUNSEL marker above is
  filed.
