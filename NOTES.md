# Notes

## What was tried

1. **v1 — fast path + char-by-char slow path.** Records whose line held no quote
   and no stray CR were sliced and `split(',')`; any other line fell back to a
   char-by-char reader mirroring the reference. Practice exact; parse ~224 ms
   (trimmed mean, 9 runs) vs baseline ~565 ms. Profiling showed ~81% of records
   contain a quote, so the slow path dominated.
2. **v2 — unified parser, bulk unquoted stretches.** Slow records now cut their
   unquoted spans with one `slice` + `split(',')` per stretch instead of one
   delimiter scan per field. Practice exact; parse ~192 ms.
3. **v3 — bounded CR scans.** `indexOf('\r', pos)` and the two scans inside
   `quotedContent` could run far ahead in LF files (stray CRs are ~1 per 250
   records). The quoted-content check now slices first and scans the slice; the
   record loop strips a CRLF CR with a one-character check and finds stray CRs
   by scanning the slice. Practice exact; parse ~169 ms.
4. **v4 — cut fields straight from the text.** Replaced `slice` + `split(',')`
   per stretch with an `indexOf(',')` loop that slices each field directly out
   of the input (no stretch copy, no parts array). Practice exact; parse
   ~86–94 ms — about 5.4x the baseline's ~508 ms on the same harness.

## Bug found by fuzzing (v4)

A differential fuzz against the vendor reference (30,000 random adversarial
inputs per seed, 3 seeds) caught a bug the practice set never exercises: in the
stretch that ends at a quote, the partial-field branch called
`readUnquoted(lastPart)` without first moving `pos` to the quote, so the
field's first character was read twice (`b"` became `bb"`). Fixed by setting
`pos = bound` before the call. After the fix: 90,000 fuzz cases exact, plus 30
fresh cases drawn with the kit's own generator under 5 other seeds exact.

## Timing (this machine, Node 24.22.1)

- Parse only, 6-case practice set, trimmed mean of 9 runs: entry ~94 ms,
  baseline ~508 ms (~5.4x). Whole `main.ts` run (incl. JSON parse of the 11 MB
  input and stringify of the 12 MB output plus Node start-up, wall ms, median
  of 5): entry ~792 ms, baseline ~1517 ms (~1.9x).
- `grade-local --driver process`: 6 of 6 cases, `passed: 1`, L1 regrade
  reproduced byte for byte. Two direct runs of `main.ts` are byte-identical.
- The grader notes the local Node (v24.22.1) differs from the server harness
  (v26.13.1); that changes only the recorded result hash, not the score.
- Repo size 13,854 bytes total — far under the 1 MiB cap.
