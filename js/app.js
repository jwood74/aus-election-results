/**
 * AEC Election Results Dashboard
 *
 * Loads config.json → fetches XML media feed files → parses contest data →
 * renders the results table.
 */

// ── Sort State ───────────────────────────────────────────────────────────────

let allRowsData = [];
let sortState = { key: null, direction: null };

function getSortedRows(rows) {
  if (!sortState.key || !sortState.direction) return rows;
  return [...rows].sort((a, b) => {
    const va = a[sortState.key];
    const vb = b[sortState.key];
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp = typeof va === "string" ? va.localeCompare(vb, "en-AU") : va - vb;
    return sortState.direction === "desc" ? -cmp : cmp;
  });
}

function updateSortIndicators() {
  document.querySelectorAll("thead th[data-sort-key]").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sortKey === sortState.key && sortState.direction) {
      th.classList.add("sort-" + sortState.direction);
    }
  });
}

function initSorting() {
  document.querySelectorAll("thead th[data-sort-key]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (sortState.key !== key) {
        sortState.key = key;
        sortState.direction = "asc";
      } else if (sortState.direction === "asc") {
        sortState.direction = "desc";
      } else {
        sortState.key = null;
        sortState.direction = null;
      }
      updateSortIndicators();
      renderTable(getSortedRows(allRowsData));
    });
  });
}

// ── XML namespace URIs ──────────────────────────────────────────────────────
const NS_FEED = "http://www.aec.gov.au/xml/schema/mediafeed";
const NS_EML  = "urn:oasis:names:tc:evs:schema:eml";

