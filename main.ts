// roblox-up-and-coming-forecast-01 entry (Node 22, standard library only):
// an empirical rank-transition forecast of Roblox's Up-and-Coming top 10.
//
// The chart is volatile: its order churns every few hours and games leave it
// as they age past 28 days, so a forecast that the chart will not move (the
// house baseline) scores badly. This program instead learns, from the whole
// history, how ranks move: for every pair of reads no more than 72 hours
// apart it records where a game that started at a rank ended up, grouped by
// starting-rank band (5 ranks) and by lag band (12 hours). For each game on
// the chart as it stands when the history ends, its probability of being at
// a place is the average, over the lag bands, of the share of games that
// started in its band and ended at that place. That is the honest
// distribution the log score rewards: a game is given the probability the
// history says it holds that place, and a share of every place is left
// unnamed, so a game the forecast did not name still scores above the floor.
//
// A game's age is folded in when the history carries it: a game published
// within the last 28 days is on the chart only while it is younger than 28
// days, so a game that will age out during the scored window is downweighted
// by the fraction of the window it stays eligible for (never below 0.15, and
// never adjusted when no creation date is known). The top 10 is the ten
// games with the highest total probability of holding any of the ten places.
//
// It reads /input/history.ndjson and /input/task.json (or the directories
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR name) and writes
// /output/forecast.json. It is deterministic: no randomness, no clock, no
// network; the same history always yields the same bytes.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
/** The scored window is 72 hours; transitions are only taken within it. */
const MAX_LAG_HOURS = 72;
/** Starting ranks are grouped in bands this wide. */
const RANK_BAND = 5;
/** Lags are grouped in bands this wide, in hours. */
const LAG_BAND_HOURS = 12;
/** Share of each place left unnamed, shared by the games not named there (keeps unnamed games above the log floor). */
const UNNAMED = 0.3;
/** A game is on the chart only while younger than this, in days. */
const CHART_AGE_DAYS = 28;
/** The smallest age factor a game keeps, so a game ageing out mid-window
    still holds some probability for the hours before it leaves. */
const MIN_AGE_FACTOR = 0.15;
/** Rows below this probability are dropped (they would not move the score). */
const MIN_P = 0.002;

interface ChartRow {
  rank: number;
  universe_id: number;
  playing: number;
}

interface Detail {
  name: string;
  playing: number;
  visits: number;
  favorites: number;
  max_players: number;
  created: string | null;
  updated: string | null;
  creator_name: string;
  creator_type: string;
  genre: string | null;
}

interface Read {
  at: string;
  up_and_coming: ChartRow[];
  details: Detail[] | null;
}

interface Task {
  places: number;
  output: string;
  window: { from: string; until: string };
}

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as Task;
const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l !== '');
const reads = lines.map((l) => JSON.parse(l) as Read);

// --- Per-read rank maps, and the latest known creation date per game. ---
const rankAt: Array<Map<number, number>> = [];
for (const read of reads) {
  const m = new Map<number, number>();
  for (const g of read.up_and_coming) m.set(g.universe_id, g.rank);
  rankAt.push(m);
}
// The details rows carry no universe id, so match them to games by name
// (names are unique on the chart) using the read's own up-and-coming rows.
const createdAt = new Map<number, number>();
for (const read of reads) {
  if (!read.details) continue;
  const byName = new Map<string, number>();
  for (const g of read.up_and_coming) byName.set(g.name, g.universe_id);
  for (const d of read.details) {
    const uid = byName.get(d.name);
    if (uid === undefined || !d.created) continue;
    const t = Date.parse(d.created);
    if (!Number.isNaN(t)) createdAt.set(uid, t);
  }
}

// --- Rank-transition counts: (start band, lag band) -> end rank -> count. ---
const times = reads.map((r) => Date.parse(r.at));
const dist = new Map<string, Map<number, number>>();
for (let i = 0; i < reads.length; i++) {
  for (let j = i + 1; j < reads.length; j++) {
    const lagH = (times[j]! - times[i]!) / 3600000;
    if (lagH > MAX_LAG_HOURS) break;
    const lagBand = Math.min(Math.floor(lagH / LAG_BAND_HOURS), 5);
    for (const [uid, r0] of rankAt[i]!) {
      const r1 = rankAt[j]!.get(uid);
      if (r1 === undefined) continue;
      const band = Math.min(Math.floor(r0 / RANK_BAND), 10);
      const key = `${band}:${lagBand}`;
      let m = dist.get(key);
      if (!m) {
        m = new Map<number, number>();
        dist.set(key, m);
      }
      m.set(r1, (m.get(r1) ?? 0) + 1);
    }
  }
}

// --- Age factor: the fraction of the scored window a game stays eligible. ---
const windowFrom = Date.parse(task.window.from);
const windowUntil = Date.parse(task.window.until);
const windowMs = windowUntil - windowFrom;
function ageFactor(uid: number): number {
  const created = createdAt.get(uid);
  if (created === undefined || windowMs <= 0) return 1;
  const eligibleUntil = created + CHART_AGE_DAYS * 86400000;
  const frac = (Math.min(eligibleUntil, windowUntil) - windowFrom) / windowMs;
  return Math.max(MIN_AGE_FACTOR, Math.min(1, frac));
}

// --- The chart as it stands when the history ends. ---
const last = [...reads[reads.length - 1]!.up_and_coming].sort((a, b) => a.rank - b.rank);
const chart = last.map((g) => g.universe_id);
const curRank = new Map<number, number>(last.map((g) => [g.universe_id, g.rank] as [number, number]));

// --- For each place, the transition distribution of every game on the chart. ---
const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];
for (let place = 1; place <= task.places; place++) {
  const ws: Array<[number, number]> = [];
  for (const uid of chart) {
    const r0 = curRank.get(uid)!;
    const band = Math.min(Math.floor(r0 / RANK_BAND), 10);
    let p = 0;
    let nb = 0;
    for (let lb = 0; lb <= 5; lb++) {
      const d = dist.get(`${band}:${lb}`);
      if (!d) continue;
      let tot = 0;
      for (const c of d.values()) tot += c;
      p += (d.get(place) ?? 0) / tot;
      nb++;
    }
    p = nb > 0 ? p / nb : 0;
    p *= ageFactor(uid);
    ws.push([uid, p]);
  }
  let tot = 0;
  for (const [, w] of ws) tot += w;
  for (const [uid, w] of ws) {
    const p = tot > 0 ? (1 - UNNAMED) * (w / tot) : 0;
    if (p >= MIN_P) probabilities.push({ universe_id: uid, place, p: Math.round(p * 1e6) / 1e6 });
  }
}

// --- The top 10: the ten games with the highest total probability. ---
const totalP = new Map<number, number>();
for (const r of probabilities) totalP.set(r.universe_id, (totalP.get(r.universe_id) ?? 0) + r.p);
const top10 = [...totalP.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([uid]) => uid)
  .slice(0, task.places);
for (const uid of chart) {
  if (top10.length >= task.places) break;
  if (!top10.includes(uid)) top10.push(uid);
}

writeFileSync(join(OUTPUT_DIR, task.output), `${JSON.stringify({ probabilities, top10: top10.slice(0, task.places) })}\n`);
