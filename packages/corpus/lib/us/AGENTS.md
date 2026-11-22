# AGENTS.md — corpus sources for United States

## How this repository elects address data

The United States position is the US factual-data reading, decided by the operator on 2026-10-17.

Street addresses, house numbers, place names and postcodes are facts. US copyright excludes facts (Feist Publications, Inc. v. Rural Telephone Service Co., 499 U.S. 340 (1991)), and copyright in a compilation covers only an original selection or arrangement. A complete address list lacks one. US law has no sui generis database right. A US federal work is also public domain under 17 U.S.C. § 105.

A US public body's address or register file published without terms restricting its use is therefore elected with basis `other-documented`, citing Feist. Terms that spell out a restricted use remain a refusal, because a contract binds where copyright doesn't: the FCC Fabric's CostQuest license, the Hawaii Department of Education's commercial-use prohibition, Cook County's redistribution clause.

An indemnity allocates liability and restricts no use, so it isn't a refusal. A decision whose terms require the user to indemnify, defend or hold harmless the publisher records the clause as an `indemnity` obligation in the publisher's words, and its operations stand as the rest of the terms decide them. The data bill of materials, `mailwoman doctor` and the layer's `NOTICE.txt` show the clause. A clause that only states the publisher isn't liable, or a statute that holds it harmless by law (A.R.S. 37-178), binds no user and isn't an indemnity. Any other condition the terms set, such as a mailing-list ban or a disclaimer to pass on, goes in the decision's `obligations` in the publisher's words (`packages/license/lib/decision.ts`).

The reading covers rows published by a US body about US addresses. It doesn't reach a US-hosted aggregator's copy of another country's data. That data keeps that country's position.

The shared rules for reading a publisher's terms are in `packages/corpus/AGENTS.md` under "License election". This file states only the country's legal position on address data. Those rules defer to it.
