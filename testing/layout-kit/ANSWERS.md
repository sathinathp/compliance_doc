# Layout kit: answer sheet

Every file is the same fictional license, written in a different layout. Upload them all for the worker **Alex Example** (Clinical, RN, state CA).

The correct values for every file:

| Field | Value |
|---|---|
| Document type | Professional license |
| Name on document | Alex Example |
| Document number | QA-RN-1048 |
| State | CA |
| Issued | 2025-01-15 (Jan 15, 2025) |
| Expires | 2028-12-31 (Dec 31, 2028) |

| Layout | What it tests | Read by code alone | With AI |
|---|---|---|---|
| L01 plain colon | `Name: Alex Example` | 6/6 | 6/6 |
| L02 no colons | `Name    Alex Example` | 4/6 (name, state left for AI) | 6/6 |
| L03 table, two columns | label cell, value cell | 6/6 | 6/6 |
| L04 table across | labels in one row, values in the row below | 6/6 Word, 1/6 PDF | 6/6 |
| L05 half table | sentence plus a small table | 6/6 Word, 4/6 PDF | 6/6 |
| L06 bullets | `• Name: Alex Example` | 6/6 | 6/6 |
| L07 sentence | "This is to certify that Alex Example…" | 6/6 | 6/6 |
| L08 two per line | two fields on one line | 6/6 | 6/6 |
| L09 value below label | label, gap, value on the next line | 6/6 | 6/6 |
| L10 value above label | certificate style, caption under the value | 6/6 | 6/6 |
| L11 capitals, other dates | `LIC #`, `31 DEC 2028` | 6/6 | 6/6 |
| L12 other label words | Holder, Lic. No., Effective, Exp. Date | 6/6 | 6/6 |
| L13 noisy page | birth date, printed-on date, another person's license | 6/6 | 6/6 |
| `*-photo.jpg` (4 files) | a phone photo of L03, L07, L10, L13 | 0/6 (pictures need AI) | 6/6, sent for confirmation |

What the code cannot read is left blank for the AI. It is never filled with a guess.

To see what the code and the AI read for any file, without uploading it:

```
node scripts/read-evidence.js testing/layout-kit/L04-table-across.pdf --text
```
