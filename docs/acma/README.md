# Radio licensing documents — copies as they stood on 10 November 2026

These are the documents Flood-Net's **🪪 Radio Licensing** lesson (Knowledge
base) and the **📜 ACMA licences** tool (Stations map) quote from. They are kept
here so that a rule quoted in the app can be opened at the sentence, and so
there is a record of what the rules said on the day the guide was written.

**They are a snapshot, not the current rules.** ACMA replaces a RALI without
notice and a determination can be amended — the Fixed Licence determination was
amended twice in its first year. Open the current version (linked below, and
beside every quotation in the app) before relying on any of it.

## What is here

| File | What it is | Standing | Current version |
|---|---|---|---|
| `rali-fx16-2025-03-25.pdf` | RALI FX16 — frequency assignment requirements for the point-to-multipoint service in the VHF high, 400 MHz and 800 MHz bands. In effect from 25 March 2025. | ACMA policy | [acma.gov.au](https://www.acma.gov.au/sites/default/files/2025-11/rali_fx16.pdf) · [list of RALIs](https://www.acma.gov.au/ralis-frequency-coordination) |
| `rali-fx19-2026-07-02.pdf` | RALI FX19 — coordination and licensing of point-to-multipoint and short-range wireless broadband in 1900–1920 MHz. In effect from 2 July 2026. Not Flood-Net's band; kept for what it says about working beyond a planned range. | ACMA policy | [acma.gov.au](https://www.acma.gov.au/sites/default/files/2026-07/rali_fx19_02_07_26.pdf) |
| `fixed-licence-determination-2025-compilation-2-F2026C00349.pdf` | Radiocommunications Licence Conditions (Fixed Licence) Determination 2025, Compilation No. 2 — the text in force from 21 March 2026. | The law | [legislation.gov.au](https://www.legislation.gov.au/F2025L00388/latest/text) |
| `fixed-licence-determination-2025-as-made-F2025L00388.pdf` | The same determination as first made, registered 21 March 2025. **Superseded** on 23 September 2025. | Replaced | [all versions](https://www.legislation.gov.au/F2025L00388/latest/versions) |
| `fixed-licence-determination-2025-explanatory-statement.pdf` | ACMA's explanatory statement to the determination, registered 21 March 2025. | ACMA's explanation | [legislation.gov.au](https://www.legislation.gov.au/F2025L00388/asmade/text/explanatory-statement) |
| `text/*.json` | Each document's words, page by page, for the app's reader. Built by `tools/acma_docs.py`. | — | — |
| `text/law.json` | Short extracts, copied by hand, of the Act and four instruments the guide quotes (the version each came from is in the file). | The law | [Radiocommunications Act 1992](https://www.legislation.gov.au/C2004A04465/latest/text) |

### What changed between the two versions of the determination

The copy first supplied was the determination as made. Two instruments have
amended it since:

- **Radiocommunications (Fixed Licence (Point to Multipoint System)) Amendment
  Instrument 2025 (No. 1)** (F2025L01056), from 23 September 2025: a new licence
  type, the *fixed licence (point to multipoint system)*, for 3400–3475 MHz and
  3950–4000 MHz — new definitions in section 5, a new Part 10 and Schedule 1.
- **Radiocommunications (Radio Altimeter Measures) Amendment Instrument 2026
  (No. 1)** (F2026L00301), from 21 March 2026: a note added to section 32.

Sections 2 and 4 (commencement and repeal) were removed as spent. **Parts 2 to
9 — everything that applies to a point-to-multipoint station below 1 GHz,
sections 12 to 16 and 22 to 25 among them — read the same in both.**

## Where they came from, and the terms

- The two RALIs and the as-made determination were supplied by the owner as
  downloaded from ACMA's website and the Federal Register of Legislation. The
  compilation and the explanatory statement were downloaded from the Federal
  Register of Legislation on 10 November 2026.
- **ACMA's documents** — © Commonwealth of Australia (Australian Communications
  and Media Authority), reproduced unaltered under the
  [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
  licence ACMA publishes its material on.
- **Legislation** — based on content from the Federal Register of Legislation
  at 10 November 2026. For the latest information on Australian Government law
  please go to <https://www.legislation.gov.au>. Reproduced under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- The Commonwealth Coat of Arms on the determination's cover is not covered by
  that licence; the file is the unaltered official document and is not to be
  used in any way that suggests endorsement.

Nothing here is legal advice, and keeping a copy does not make Flood-Net a
source for these documents: cite ACMA and the Federal Register.

## Replacing a copy

1. Put the new PDF beside the old one (keep the old one if the app still
   quotes it) and point `DOCS` in `tools/acma_docs.py` and `licence-docs.js` at
   it.
2. `python3 tools/acma_docs.py` rebuilds `text/`.
3. `cd test && npm run licensing` — it fails every quotation that is no longer
   on its page, word for word. Read each one against the new text: a rule that
   moved needs its page changed; a rule that changed needs the guide changed.
4. Change `SNAPSHOT` in `licence-docs.js` and the date at the top of this page.

SHA-256, first 16 characters: FX16 `c409ff23d1c22aae` · FX19 `ecad752305715da2`
· compilation `827b9ec3cf6692e7` · as made `811fc96edf70f2e8` · explanatory
statement `5be88faccc0d5f52`.