// ── Party short-code groupings ───────────────────────────────────────────────
const ALP_CODES = new Set(["ALP"]);
const LNP_CODES = new Set(["LP", "NP", "LNP", "CLP", "NTA"]);
const GRN_CODES = new Set(["GRN"]);
const ONP_CODES = new Set(["ON"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** First child element matching localName in the feed namespace, or null. */
function childNS(parent, localName) {
  if (!parent) return null;
  for (const node of parent.children) {
    if (node.localName === localName && node.namespaceURI === NS_FEED) return node;
    if (node.localName === localName && node.namespaceURI === null) return node;
  }
  return null;
}

/** All child elements matching localName in the feed namespace. */
function childrenNS(parent, localName) {
  if (!parent) return [];
  return Array.from(parent.children).filter(
    n => n.localName === localName && (n.namespaceURI === NS_FEED || n.namespaceURI === null)
  );
}

/** First child element matching localName in the EML namespace, or null. */
function childEML(parent, localName) {
  if (!parent) return null;
  for (const node of parent.children) {
    if (node.localName === localName && node.namespaceURI === NS_EML) return node;
  }
  return null;
}

/** Get attribute value, returning null if not present. */
function attr(el, name) {
  return el ? el.getAttribute(name) : null;
}

/** Parse a float attribute, returning null if missing/unparseable. */
function floatAttr(el, name) {
  const v = attr(el, name);
  return v !== null ? parseFloat(v) : null;
}

/** Format a float to 2 decimal places, or return "—" if null. */
function fmt(v, decimals = 2) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return v.toFixed(decimals);
}

/** Format a number as an integer with commas, or "—". */
function fmtInt(v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return Math.round(v).toLocaleString("en-AU");
}

/**
 * Return a <td> element with swing formatting.
 * For ALP-perspective swings: positive = blue (good for ALP), negative = red.
 * isAlpPerspective controls the colour direction.
 */
function swingCell(value, isAlpPerspective = false, partyClass = "") {
  const td = document.createElement("td");
  td.className = "col-num";
  if (partyClass) { td.classList.add(partyClass); td.classList.add("col-swing"); }
  if (value === null || isNaN(value)) {
    td.textContent = "—";
    td.classList.add("swing-zero");
    return td;
  }
  const sign = value > 0 ? "+" : "";
  td.textContent = sign + fmt(value);
  if (value === 0) {
    td.classList.add("swing-zero");
  } else {
    td.classList.add(value > 0 ? "swing-pos" : "swing-neg");
  }
  return td;
}

// ── XML Parsing ──────────────────────────────────────────────────────────────

/**
 * Find the `Votes` element that is a direct child of `parent`.
 * (Not descendant — each Candidate has a top-level Votes and VotesByType children.)
 */
function getVotesEl(candidateEl) {
  for (const node of candidateEl.children) {
    if (node.localName === "Votes" && (node.namespaceURI === NS_FEED || node.namespaceURI === null)) {
      return node;
    }
  }
  return null;
}

/**
 * Get the AffiliationIdentifier ShortCode for a Candidate element.
 * Works for both active Candidate and Ghost elements.
 */
function getShortCode(candidateEl) {
  const affEl = childEML(candidateEl, "AffiliationIdentifier");
  return affEl ? attr(affEl, "ShortCode") : null;
}

/**
 * Parse all FirstPreferences candidate data for a Contest element.
 * Returns { alp, lnp, grn, onp, oth } objects with { pct, swing }.
 * Also returns booth counts.
 */
function parseFirstPreferences(contestEl) {
  const fpEl = contestEl.getElementsByTagNameNS(NS_FEED, "FirstPreferences")[0] ||
               contestEl.getElementsByTagName("FirstPreferences")[0];
  if (!fpEl) return null;

  const totalBooths   = parseInt(attr(fpEl, "PollingPlacesExpected"), 10) || null;
  const primaryBooths = parseInt(attr(fpEl, "PollingPlacesReturned"), 10) || null;

  // Accumulate per-group totals
  const groups = {
    alp: { pct: null, swing: null },
    lnp: { pct: 0,    swing: null },
    grn: { pct: null, swing: null },
    onp: { pct: null, swing: null },
    oth: { pct: 0 },
  };

  let lnpFound = false;

  // Process both active Candidate and Ghost elements
  const allCandidates = Array.from(fpEl.children).filter(
    n => n.localName === "Candidate" || n.localName === "Ghost"
  );

  for (const cand of allCandidates) {
    const isGhost = cand.localName === "Ghost";
    const code = getShortCode(cand);
    const votesEl = getVotesEl(cand);
    if (!votesEl) continue;

    const pct   = floatAttr(votesEl, "Percentage");
    const swing = floatAttr(votesEl, "Swing");

    if (ALP_CODES.has(code)) {
      groups.alp.pct   = pct;
      groups.alp.swing = swing;
    } else if (LNP_CODES.has(code)) {
      // Sum for coalitions that may run separately (e.g. LP + NP in same seat)
      groups.lnp.pct   = (groups.lnp.pct ?? 0) + (pct ?? 0);
      // Use the swing of the primary L/NP candidate found
      if (swing !== null && !lnpFound) {
        groups.lnp.swing = swing;
        lnpFound = true;
      }
    } else if (GRN_CODES.has(code)) {
      groups.grn.pct   = pct;
      groups.grn.swing = swing;
    } else if (ONP_CODES.has(code)) {
      groups.onp.pct   = pct;
      groups.onp.swing = swing;
    } else if (!isGhost) {
      // OTH = all active (non-Ghost) candidates not in named groups
      groups.oth.pct += (pct ?? 0);
    }
  }

  // Null out zero lnp.pct if nothing found
  if (groups.lnp.pct === 0 && !lnpFound) groups.lnp.pct = null;

  return { groups, totalBooths, primaryBooths };
}

/**
 * Parse TwoCandidatePreferred (TCP) for the ALP candidate percentage & swing.
 * Returns { pct, swing } or { pct: null, swing: null } if ALP not in TCP.
 */
function parseAlpTCP(contestEl) {
  const tcpEl = contestEl.getElementsByTagNameNS(NS_FEED, "TwoCandidatePreferred")[0] ||
                contestEl.getElementsByTagName("TwoCandidatePreferred")[0];
  if (!tcpEl) return { pct: null, swing: null, booths: null };

  const tcpBooths = parseInt(attr(tcpEl, "PollingPlacesReturned"), 10) || null;

  const candidates = Array.from(tcpEl.children).filter(n => n.localName === "Candidate");
  for (const cand of candidates) {
    const code = getShortCode(cand);
    if (ALP_CODES.has(code)) {
      const votesEl = getVotesEl(cand);
      return {
        pct:    floatAttr(votesEl, "Percentage"),
        swing:  floatAttr(votesEl, "Swing"),
        booths: tcpBooths,
      };
    }
  }
  return { pct: null, swing: null, booths: tcpBooths };
}

/**
 * Parse a single Contest element and return a flat row data object.
 * electionId is passed through for link generation.
 */
function parseContest(contestEl, electionId) {
  // Contest identifier and name
  const contestIdEl = childEML(contestEl, "ContestIdentifier");
  const contestId   = attr(contestIdEl, "Id");
  const contestName = contestIdEl
    ? childEML(contestIdEl, "ContestName")?.textContent?.trim()
    : "Unknown";

  // State
  const districtEl = contestEl.getElementsByTagNameNS(NS_FEED, "PollingDistrictIdentifier")[0] ||
                     contestEl.getElementsByTagName("PollingDistrictIdentifier")[0];
  const stateIdEl  = districtEl
    ? districtEl.getElementsByTagNameNS(NS_FEED, "StateIdentifier")[0] ||
      districtEl.getElementsByTagName("StateIdentifier")[0]
    : null;
  const state = attr(stateIdEl, "Id") ?? "—";

  // Enrolment
  const enrolEl = contestEl.getElementsByTagNameNS(NS_FEED, "Enrolment")[0] ||
                  contestEl.getElementsByTagName("Enrolment")[0];
  const enrolment = enrolEl ? parseInt(enrolEl.textContent.trim(), 10) : null;

  // First preferences
  const fp = parseFirstPreferences(contestEl);

  // ALP TCP
  const tcp = parseAlpTCP(contestEl);

  return {
    contestId,
    electionId,
    contestName,
    state,
    enrolment,
    alpTcpPct:    tcp.pct,
    alpTcpSwing:  tcp.swing,
    alpPct:       fp?.groups.alp.pct   ?? null,
    lnpPct:       fp?.groups.lnp.pct   ?? null,
    grnPct:       fp?.groups.grn.pct   ?? null,
    onpPct:       fp?.groups.onp.pct   ?? null,
    othPct:       fp?.groups.oth.pct   ?? null,
    alpSwing:     fp?.groups.alp.swing  ?? null,
    lnpSwing:     fp?.groups.lnp.swing  ?? null,
    grnSwing:     fp?.groups.grn.swing  ?? null,
    onpSwing:     fp?.groups.onp.swing  ?? null,
    totalBooths:  fp?.totalBooths   ?? null,
    primaryBooths: fp?.primaryBooths ?? null,
    tcpBooths:    tcp.booths,
  };
}

/**
 * Parse all House contests from an XML document.
 * Returns an array of contest row objects.
 */
function parseXML(xmlDoc, electionId) {
  const house = xmlDoc.getElementsByTagName("House")[0];
  if (!house) return [];
  const contests = house.getElementsByTagNameNS(NS_FEED, "Contest");
  const fallback = house.getElementsByTagName("Contest");
  const list = contests.length > 0 ? Array.from(contests) : Array.from(fallback);
  return list.map(c => parseContest(c, electionId));
}

// ── Table Rendering ──────────────────────────────────────────────────────────

function renderRow(row) {
  const tr = document.createElement("tr");

  const td = (text, extraClass = "") => {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (extraClass) cell.className = extraClass;
    return cell;
  };

  // Contest Name as a link to the detail page
  const contestTd = document.createElement("td");
  contestTd.className = "col-contest sticky-col";
  if (row.contestId && row.electionId) {
    const a = document.createElement("a");
    a.href = `contest.html?electionId=${encodeURIComponent(row.electionId)}&contestId=${encodeURIComponent(row.contestId)}`;
    a.textContent = row.contestName;
    a.className = "contest-link";
    contestTd.appendChild(a);
  } else {
    contestTd.textContent = row.contestName;
  }
  tr.appendChild(contestTd);
  tr.appendChild(td(row.state, "col-state"));

  const enrolTd = td(fmtInt(row.enrolment), "col-num col-enrolment");
  tr.appendChild(enrolTd);

  // ALP TCP % — plain percentage, no swing colour
  const tcpPctTd = document.createElement("td");
  tcpPctTd.className = "col-num col-party-alp";
  tcpPctTd.textContent = fmt(row.alpTcpPct);
  tr.appendChild(tcpPctTd);

  // ALP TCP Swing — ALP perspective (positive = ALP gain)
  tr.appendChild(swingCell(row.alpTcpSwing, true, "col-party-alp"));

  // Primary percentages
  tr.appendChild(td(fmt(row.alpPct), "col-num col-party-alp"));
  tr.appendChild(td(fmt(row.lnpPct), "col-num col-party-lnp"));
  tr.appendChild(td(fmt(row.grnPct), "col-num col-party-grn"));
  tr.appendChild(td(fmt(row.onpPct), "col-num col-party-onp"));
  tr.appendChild(td(fmt(row.othPct), "col-num col-party-oth"));

  // Primary swings (ALP = ALP perspective; L/NP, GRN, ONP = default/their own perspective)
  tr.appendChild(swingCell(row.alpSwing, true,  "col-party-alp"));
  tr.appendChild(swingCell(row.lnpSwing, false, "col-party-lnp"));
  tr.appendChild(swingCell(row.grnSwing, false, "col-party-grn"));
  tr.appendChild(swingCell(row.onpSwing, false, "col-party-onp"));

  // Booth counts
  tr.appendChild(td(fmtInt(row.totalBooths), "col-num"));
  tr.appendChild(td(fmtInt(row.primaryBooths), "col-num"));
  tr.appendChild(td(fmtInt(row.tcpBooths), "col-num"));

  return tr;
}

function renderTable(rows) {
  const tbody = document.getElementById("results-body");
  tbody.innerHTML = "";
  for (const row of rows) {
    tbody.appendChild(renderRow(row));
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function loadElectionData() {
  const statusEl = document.getElementById("status");
  const labelEl  = document.getElementById("election-label");

  try {
    // 1. Load config
    const cfgRes = await fetch("config.json");
    if (!cfgRes.ok) throw new Error(`Failed to load config.json (${cfgRes.status})`);
    const config = await cfgRes.json();

    const electionNames = config.elections.map(e => e.name).join(", ");
    labelEl.textContent = electionNames;

    // 2. Fetch and parse all XML files across all elections
    const allRows = [];
    for (const election of config.elections) {
      for (const filePath of election.files) {
        const xmlRes = await fetch(filePath);
        if (!xmlRes.ok) throw new Error(`Failed to load ${filePath} (${xmlRes.status})`);
        const xmlText = await xmlRes.text();
        const parser  = new DOMParser();
        const xmlDoc  = parser.parseFromString(xmlText, "application/xml");

        const parseErr = xmlDoc.querySelector("parsererror");
        if (parseErr) throw new Error(`XML parse error in ${filePath}: ${parseErr.textContent}`);

        const rows = parseXML(xmlDoc, election.id);
        allRows.push(...rows);
      }
    }

    // 3. Render
    allRowsData = allRows;
    renderTable(getSortedRows(allRowsData));

    const contestWord = allRows.length === 1 ? "contest" : "contests";
    statusEl.textContent = `Showing ${allRows.length} ${contestWord}.`;
    statusEl.classList.remove("error");
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.classList.add("error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initSorting();
  loadElectionData();
});
