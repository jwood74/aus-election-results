# AEC Election Results Dashboard

A web dashboard for visualising Australian federal election results from the AEC (Australian Electoral Commission) XML media feed. Static HTML/JS hosted on GitHub Pages, with a Cloudflare Worker serving live data.

## Architecture

```
AEC FTP Server                            Dashboard (GitHub Pages)
     |                                          |
     | FTP (every 5 min via GitHub Action)      | GET /feed/{id} (auto-refreshes every 60s)
     v                                          v
GitHub Action ──POST /upload/{id}──▶ Cloudflare Worker ◀── KV Storage
                                                            (gzip-compressed XML)
```

1. **GitHub Action** runs on a 5-minute cron. Downloads the latest zip from AEC's FTP server, extracts the XML, and POSTs it to the Worker.
2. **Cloudflare Worker** gzip-compresses the XML and stores it in KV. Serves it to the dashboard with caching and CORS headers.
3. **Dashboard** fetches XML from the Worker, parses it, and renders sortable/filterable tables. Auto-refreshes every 60 seconds.

## Project Structure

```
index.html                      Main page — all contests in a sortable/filterable table
contest.html                    Detail page — per-polling-place results for a single contest
config.json                     Election config: IDs, names, Worker feed URLs
css/styles.css                  All styling
js/shared.js                    Shared constants, XML helpers, formatting, rendering
js/app.js                       Index page logic (parsing, rendering, filtering, TCP picker)
js/contest.js                   Contest detail page logic (booth-level parsing, vote types, pref flow)
worker/worker.js                Cloudflare Worker source
worker/wrangler.toml            Cloudflare Worker config (KV namespace bindings)
.github/workflows/
  fetch-aec-feed.yml            GitHub Action: FTP download → Worker upload
docs/
  media-feed-user-guide-v4-4.pdf  AEC XML feed format documentation
```

## Party Groupings

| Group | Party Codes            |
|-------|------------------------|
| ALP   | ALP                    |
| L/NP  | LP, NP, LNP, CLP, NTA |
| GRN   | GRN                    |
| ONP   | ON                     |
| OTH   | Everything else        |

Defined in `js/shared.js` as `ALP_CODES`, `LNP_CODES`, `GRN_CODES`, `ONP_CODES`.

---

## Cloudflare Worker

**Deployed at:** `https://aec-election-feed.jwood748787.workers.dev`

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/feed/{electionId}` | No | Serve XML from KV (cached, CORS-enabled) |
| `GET` | `/status/{electionId}` | No | Last-updated timestamp, sizes, current cache TTL |
| `POST` | `/upload/{electionId}` | Bearer token | Upload XML — compresses and stores in KV |
| `POST` | `/admin/cache-ttl` | Bearer token | Set cache TTL in seconds |
| `OPTIONS` | `*` | No | CORS preflight |

### KV Storage

XML files (~35MB) exceed KV's 25MB value limit, so they are **gzip-compressed** before storing (~2-4MB). The Worker decompresses on serve; Cloudflare's edge handles re-compression to the client.

Key patterns:
- `xml:{electionId}` — gzip-compressed XML
- `meta:{electionId}` — JSON: `{ updatedAt, originalSize, compressedSize }`
- `config:cache-ttl` — cache TTL in seconds (default: 300)

### KV Namespaces

| Namespace | Purpose |
|-----------|---------|
| `AEC_DATA` (production) | Used by the deployed Worker |
| `AEC_DATA` (preview) | Used by `wrangler dev` for local testing — isolated from production |

### Authentication

Upload and admin endpoints require `Authorization: Bearer {secret}`. The secret is stored as:
- **Worker:** `wrangler secret put UPLOAD_SECRET`
- **GitHub Action:** repo secret `AEC_WORKER_UPLOAD_SECRET`

### CORS

Allows requests from `https://jaxenwood.com` and `http://localhost*`.

---

## GitHub Action

**File:** `.github/workflows/fetch-aec-feed.yml`

Runs every 5 minutes (`*/5 * * * *`) or on manual dispatch. Steps:

1. Lists FTP directory at `ftp://mediafeedarchive.aec.gov.au/{electionId}/Detailed/Verbose/`
2. Downloads the most recent `.zip` file (filenames sort chronologically)
3. Extracts `xml/*.xml` from the zip
4. POSTs the XML to the Worker's `/upload/{electionId}` endpoint

To disable between elections: pause the workflow in GitHub Actions UI. Re-enable before election night.

---

## Election Night Operations

### Cache TTL

Default is 300s (5 minutes). On election night, reduce to 60s:

```bash
# Election night mode (60s cache)
curl -X POST \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"ttl":60}' \
  "https://aec-election-feed.jwood748787.workers.dev/admin/cache-ttl"

# Back to normal (5 min cache)
curl -X POST \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"ttl":300}' \
  "https://aec-election-feed.jwood748787.workers.dev/admin/cache-ttl"
```

### Auto-Refresh

The dashboard auto-refreshes every 60 seconds. The status bar shows:
- **AEC data updated** — when the GitHub Action last uploaded fresh data
- **Last checked** — when the browser last fetched from the Worker

No manual page refresh needed on election night.

### Checklist

1. Update `ELECTION_ID` in `.github/workflows/fetch-aec-feed.yml`
2. Update `config.json` with the new election ID in the feed URL
3. Enable the GitHub Action workflow
4. Set cache TTL to 60s (see above)
5. Manually trigger the workflow once to seed initial data
6. Verify: `curl https://aec-election-feed.jwood748787.workers.dev/status/{electionId}`

---

## Adding a New Election

