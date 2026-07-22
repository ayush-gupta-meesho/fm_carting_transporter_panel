# FM Carting Pilot — Field Observations & Discussion Points

**Purpose:** Share what we observed in the early days of the pilot, the learnings from each, and the points to align on with the ground team. These are discussion points for a shared review, not final conclusions.

---

## A. Vehicle usage patterns

### 1. Same vehicle operating under two vendors
**Observation:** A single vehicle was seen operating under two different vendors — consistent with an aggregator model where the vehicle is hired out and run across two separate 12-hour shifts.

**Learnings:**
- This is a plausible and expected pattern, especially as we expand into high-density areas. The system already handles this case correctly.
- If the same pattern appears under a **24-hour** contract, it points to the vehicle not being utilised to its full contracted capacity.

**For discussion:** Confirm this is acceptable behaviour in high-density clusters, and agree on a check for 24-hour contracts where cross-vendor use may indicate under-utilisation.

### 2. Same vehicle set as a default under two contracts of different sizes (same vendor)
**Observation:** The same vehicle appeared as a default vehicle under two contracts of different sizes for one vendor. This happened because the first trip of both an 8FT and a 10FT contract was run with the same larger (10FT) vehicle.

**Learnings:**
- Where vendors can cross-utilise one vehicle across routes, it can lead to over-contracting.
- It also complicates automatic classification of default vehicles.

**Proposed next step:** Capture default vehicle numbers from vendors **at the time of contract acceptance**, rather than inferring them from the first trips.

---

## B. Trip classification & data accuracy

### 3. RTO-Only trips from hub closure discrepancies
**Observation:** 5 of ~120 trips were classified as RTO-Only, traced to closure handling at FM hubs.

**Positive:** One vendor has already accepted an RTO trip with 0 KM accumulation — validating that the RTO flow works as intended end to end.

**For discussion:** Align on the correct closure process at FM hubs to reduce RTO-Only classifications going forward.

### 4. Trips created with an incorrect vehicle size
**Observation:** Two trips were recorded at 8FT while the vendor's contract was 10FT, so the system classified them as Adhoc. A reclassification attempted during the confirmation flow could not attribute them to a contract (no contract ID), so they surfaced to the vendor as adhoc trips and remain unconfirmed.

**Learning:** Reinforces the importance of accurate trip creation (correct vehicle size) at source; after-the-fact reclassification depends on correct contract attribution.

**Next step:** These specific trips will be corrected. Raising here first to build shared focus on right-first-time trip creation.

### 5. Incorrect RFQ upload for zonal routes
**Observation:** RFQs for zonal routes were uploaded incorrectly, which caused those trips to be flagged as Adhoc.

**Position:** We will not build one-off exception handling in the system for this. The correct RFQs will be updated at source (owner: Aniruddh Gupta).

**For discussion:** Confirm ownership and timeline for updating the correct zonal-route RFQs.

---

## C. Contract sizing

**Observation:** Utilisation projections indicate over-contracting in several cases — **6 contracts are currently projecting under 50%** of their KM slab.

**For discussion:** Review sizing for low-utilisation contracts and agree on a right-sizing approach for the next cycle.

---

## Summary of proposed actions

| # | Proposed action | Owner (to confirm) |
|---|---|---|
| 1 | Capture default vehicle numbers from vendors at contract acceptance | Ground / Ops |
| 2 | Align correct closure process at FM hubs to reduce RTO-Only trips | Ground / FM Hubs |
| 3 | Reinforce right-first-time trip creation (correct vehicle size) | Ground |
| 4 | Update correct zonal-route RFQs at source (no system exceptions) | Aniruddh Gupta |
| 5 | Review and right-size low-utilisation contracts | Ground / Ops |
