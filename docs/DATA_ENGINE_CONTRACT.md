# VALMO Transporter Panel — Data-Engine Hand-off Spec

**One-line summary:** on every completed trip, the data engine writes the *static facts* into the `Trip_Level` tab (plus keeps the contract-master tabs current). It **never** touches the workflow columns — those are owned by Apps Script (transfer, deadlines, vendor status) and by ground (review edits).

Golden rule: **fill the static columns, leave the workflow columns blank.** If you fill a workflow column by mistake, you break the transfer/dispute logic.

---

## 1. `Trip_Level` — columns the ENGINE fills (per completed trip)

| Column | What to put | Notes |
|---|---|---|
| `row_id` | Unique row key | Stable id for this trip row |
| `trip_id` | Trip id | |
| `transporter_oracle_id` | Vendor oracle id | Scopes the trip to a vendor |
| `contract_id` | Contract this trip belongs to | See **§3 attribution rules** |
| `vehicle_number` | Vehicle that ran the trip | |
| `vehicle_size` | 7ft / 10ft / 22ft … | |
| `trip_cluster` | Cluster the trip ran in | |
| `trip_date` | Date of trip | |
| `trip_start_time` | Start timestamp | |
| `trip_end_time` | **Completion timestamp** | Drives the 24h ground deadline — required, else the trip never transfers |
| `source_node` | Origin node code | |
| `dest_fmh_nodes` | Destination node(s), comma/`>` separated | Panel builds the route from source + these |
| `node_count` | Number of nodes on the route | |
| `route_name` | Optional route label | Panel falls back to this if source/dest empty |
| `challan_type` | `RTO` if return-to-origin, else blank | RTO = 0 billable KM |
| `total_trip_km` | Actual KM run | The KM metric for slab + projections |
| `km_accumulated_flag` | `Yes` if this KM counts toward the slab, else `No` | Regular non-RTO = Yes; RTO/Adhoc = No |
| `billing_type_system` | `Regular` or `Adhoc` | Engine's classification — see **§2** |
| `adhoc_reason_system` | Internal reason for Adhoc (e.g. OUTSIDE_CLUSTER) | Not shown to vendor |
| `replacement_flag_system` | `Yes` if a non-default vehicle stood in for a default | See **§2** |
| `replaced_default_vehicle_system` | The default vehicle_number it stood in for | Required when `replacement_flag_system = Yes` |
| `adhoc_amount` | Rate-card amount for Adhoc trips | Blank/0 for Regular. Engine computes from the real rate card |
| `retention_month` | Month bucket, e.g. `2026-07` | Derive from `trip_date` |

## 2. `Trip_Level` — columns the engine LEAVES BLANK

**Ground fills these manually during the 24h review (optional):**
`ground_confirmed`, `billing_type_final`, `replaced_default_vehicle_final`

**Apps Script fills these automatically — never write them:**
`ground_review_deadline`, `sent_to_vendor_flag`, `sent_to_vendor_timestamp`, `vendor_status`, `dispute_window_end`, `retention_state`

---

## 2b. Classification rules the engine computes

**Regular vs Adhoc (`billing_type_system`)** — engine's existing logic (e.g. inside-cluster contracted work = Regular; outside-cluster / not fitting the contract = Adhoc).

**RTO / accumulation** — `challan_type = RTO` for a return trip (0 billable KM); `km_accumulated_flag = Yes` only when `total_trip_km` should count toward the slab (Regular, non-RTO).

**Replacement** — set `replacement_flag_system = Yes` + `replaced_default_vehicle_system = <default veh no>` **whenever a non-default vehicle runs a trip in place of a contracted (default) vehicle**. This is what lets the panel show "Replacement Regular" and fold that KM into the correct default. (A default vehicle running its own trip is never a replacement, whatever the billing type.)

**Adhoc amount** — `adhoc_amount` = rate-card value for Adhoc trips. If a Regular trip is later reclassified to Adhoc by ground, that amount must be present too.

---

## 3. `contract_id` attribution (which contract a trip belongs to)

**Regular trips**
- Run by a **default vehicle** -> that vehicle's contract.
- Run by a **replacement (non-default) vehicle** -> the contract of the **default it replaced** (`replaced_default_vehicle_system`).

**Adhoc trips — apply in priority order:**
1. **Vehicle match:** `vehicle_number` is a default vehicle of a contract (for this oracle) -> that contract.
2. **Cluster × Size match:** else, the contract for (`transporter_oracle_id`, `trip_cluster`, `vehicle_size`) -> that contract. *(Unique by design — a vendor never has two contracts of the same cluster+size.)*
3. **Other Adhoc:** else -> `contract_id = ADHOC-<transporter_oracle_id>`.

> Vehicle match is checked first because it is exact; cluster×size is the fallback.

---

## 4. Other Adhoc Trips

Adhocs that match neither rule 1 nor 2 get `contract_id = ADHOC-<oracle>` (one bucket per vendor).
- **Scope:** each vendor sees only their own `ADHOC-<oracle>` trips; ground/admin sees all.
- **Billing:** standalone — just `Σ adhoc_amount` for that vendor; no slab.
- The panel renders this bucket like a lightweight contract (trip list + total amount, no slab bar), with the same confirm/dispute behaviour.

---

## 5. Contract-master tabs (static / one-time, keep current)

**`Contract_Info`** — `contract_id, vendor_oracle_id, vendor_name, cluster, vehicle_size, hours_slab, no_of_vehicles, total_km_slab, fixed_monthly_value, ex_km_rate, contract_start_date, contract_end_date, contract_status`

**`Contract_Vehicles`** (one row per default vehicle) — `contract_id, vehicle_number, day1_order, pegged_km_slab, monthly_rate, active_days`

**`Node_Cluster_Map`** — `node_code, cluster, node_type`

The panel treats every vehicle in `Contract_Vehicles` as a **default** for that contract; anything else that appears in trips is a replacement/adhoc vehicle. So `Contract_Vehicles` must list all contracted vehicles accurately.

---

## 6. Month-end billing (context — computed later in a separate sheet)

Per contract:
`fixed_monthly_value + max(0, Σ regular non-RTO total_trip_km − total_km_slab) × ex_km_rate + Σ adhoc_amount`
(the `Σ adhoc_amount` is over trips attributed to that contract, settled = Confirmed/Reconfirmed).

Per vendor "Other Adhoc": `Σ adhoc_amount` of the `ADHOC-<oracle>` trips.

This is why correct `contract_id` attribution and `adhoc_amount` matter — they decide which bill each rupee lands in.

---

## 7. Engine checklist per completed trip

- [ ] Write the 22 static `Trip_Level` columns (§1).
- [ ] Classify `billing_type_system`, set `challan_type` / `km_accumulated_flag` (§2b).
- [ ] If a stand-in vehicle: set `replacement_flag_system` + `replaced_default_vehicle_system`.
- [ ] If Adhoc: compute `adhoc_amount`.
- [ ] Set `contract_id` per §3 (or `ADHOC-<oracle>` per §3.3).
- [ ] Leave all workflow columns (§2) blank.
