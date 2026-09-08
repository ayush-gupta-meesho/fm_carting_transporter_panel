# One-off live audits (not part of the assertion suite)

These read a CSV export of the live sheet from `live/` and answer a specific money question. They are
kept because the *question* recurs every billing cycle, not because they assert anything.

| script | question it answers |
|---|---|
| `fold.js` | do all Regular non-default (replacement) trips fold onto a contracted vehicle, or is KM stranded? Answer on 2026-09-04: 1,155 trips / 82,742 km all fold; **0 km unattributed**. |
| `xvendor.js` | is any plate a contracted vehicle of two vendors (double fixed charge)? is any plate claimed by two vendors on the same date? Answer: no shared contracted plates, 4 same-day collisions, all Rajkot. |
| `xmoney.js` | what do the 118 cross-vendor-plate trips (5,990 km) cost? Answer: Rs 80,514 excess as billed vs Rs 93,618 if KM followed the plate = **Rs 13,104**, all of it Buraq/Yah Yah in Mumbai; Rajkot is Rs 0 because nobody is near their slab. |

Run from the repo root with `live/` populated: `node testkit/audit/xmoney.js`
(or point it elsewhere: `LIVE_DIR=/path/to/csv node testkit/audit/xmoney.js`).

`fold.js` additionally needs `apps-script/Code.gs` and `apps-script/Billing.gs` — it runs the real
engine, it does not re-implement it. Edit the two paths near the top if the repo moves.

Findings are written up in `docs/MIS_PREFLIGHT_2026-09-04.md` sections 4 and 5.