1. Update `ELECTION_ID` in both steps of `.github/workflows/fetch-aec-feed.yml`
2. Update `config.json`:
   ```json
   {
     "elections": [
       {
         "id": "NEW_ID",
         "name": "2025 By-Election",
         "files": [
           "https://aec-election-feed.jwood748787.workers.dev/feed/NEW_ID"
         ]
       }
     ]
   }
   ```
3. Trigger the GitHub Action to upload initial data
4. Multiple elections can be listed — the dashboard will show all contests combined

---

## Worker Deployment

```bash
cd worker
wrangler login                              # one-time
wrangler kv namespace create AEC_DATA       # note the ID
wrangler kv namespace create AEC_DATA --preview  # note the preview ID
# Update wrangler.toml with both IDs
wrangler secret put UPLOAD_SECRET           # enter a strong random string
wrangler deploy
```

For local development:

```bash
cd worker
wrangler dev    # uses preview KV namespace — isolated from production
```

---

## Index Page Columns

All data parsed from contest-level XML elements. At this level, the AEC provides accurate `Percentage` and `Swing` attributes directly.

### TCP Group

| Column | Formula | Source |
|--------|---------|--------|
| **%** | `Percentage` attribute from `TwoCandidatePreferred/Candidate/Votes` | XML attribute |
| **Swing** | `Swing` attribute from the same `Votes` element | XML attribute |
| **Prediction** | `historicTcpPct + tcpSwing` | Computed (see below) |

**TCP Prediction:**
- `historicTcpPct = historicVotes / totalHistoricTcpVotes * 100`
- `historicVotes` = `Historic` attribute on each TCP candidate's `Votes` element (full previous election result)
- `totalHistoricTcpVotes` = sum of `Historic` across both TCP candidates
- During counting, TCP % only reflects booths counted so far (which may skew one way). The prediction estimates the final result by adding the current swing to the full historic baseline.

### Primary % Group

| Column | Formula | Source |
|--------|---------|--------|
| **ALP** | `Percentage` for ALP candidates | XML attribute |
| **L/NP** | Sum of `Percentage` for LP + NP + LNP + CLP + NTA | XML attributes, summed |
| **GRN** | `Percentage` for GRN candidates | XML attribute |
| **ONP** | `Percentage` for ONP candidates | XML attribute |
| **OTH** | Sum of `Percentage` for all other non-Ghost candidates | XML attributes, summed |

### Primary Swing Group

| Column | Formula | Source |
|--------|---------|--------|
| **ALP, L/NP, GRN, ONP** | `Swing` attribute for each party's candidate | XML attribute |

### Booths Group

| Column | Formula | Source |
|--------|---------|--------|
| **Total** | `PollingPlacesExpected` on `FirstPreferences` | XML attribute |
| **Primary** | `PollingPlacesReturned` on `FirstPreferences` | XML attribute |
| **TCP** | `PollingPlacesReturned` on `TwoCandidatePreferred` | XML attribute |

### Totals Row

Averages across all visible (filtered) contests for percentage/swing columns. Booth columns show sums.

---

## Contest Detail Page Columns

Per-polling-place rows from `<PollingPlace>` elements. At booth level, the AEC sets `Percentage` and `Swing` to `0`, so all values are computed from vote counts.

### Core Columns

| Column | Formula | Source |
|--------|---------|--------|
| **Polling Place** | `Name` attribute from `PollingPlaceIdentifier` | XML attribute |
| **Expected Votes** | `Historic` attribute on `FirstPreferences/Total/Votes` | XML attribute |
| **Votes Cast** | Text content of `FirstPreferences/Total/Votes` | XML element text |
| **Updated** | Latest `Updated` value from `PollingPlace`, `FirstPreferences`, or `TwoCandidatePreferred`; displayed as time only | XML attribute |

### TCP Group

| Column | Formula | Source |
|--------|---------|--------|
| **%** | `candidateVotes / formalVotes * 100` | Computed |
| **Swing** | `currentPct - (historicVotes / historicFormalVotes * 100)` | Computed |

### Primary % Group

| Column | Formula | Source |
|--------|---------|--------|
| **ALP, L/NP, GRN, ONP, OTH** | `candidateVotes / formalVotes * 100` | Computed |

### Primary Swing Group

| Column | Formula | Source |
|--------|---------|--------|
| **ALP, L/NP, GRN, ONP** | `currentPct - (historicVotes / historicFormalVotes * 100)` | Computed |

### Preference Flow Group

| Column | Formula | Source |
|--------|---------|--------|
| **-> ALP** | `(alpTcpVotes - alpPrimaryVotes) / otherFormalVotes * 100` | Computed |
| **-> L/NP** | `(lnpTcpVotes - lnpPrimaryVotes) / otherFormalVotes * 100` | Computed |

Where `otherFormalVotes = formalVotes - alpPrimaryVotes - lnpPrimaryVotes`. Represents the percentage of minor-party/independent votes flowing to each major party via preferences.

### Vote-Type Rows

Appended after polling place rows, aggregated by vote type:
- **Absent**, **Provisional**, **Pre-Poll**, **Postal**

Same formulas as polling place rows, sourced from `VotesByType` sub-elements.
The **Updated** column is shown only when the feed supplies an `Updated` timestamp on the relevant special-vote elements; otherwise it is blank.

### Totals Row

Contest-level aggregates in the table header. Uses accurate XML `Percentage`/`Swing` attributes (with computed fallbacks).

---

## TCP Candidate Selection

- **Index page**: Global party-group selector (ALP, L/NP, GRN, etc.) stored in `localStorage` key `"index-tcp-group"`. Per-contest overrides by clicking the TCP % cell.
- **Contest page**: Individual candidate selector stored in `localStorage` key `"tcp-candidate-{contestId}"`.

## Data Source

XML media feed from the [Australian Electoral Commission](https://results.aec.gov.au/). Feed format documented in `docs/media-feed-user-guide-v4-4.pdf`.
