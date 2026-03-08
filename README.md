# AEC Election Results Dashboard

A static web dashboard for visualising Australian federal election results from the AEC (Australian Electoral Commission) XML media feed. No build tools or server required — open `index.html` in a browser.

## Project Structure

```
index.html          Main page — all contests (electorates) in a sortable/filterable table
contest.html        Detail page — per-polling-place results for a single contest
config.json         Election config: election ID, name, and XML file paths
css/styles.css      All styling
js/shared.js        Shared constants, XML helpers, formatting, rendering utilities
js/app.js           Index page logic (parsing, rendering, filtering, TCP dropdown)
js/contest.js       Contest detail page logic (booth-level parsing, vote types, pref flow)
docs/data/          AEC XML media feed files
```

## Data Flow

1. `config.json` defines which election(s) and XML file(s) to load
2. XML files are fetched and parsed — each `<Contest>` element becomes a row
3. Candidate data is grouped by party (ALP, L/NP, GRN, ONP, OTH) using `AffiliationIdentifier/ShortCode`
4. Tables are rendered with sorting, filtering, and a TCP candidate picker

## Party Groupings

| Group | Party Codes        |
|-------|--------------------|
| ALP   | ALP                |
| L/NP  | LP, NP, LNP, CLP, NTA |
| GRN   | GRN                |
| ONP   | ON                 |
| OTH   | Everything else    |

---

## Index Page Columns

All data is parsed from contest-level XML elements. At this level, the AEC provides accurate `Percentage` and `Swing` attributes directly.

### TCP Group

| Column | Formula | Source |
|--------|---------|--------|
| **%** | `Percentage` attribute from `TwoCandidatePreferred/Candidate/Votes` for the selected TCP candidate | XML attribute (direct) |
| **Swing** | `Swing` attribute from the same `Votes` element | XML attribute (direct) |
| **Prediction** | `historicTcpPct + tcpSwing` | Computed (see below) |

**TCP Prediction detail:**
- `historicTcpPct = historicVotes / totalHistoricTcpVotes * 100`
- `historicVotes` comes from the `Historic` attribute on each TCP candidate's `Votes` element (the full previous election result)
- `totalHistoricTcpVotes` = sum of `Historic` across both TCP candidates
- The prediction adds the current swing (from counted booths) to the full historic result
- During counting this differs from TCP % — TCP % only reflects booths counted so far (which may skew), while the prediction estimates the final result

### Primary % Group

| Column | Formula | Source |
|--------|---------|--------|
| **ALP** | `Percentage` attribute for ALP candidates | XML attribute |
| **L/NP** | Sum of `Percentage` for all L/NP candidates (LP + NP + LNP + CLP + NTA) | XML attributes, summed |
| **GRN** | `Percentage` attribute for GRN candidates | XML attribute |
| **ONP** | `Percentage` attribute for ONP candidates | XML attribute |
| **OTH** | Sum of `Percentage` for all non-major, non-Ghost candidates | XML attributes, summed |

### Primary Swing Group

| Column | Formula | Source |
|--------|---------|--------|
| **ALP** | `Swing` attribute for ALP candidate | XML attribute |
| **L/NP** | `Swing` attribute (first L/NP candidate found) | XML attribute |
| **GRN** | `Swing` attribute for GRN candidate | XML attribute |
| **ONP** | `Swing` attribute for ONP candidate | XML attribute |

### Booths Group

| Column | Formula | Source |
|--------|---------|--------|
| **Total** | `PollingPlacesExpected` attribute on `FirstPreferences` element | XML attribute |
| **Primary** | `PollingPlacesReturned` attribute on `FirstPreferences` element | XML attribute |
| **TCP** | `PollingPlacesReturned` attribute on `TwoCandidatePreferred` element | XML attribute |

### Totals Row (filter bar)

Averages across all visible (filtered) contests for percentage/swing columns. Booth columns show sums.

---

## Contest Detail Page Columns

Per-polling-place rows parsed from `<PollingPlace>` elements within a contest. At booth level, the AEC always sets `Percentage` and `Swing` attributes to `0`, so all values must be computed from vote counts.

### Core Columns

| Column | Formula | Source |
|--------|---------|--------|
| **Polling Place** | `Name` attribute from `PollingPlaceIdentifier` | XML attribute |
| **Expected Votes** | `Historic` attribute on `FirstPreferences/Total/Votes` | XML attribute (previous election's total votes at this booth) |
| **Votes Cast** | Text content of `FirstPreferences/Total/Votes` | XML element text |

### TCP Group

| Column | Formula | Source |
|--------|---------|--------|
| **%** | `candidateVotes / formalVotes * 100` | Computed from vote counts (XML `Percentage` is always 0 at booth level) |
| **Swing** | `currentPct - (historicVotes / historicFormalVotes * 100)` | Computed (XML `Swing` is always 0 at booth level) |

Where:
- `candidateVotes` = text content of `TwoCandidatePreferred/Candidate/Votes` for the selected TCP candidate
- `formalVotes` = text content of `FirstPreferences/Formal/Votes`
- `historicVotes` = `Historic` attribute on the TCP candidate's `Votes` element
- `historicFormalVotes` = `Historic` attribute on `FirstPreferences/Formal/Votes`

### Primary % Group

| Column | Formula | Source |
|--------|---------|--------|
| **ALP, L/NP, GRN, ONP, OTH** | `candidateVotes / formalVotes * 100` | Computed from vote counts |

L/NP and OTH are summed across all matching candidates. Same party grouping rules as index page.

### Primary Swing Group

| Column | Formula | Source |
|--------|---------|--------|
| **ALP, L/NP, GRN, ONP** | `currentPct - (historicVotes / historicFormalVotes * 100)` | Computed from vote counts and historic data |

### Preference Flow Group

| Column | Formula | Source |
|--------|---------|--------|
| **-> ALP** | `(alpTcpVotes - alpPrimaryVotes) / otherFormalVotes * 100` | Computed |
| **-> L/NP** | `(lnpTcpVotes - lnpPrimaryVotes) / otherFormalVotes * 100` | Computed |

Where `otherFormalVotes = formalVotes - alpPrimaryVotes - lnpPrimaryVotes`. This represents the percentage of minor-party/independent votes that flowed to each major party via preferences.

### Vote-Type Rows

Appended after polling place rows, these aggregate data by vote type:
- **Absent Votes** — `VotesByType/Votes[@Type="Absent"]`
- **Provisional Votes** — `VotesByType/Votes[@Type="Provisional"]`
- **Pre-Poll Votes** — `VotesByType/Votes[@Type="PrePoll"]`
- **Postal Votes** — `VotesByType/Votes[@Type="Postal"]`

Same column formulas as polling place rows, but sourced from `VotesByType` sub-elements rather than top-level `Votes`.

### Totals Row

Contest-level aggregates displayed in the table header. Unlike booth-level data, the AEC provides accurate `Percentage` and `Swing` attributes at this level, so XML attributes are used directly (with computed fallbacks).

---

## TCP Candidate Selection

Both pages support switching which TCP candidate's data is displayed:

- **Index page**: Global party-group selector (ALP, L/NP, GRN, etc.) stored in `localStorage` key `"index-tcp-group"`. Per-contest overrides available by clicking the TCP % cell.
- **Contest page**: Individual candidate selector stored in `localStorage` key `"tcp-candidate-{contestId}"`.

## Data Source

XML media feed files from the [Australian Electoral Commission](https://results.aec.gov.au/). Feed format documented in `docs/media-feed-user-guide-v4-4.pdf`.
