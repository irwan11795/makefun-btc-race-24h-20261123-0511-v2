// cbBTC 24h race bot v2 — range-only challenger, long only.
//
// FINAL (graded 17:1x WIB 23 Nov): dev +$13.61, 3 round trips, 3/3 wins,
// max DD 0.32%, exposure 21%, fees $1.21. Official grade-local action log
// 0682f07b20f4. That is 2.2x v1 (+$6.09) on the same dev window.
//
// What changed vs v1 and why:
//  - Momentum leg DISABLED (momRet60Bps 9999): on this dev window the
//    momentum leg alone lost -$9.21 (14 fills, 14% win) — its SMA-cross exit
//    whipsaws in chop. The range leg carries all of the profit.
//  - Range leg inverted to +150/-60 at 50% size (v1 was +80/-120 at 25%):
//    breakeven win rate falls from ~63% to ~28%. On dev all three round
//    trips exited on the reclaim (close >= SMA90 + 60 bps), so the TP/stop
//    values are non-binding here — the edge is buying the -60 bps dip and
//    selling the reclaim, not the TP level.
//  - Washout leg (-400 bps all-in) KEPT as an untested lottery ticket for a
//    live dump day; it never fired on dev (240-bar return never below -122).
//
// Honest weaknesses (Hermes review + our own checks): only 3 round trips,
// so the 100% win rate is small-sample (P(3/3) ~6% under a 40% null, and we
// selected across variants); on a grind-up live day with no -60 bps dip the
// bot can sit in cash and make ~$0; after a stop the next bar can re-enter
// immediately, so two stops can burn in one chop sequence and retire the leg.
// The dev day's buy-and-hold was +$36.40 — this bot captures 37% of it.
//
// Everything is bigint arithmetic. The bot reads nothing but the bars the
// harness sends: no clock, no network, no randomness, no files.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const CBBTC = 'CBBTC';
const SLIP_BPS = 100;
const BPS = 10000n;

// One place for every tuned number.
const CFG = {
  // Momentum leg: breakout above the 90-bar average with a rising 60-bar return.
  momPremiumBps: 30n,
  momRet60Bps: 9999n,
  momSizePct: 50n,
  momStopBps: 300n,
  momCapBars: 1440,
  // Momentum exit mode: 'sma' = exit when close falls under SMA90;
  // 'trail' = exit when worth falls momTrailBps under its peak; 'none' = hold to stop/cap.
  momExitMode: 'trail' as const,
  momTrailBps: 150n,
  // Range leg: buy the discount, wider take than stop, re-entry allowed.
  rangeFloorBps: -300n,
  rangeDiscountBps: 60n,
  rangeTakeBps: 150n,
  rangeStopBps: 60n,
  rangeMaxBars: 360,
  rangeSizePct: 50n,
  rangeMaxStops: 2,
  // Washout leg: unchanged from v1 (lottery ticket for a dump day).
  washoutTriggerBps: -400n,
  washoutStopBps: 300n,
  washoutMaxBars: 500,
} as const;

// Mutable race state.
const S = {
  closes: [] as bigint[],
  leg: null as 'W' | 'M' | 'R' | null,
  barsHeld: 0,
  holding: false,
  buyPending: false,
  rangeStops: 0,
  peakWorth: 0n,
};

// 240-bar return in bps, or null while the history is too short.
function ret240(): bigint | null {
  const n = S.closes.length;
  if (n < 241) return null;
  const now = S.closes[n - 1];
  const then = S.closes[n - 241];
  return (now * BPS) / then - BPS;
}

// 60-bar return in bps, or null while the history is too short.
function ret60(): bigint | null {
  const n = S.closes.length;
  if (n < 61) return null;
  const now = S.closes[n - 1];
  const then = S.closes[n - 61];
  return (now * BPS) / then - BPS;
}

// Mean of the last 90 closes, or null while the history is too short.
function avg90(): bigint | null {
  const n = S.closes.length;
  if (n < 90) return null;
  let total = 0n;
  for (let i = n - 90; i < n; i++) total += S.closes[i];
  return total / 90n;
}

// One order that sells the whole position.
function flatten(qty: bigint): OrderInput[] {
  return [{ side: 'sell', symbol: CBBTC, qty, max_slippage_bps: SLIP_BPS }];
}

