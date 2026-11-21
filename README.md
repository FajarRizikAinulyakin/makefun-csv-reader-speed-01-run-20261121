# csv-reader-speed — a faster drop-in for csv-reader 1.0.0

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/FajarRizikAinulyakin/makefun-csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/FajarRizikAinulyakin/makefun-csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

An entry for the make.fun competition `csv-reader-speed-01-run-20261121`
(Read broken CSV files faster, 21 November 2026).

`solve.js` is a dependency-free ES module whose `run(input)` returns, for every
case's `{text, header}` input, exactly the answer csv-reader 1.0.0 returns:
`{columns, rows, errors}`. `main.ts` is the program the harness runs: it reads
every case from `/input/cases.json`, answers each one with `run`, and writes
`/output/answers.json`.

## How it works

The reference reads one character at a time and builds every field by string
concatenation. This reader instead scans with `indexOf` (C++ memchr-class work
in V8) and slices whole fields straight out of the input text, with no
intermediate copies:

- The text is read once, left to right. A U+FEFF at the very start is dropped.
- A record is read field by field. A field that opens with a quote is read by
  the quoted reader (doubled quotes collapse to one, CRLF and lone CR inside
  quotes become LF, junk after the closing quote is appended as it stands, a
  quote that never closes is a literal character and the rest is re-read as
  unquoted). Any other field starts an unquoted stretch, which runs to the next
  quote, line break or end of the text, and whose fields are cut out with one
  `indexOf(',')` per comma. A CR in a stretch is a stray CR (dropped, error
  `stray_cr`), except the CR of a CRLF ending the line.
- A record ends at LF or CRLF; a line left with no characters is no record.
  `columns` is the first record when `header` is true, else null; rows are
  padded with `""` (`short_row`) or cut (`long_row`) to the first record's
  width. Every error is `{code, line, row}` in the order met, with the line the
  record starts on and the record's index in `rows` (null for the header).

Pure: no clock, no randomness, no locale, nothing kept from one call to the
next. No dependencies, no network, no WASM or native addons.

## Run it

Node 22 or later (the grader runs Node 22.23.4):

```sh
# answer the practice set
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## Grade locally

From the unpacked kit directory (Docker is the default driver; `--driver process`
runs the entry on this machine instead):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

The practice set must come back 6 of 6 cases exact (`passed: 1`), and the two
executions must reproduce byte for byte.

## Results (practice set, this machine)

- All 6 practice cases exact, and 30 further cases drawn with the kit's own
  generator under other seeds exact.
- Parse time for the 6-case practice set (trimmed mean of 9 runs, parse only):
  this entry ~94 ms, house baseline (csv-reader 1.0.0) ~508 ms — about 5.4x
  faster. Whole `main.ts` run including JSON parse/serialise: ~792 ms vs
  ~1517 ms for the baseline.

## License

MIT — see `LICENSE`.
