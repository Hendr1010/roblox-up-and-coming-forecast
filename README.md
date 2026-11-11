# Roblox Up-and-Coming forecast

Predicts Roblox's Up-and-Coming top 10 for the 72 hours after the deadline.

## How it works

`main.ts` (Node 22, standard library only) reads `/input/history.ndjson` and
`/input/task.json`, and writes `/output/forecast.json` with two keys:
`probabilities` (a probability for each game at each of places 1–10) and
`top10` (the ten most likely games, in order).

The model is an empirical rank-transition forecast. The chart's order churns
every few hours, so instead of assuming it will not move, the program learns
from the whole history how ranks move: for every pair of reads at most 72
hours apart it records where a game that started at a rank ended up, grouped
by starting-rank band (5 ranks) and lag band (12 hours). A game's probability
of being at a place is the average, over the lag bands, of the share of games
that started in its band and ended at that place. A share (0.30) of every
place is left unnamed, so a game the forecast did not name still scores above
the floor. A game that will age past the chart's 28-day limit during the
window is downweighted by the fraction of the window it stays eligible for,
when its creation date is known.

## Local test

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Run it twice on the same history: the two outputs must be byte-identical.

## Backtest (practice history, 34 reads)

Rolling backtests on the practice history (build a forecast from a prefix,
score it against the later reads) put this model about 10–15 log points ahead
of the house baseline at every cut, e.g. −41.0 vs −51.8 (12 reads) and −36.9
vs −52.1 (8 reads). The baseline scores −43.51 on the real practice window.
