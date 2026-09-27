# `Norwegian Licence for Open Government Data (NLOD) 2.0` — as retrieved

- Source: `https://raw.githubusercontent.com/spdx/license-list-data/main/text/NLOD-2.0.txt`, with
  `https://data.norge.no/nlod/en/2.0` returning HTTP 200 on the same date
- Retrieved: 2026-09-21
- Publisher: the responsible Norwegian ministry, named in the text as the Ministry of Local
  Government and Modernisation
- Version stated in the text: 2.0

An earlier pass recorded `data.norge.no/nlod/en/2.0` as returning HTTP 406 to an automated fetch. It
returned HTTP 200 on 2026-09-21, so that record was a transient failure rather than a refusal, and
`PROVENANCE.md` is corrected. The text below is from SPDX, which publishes it as plain text.

This is the grant the register's Brønnøysund entity register row would be read against.

Every quotation below is in a fenced block so the publisher's own spelling and wording survive a
prose sweep. No text inside a fence is edited.

## What the license grants

```text
2. Licence

The licensee, subject to the limitations that follow from this licence, may use the information for
any purpose and in all contexts, by:

     * copying the information and distributing the information to others,
     * modifying the information and/or combining the information with other information, and
     * copying and distributing such changed or combined information.

This is a non-exclusive, free, perpetual and worldwide licence. The information may be used in any
medium and format known today and/or which will become known in the future. The Licensee shall not
sub-license or transfer this licence.
```

"For any purpose and in all contexts" reaches commercial use. The last sentence is the one to read
before any commercial-sublicense reading: the licensee may not sub-license the grant itself.

## The exemptions

```text
3. Exemptions
The licence does not apply to and therefore does not grant a right to use:

     * information which contains personal data covered by the Norwegian Personal Data Act unless
       there is a legitimate basis for the disclosure and further processing of the personal data
     * information distributed in violation of a statutory obligation to observe confidentiality
     * information excluded from public disclosure pursuant to law, including information deemed
       sensitive under the Norwegian National Security Act
     * information subject to third party rights which the licensor is not authorised to license to
       the licensee
     * information protected by intellectual property rights other than copyright and neighbouring
       rights in accordance with Chapter 5 of the Norwegian Copyright Act, such as trademarks,
       patents and design rights …

If the licensor has made available information not covered by the licence according to the above
list, the licensee must cease all use of the information under the licence, and erase the
information as soon as he or she becomes aware of or should have understood that the information is
not covered by the licence.
```

The first exemption carves personal data out of the grant itself. A source under this license is
therefore not fully granted by the license alone, which is why `AddressSourceRecord` carries a
`personalDataReview` apart from its license decision.

## The attribution condition

```text
5. Attribution
The licensee shall attribute the licensor as specified by the licensor and include a reference to
this licence. To the extent practically possible, the licensee shall provide a link to both this
licence and the source of the information.

If the licensor has not specified how attributions shall be made, the licensee shall normally state
the following: «Contains data under the Norwegian licence for Open Government data (NLOD)
distributed by [name of licensor]».

If the information has been changed, the licensee must clearly indicate that changes have been made
by the licensee.
```

Four requirements in one section: attribute as the licensor specifies, reference the license, link to
both the license and the source where practical, and state that the information was changed. A record
carrying only "attribution required" loses the last three.

## What this text does not settle

Whether a statistical model trained on information under this license is itself covered. The text
does not address a model, where CDLA-Permissive-2.0 does. No election is made here, and every license
decision in `address-source-register.json` still reads `unchecked`.