// Buy `pct` percent of the spendable cash (capped by weight room).
function buyPct(state: BarsState, pct: bigint): OrderInput[] {
  const room = state.weightRoom(CBBTC);
  const want = (state.cash * pct) / 100n;
  const spend = want < room ? want : room;
  const minSpend = BigInt(state.hello.fees.min_notional_quote_units);
  if (spend <= 0n || spend < minSpend) return [];
  return [{ side: 'buy', symbol: CBBTC, notional_quote_units: spend, max_slippage_bps: SLIP_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Bank this bar before anything else, warm-up included: the
    // indicators need the warm-up history behind the scored window.
    for (const b of batch.bars) {
      if (b.symbol === CBBTC) S.closes.push(BigInt(b.c));
    }
    if (state.warmingUp) return [];

    const pos = state.positions.get(CBBTC);
    const close = state.close(CBBTC);

    // The buy we sent never landed: forget the leg we tentatively armed.
    if (S.buyPending && pos === undefined) {
      S.buyPending = false;
      S.leg = null;
    }

    if (pos !== undefined) {
      S.buyPending = false;
      if (!S.holding) {
        S.barsHeld = 0;
        S.holding = true;
        S.peakWorth = 0n;
      } else {
        S.barsHeld += 1;
      }
      if (close === null) return [];
      const worth = state.value(CBBTC, pos.qty);
      const paid = pos.cost;
      if (worth > S.peakWorth) S.peakWorth = worth;

      if (S.leg === 'W') {
        const stopped = worth <= (paid * (BPS - CFG.washoutStopBps)) / BPS;
        if (stopped || S.barsHeld >= CFG.washoutMaxBars) return flatten(pos.qty);
        return [];
      }
      if (S.leg === 'M') {
        // Trailing regime exit: the tape fell back under its 90-bar average,
        // or worth fell momTrailBps under its peak, depending on the mode.
        const avg = avg90();
        if (CFG.momExitMode === 'sma' && avg !== null && close < avg) return flatten(pos.qty);
        if (CFG.momExitMode === 'trail' && worth <= (S.peakWorth * (BPS - CFG.momTrailBps)) / BPS) return flatten(pos.qty);
        if (worth <= (paid * (BPS - CFG.momStopBps)) / BPS) return flatten(pos.qty);
        if (S.barsHeld >= CFG.momCapBars) return flatten(pos.qty);
        return [];
      }
      if (S.leg === 'R') {
        const avg = avg90();
        if (worth >= (paid * (BPS + CFG.rangeTakeBps)) / BPS) return flatten(pos.qty);
        if (avg !== null && close * BPS >= avg * (BPS + CFG.rangeDiscountBps)) return flatten(pos.qty);
        if (worth <= (paid * (BPS - CFG.rangeStopBps)) / BPS) {
          S.rangeStops += 1;
          return flatten(pos.qty);
        }
        if (S.barsHeld >= CFG.rangeMaxBars) return flatten(pos.qty);
        return [];
      }
      return [];
    }

    S.holding = false;
    S.leg = null;
    if (close === null) return [];
    const ret = ret240();
    const r60 = ret60();

    // Washout entry: flat and the 4-hour slide is at least -400 bps.
    if (ret !== null && ret <= CFG.washoutTriggerBps) {
      const orders = buyPct(state, 100n);
      if (orders.length > 0) {
        S.leg = 'W';
        S.barsHeld = 0;
        S.buyPending = true;
        return orders;
      }
      return [];
    }

    // Momentum entry: flat, close above the average plus premium, and the
    // 60-bar return is rising. Buys all-in and rides with no fixed TP.
    if (ret !== null && r60 !== null && r60 >= CFG.momRet60Bps) {
      const avg = avg90();
      if (avg !== null && close * BPS >= avg * (BPS + CFG.momPremiumBps)) {
        const orders = buyPct(state, CFG.momSizePct);
        if (orders.length > 0) {
          S.leg = 'M';
          S.barsHeld = 0;
          S.buyPending = true;
          return orders;
        }
        return [];
      }
    }

    // Range entry: flat, leg alive, tape not sliding, close discounted.
    if (S.rangeStops < CFG.rangeMaxStops && ret !== null && ret > CFG.rangeFloorBps) {
      const avg = avg90();
      if (avg !== null && close * BPS <= avg * (BPS - CFG.rangeDiscountBps)) {
        const orders = buyPct(state, CFG.rangeSizePct);
        if (orders.length > 0) {
          S.leg = 'R';
          S.barsHeld = 0;
          S.buyPending = true;
          return orders;
        }
        return [];
      }
    }

    return [];
  },
});
