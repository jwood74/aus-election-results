/**
 * AEC Election Results Dashboard
 *
 * Loads config.json → fetches XML media feed files → parses contest data →
 * renders the results table.
 */

// ── Sort State ───────────────────────────────────────────────────────────────

let allRowsData = [];
let sortState = { key: null, direction: null };

// ── TCP Selection State ─────────────────────────────────────────────────────
let globalTcpGroup = "alp";      // party group: "alp", "lnp", "grn", "onp", "oth"
let contestTcpOverrides = {};    // { contestId: candidateId }
const INDEX_TCP_STORAGE_KEY = "index-tcp-group";

function loadTcpState() {
  const stored = localStorage.getItem(INDEX_TCP_STORAGE_KEY);
  if (stored) globalTcpGroup = stored;
}

function saveTcpState() {
  localStorage.setItem(INDEX_TCP_STORAGE_KEY, globalTcpGroup);
}

/** Collect all distinct party groups that appear as TCP candidates across all rows. */
function collectTcpPartyGroups(rows) {
  const groups = new Map(); // group → { group, code, label }
  for (const row of rows) {
    if (!row.tcpCandidates) continue;
    for (const c of row.tcpCandidates) {
      if (!groups.has(c.group)) {
        groups.set(c.group, { group: c.group, code: c.code, label: c.code });
      }
    }
  }
  return Array.from(groups.values());
}

function getEffectiveTcpCandidateId(row) {
  if (contestTcpOverrides[row.contestId]) {
    return contestTcpOverrides[row.contestId];
  }
  if (!row.tcpCandidates || row.tcpCandidates.length === 0) return null;
  const match = row.tcpCandidates.find(c => c.group === globalTcpGroup);
  return match ? match.id : row.tcpCandidates[0].id;
}

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

function partyGroup(code) {
  if (!code) return "oth";
  if (ALP_CODES.has(code)) return "alp";
  if (LNP_CODES.has(code)) return "lnp";
  if (GRN_CODES.has(code)) return "grn";
  if (ONP_CODES.has(code)) return "onp";
  return "oth";
}

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
 * Parse TwoCandidatePreferred for ALL TCP candidates.
 * Returns { tcpCandidates, tcpPctById, tcpSwingById, historicTcpPctById,
 *           alpTcpPct, alpTcpSwing, alpHistoricTcpPct, booths }.
 */
function parseTCP(contestEl) {
  const tcpEl = contestEl.getElementsByTagNameNS(NS_FEED, "TwoCandidatePreferred")[0] ||
                contestEl.getElementsByTagName("TwoCandidatePreferred")[0];
  if (!tcpEl) return { tcpCandidates: [], tcpPctById: {}, tcpSwingById: {}, historicTcpPctById: {}, alpTcpPct: null, alpTcpSwing: null, alpHistoricTcpPct: null, booths: null };

  const tcpBooths = parseInt(attr(tcpEl, "PollingPlacesReturned"), 10) || null;

  const tcpCandidates = [];
  const tcpPctById = {};
  const tcpSwingById = {};
  const historicVotesById = {};
  let alpTcpPct = null, alpTcpSwing = null;
  let alpCandId = null;

  const candidates = Array.from(tcpEl.children).filter(n => n.localName === "Candidate");
  for (const cand of candidates) {
    const cidEl = childEML(cand, "CandidateIdentifier");
    const cid = attr(cidEl, "Id");
    const code = getShortCode(cand);
    const group = partyGroup(code);
    const nameEl = childEML(cand, "CandidateName");
    const name = nameEl ? nameEl.textContent.trim() : code || cid;
    const votesEl = getVotesEl(cand);

    const pct = floatAttr(votesEl, "Percentage");
    const swing = floatAttr(votesEl, "Swing");
    const historicVotes = parseInt(attr(votesEl, "Historic") ?? "0", 10) || 0;

    tcpCandidates.push({ id: cid, code: code || "IND", name, group });
    tcpPctById[cid] = pct;
    tcpSwingById[cid] = swing;
    historicVotesById[cid] = historicVotes;

    if (ALP_CODES.has(code)) {
      alpTcpPct = pct;
      alpTcpSwing = swing;
      alpCandId = cid;
    }
  }

  // Compute historic TCP percentages from historic vote counts
  const historicTcpPctById = {};
  const totalHistoricVotes = Object.values(historicVotesById).reduce((s, v) => s + v, 0);
  if (totalHistoricVotes > 0) {
    for (const cid of Object.keys(historicVotesById)) {
      historicTcpPctById[cid] = (historicVotesById[cid] / totalHistoricVotes) * 100;
    }
  }

  const alpHistoricTcpPct = (alpCandId && historicTcpPctById[alpCandId] !== undefined)
    ? historicTcpPctById[alpCandId]
    : null;

  return { tcpCandidates, tcpPctById, tcpSwingById, historicTcpPctById, alpTcpPct, alpTcpSwing, alpHistoricTcpPct, booths: tcpBooths };
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

  // TCP (all candidates)
  const tcp = parseTCP(contestEl);

  return {
    contestId,
    electionId,
    contestName,
    state,
    enrolment,
    tcpCandidates:      tcp.tcpCandidates,
    tcpPctById:         tcp.tcpPctById,
    tcpSwingById:       tcp.tcpSwingById,
    historicTcpPctById: tcp.historicTcpPctById,
    alpTcpPct:          tcp.alpTcpPct,
    alpTcpSwing:        tcp.alpTcpSwing,
    alpHistoricTcpPct:  tcp.alpHistoricTcpPct,
    alpTcpPrediction:   (tcp.alpHistoricTcpPct !== null && tcp.alpTcpSwing !== null)
      ? tcp.alpHistoricTcpPct + tcp.alpTcpSwing
      : null,
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

// Sync filter row column widths to match the main table columns.
function syncFilterRowWidths() {
  const mainTable = document.getElementById('results-table');
  const filterTable = document.getElementById('filter-bar-table');
  if (!mainTable || !filterTable) return;
  // Use the last header row for column widths
  const mainHeaderCells = mainTable.querySelectorAll('thead tr:last-child th');
  const filterCells = filterTable.querySelectorAll('#filter-row td');
  if (mainHeaderCells.length === filterCells.length) {
    for (let i = 0; i < filterCells.length; i++) {
      // Get computed width (including border/padding) from header cell
      const computedStyle = window.getComputedStyle(mainHeaderCells[i]);
      const width = mainHeaderCells[i].getBoundingClientRect().width;
      filterCells[i].style.width = width + 'px';
      filterCells[i].style.minWidth = width + 'px';
      filterCells[i].style.maxWidth = width + 'px';
      // Copy padding and border from header cell to filter cell
      filterCells[i].style.paddingLeft = computedStyle.paddingLeft;
      filterCells[i].style.paddingRight = computedStyle.paddingRight;
      filterCells[i].style.borderRightWidth = computedStyle.borderRightWidth;
      filterCells[i].style.borderLeftWidth = computedStyle.borderLeftWidth;
      filterCells[i].style.boxSizing = computedStyle.boxSizing;
    }
  }
  // Also set input width to 100% of cell
  const filterInputs = filterTable.querySelectorAll('input[type="text"]');
  filterInputs.forEach(input => {
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
  });
}
window.addEventListener('resize', syncFilterRowWidths);
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(syncFilterRowWidths, 0);
  // Re-sync after table renders (in case of async data)
  setTimeout(syncFilterRowWidths, 200);
});

// ── Global TCP Dropdown ──────────────────────────────────────────────────────
 
/** Map party group to display label */
const GROUP_LABELS = { alp: "ALP", lnp: "L/NP", grn: "GRN", onp: "ONP", oth: "OTH" };
 
function updateGlobalTcpDisplay() {
  const pickerBtn = document.getElementById("tcp-candidate-picker");
  if (!pickerBtn) return;
 
  const partyClass = `col-party-${globalTcpGroup}`;
  const label = (GROUP_LABELS[globalTcpGroup] || globalTcpGroup.toUpperCase()) + " TCP";
 
  pickerBtn.innerHTML = `<span class="tcp-party-dot ${partyClass}"></span>${label}<span class="tcp-caret">&#9660;</span>`;
 
  const tcpSubHeaders = document.querySelectorAll("thead tr:nth-child(2) th.group-tcp");
  tcpSubHeaders.forEach(th => {
    th.classList.remove("col-party-alp", "col-party-lnp", "col-party-grn", "col-party-onp", "col-party-oth");
    th.classList.add(partyClass);
  });
}
 
function renderGlobalTcpDropdown() {
  const pickerBtn = document.getElementById("tcp-candidate-picker");
  const menu = document.getElementById("tcp-candidate-menu");
  if (!pickerBtn || !menu) return;
 
  menu.innerHTML = "";
 
  const partyGroups = collectTcpPartyGroups(allRowsData);
  // Sort so ALP comes first, then alphabetical
  partyGroups.sort((a, b) => {
    if (a.group === "alp") return -1;
    if (b.group === "alp") return 1;
    return a.label.localeCompare(b.label);
  });
 
  partyGroups.forEach(pg => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.role = "option";
    btn.setAttribute("data-group", pg.group);
    btn.setAttribute("aria-checked", pg.group === globalTcpGroup ? "true" : "false");
    btn.tabIndex = -1;
    const displayLabel = (GROUP_LABELS[pg.group] || pg.label) + " TCP";
    btn.innerHTML = `<span class="tcp-party-dot col-party-${pg.group}"></span>${displayLabel}`;
    btn.onclick = function () {
      globalTcpGroup = pg.group;
      saveTcpState();
      contestTcpOverrides = {};
      closeTcpMenu();
      updateGlobalTcpDisplay();
      updateTableWithFilters();
    };
    menu.appendChild(btn);
  });
 
  menu.setAttribute("aria-hidden", "true");
  menu.style.display = "none";
 
  updateGlobalTcpDisplay();
 
  pickerBtn.onclick = function (e) {
    e.stopPropagation();
    openTcpMenu();
  };
 
  pickerBtn.onkeydown = function (e) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openTcpMenu();
      const firstBtn = menu.querySelector("button");
      if (firstBtn) firstBtn.focus();
    }
  };
 
  function openTcpMenu() {
    menu.setAttribute("aria-hidden", "false");
    menu.style.display = "block";
    pickerBtn.setAttribute("aria-expanded", "true");
    const selectedBtn = menu.querySelector(`button[data-group='${globalTcpGroup}']`);
    if (selectedBtn) selectedBtn.focus();
    document.addEventListener("mousedown", outsideClick, { once: true });
  }
 
  function closeTcpMenu() {
    menu.setAttribute("aria-hidden", "true");
    menu.style.display = "none";
    pickerBtn.setAttribute("aria-expanded", "false");
    pickerBtn.focus();
  }
 
  function outsideClick(e) {
    if (!menu.contains(e.target) && e.target !== pickerBtn) closeTcpMenu();
  }
 
  menu.onkeydown = function (e) {
    const btns = Array.from(menu.querySelectorAll("button"));
    const idx = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (idx < btns.length - 1) btns[idx + 1].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (idx > 0) btns[idx - 1].focus();
    } else if (e.key === "Escape") {
      closeTcpMenu();
    }
  };
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

  // TCP % and Swing — dynamic based on selected candidate
  const effectiveTcpId = getEffectiveTcpCandidateId(row);
  const effectiveTcpCandidate = row.tcpCandidates?.find(c => c.id === effectiveTcpId);
  const tcpPartyClass = effectiveTcpCandidate
    ? `col-party-${effectiveTcpCandidate.group}`
    : "col-party-alp";

  const tcpPctTd = document.createElement("td");
  tcpPctTd.className = `col-num ${tcpPartyClass}`;
  if (effectiveTcpId && row.tcpPctById && row.tcpPctById[effectiveTcpId] !== undefined) {
    tcpPctTd.textContent = fmt(row.tcpPctById[effectiveTcpId]);
  } else {
    tcpPctTd.textContent = fmt(row.alpTcpPct);
  }

  // Per-contest cycling on click
  if (row.tcpCandidates && row.tcpCandidates.length > 1) {
    tcpPctTd.classList.add("tcp-clickable");
    tcpPctTd.title = "Click to switch TCP candidate";
    tcpPctTd.addEventListener("click", (e) => {
      e.stopPropagation();
      const currentId = getEffectiveTcpCandidateId(row);
      const currentIdx = row.tcpCandidates.findIndex(c => c.id === currentId);
      const nextIdx = (currentIdx + 1) % row.tcpCandidates.length;
      contestTcpOverrides[row.contestId] = row.tcpCandidates[nextIdx].id;
      updateTableWithFilters();
    });
  }
  tr.appendChild(tcpPctTd);

  // TCP Swing
  let tcpSwingValue;
  if (effectiveTcpId && row.tcpSwingById && row.tcpSwingById[effectiveTcpId] !== undefined) {
    tcpSwingValue = row.tcpSwingById[effectiveTcpId];
  } else {
    tcpSwingValue = row.alpTcpSwing;
  }
  tr.appendChild(swingCell(tcpSwingValue, true, tcpPartyClass));

  // TCP Prediction = historic TCP % (full previous election) + current swing
  let tcpPredictionValue = null;
  {
    let historicPct = null;
    if (effectiveTcpId && row.historicTcpPctById && row.historicTcpPctById[effectiveTcpId] !== undefined) {
      historicPct = row.historicTcpPctById[effectiveTcpId];
    } else {
      historicPct = row.alpHistoricTcpPct;
    }
    if (historicPct !== null && !isNaN(historicPct) && tcpSwingValue !== null && !isNaN(tcpSwingValue)) {
      tcpPredictionValue = historicPct + tcpSwingValue;
    }
  }
  const tcpPredTd = document.createElement("td");
  tcpPredTd.className = `col-num ${tcpPartyClass}`;
  tcpPredTd.textContent = fmt(tcpPredictionValue);
  tr.appendChild(tcpPredTd);

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

function filterRows(rows, contestFilter, stateFilter) {
  const contest = contestFilter.trim().toLowerCase();
  const state = stateFilter.trim().toLowerCase();
  return rows.filter(row => {
    const matchContest = !contest || (row.contestName && row.contestName.toLowerCase().includes(contest));
    const matchState = !state || (row.state && row.state.toLowerCase().includes(state));
    return matchContest && matchState;
  });
}

function updateTableWithFilters() {
  const contestInput = document.getElementById("filter-contest");
  const stateInput = document.getElementById("filter-state");
  const contestFilter = contestInput ? contestInput.value : "";
  const stateFilter = stateInput ? stateInput.value : "";
  const filteredRows = filterRows(getSortedRows(allRowsData), contestFilter, stateFilter);
  renderTable(filteredRows);
  updateTotalsRow(filteredRows);
}

function sum(values) {
  let total = 0, count = 0;
  for (const v of values) {
    if (typeof v === 'number' && !isNaN(v)) {
      total += v;
      count++;
    }
  }
  return { total, count };
}

function avg(values) {
  const { total, count } = sum(values);
  return count > 0 ? total / count : null;
}

function updateTotalsRow(rows) {
  // TCP values: compute from effective selection per row
  const tcpPctValues = rows.map(r => {
    const id = getEffectiveTcpCandidateId(r);
    if (id && r.tcpPctById && r.tcpPctById[id] !== undefined) return r.tcpPctById[id];
    return r.alpTcpPct;
  });
  const tcpSwingValues = rows.map(r => {
    const id = getEffectiveTcpCandidateId(r);
    if (id && r.tcpSwingById && r.tcpSwingById[id] !== undefined) return r.tcpSwingById[id];
    return r.alpTcpSwing;
  });
 
  const tcpPctAvg = avg(tcpPctValues);
  const tcpPctEl = document.getElementById('total-alpTcpPct');
  if (tcpPctEl) tcpPctEl.textContent = tcpPctAvg !== null ? tcpPctAvg.toFixed(2) : '—';
 
  const tcpSwingAvg = avg(tcpSwingValues);
  const tcpSwingEl = document.getElementById('total-alpTcpSwing');
  if (tcpSwingEl) tcpSwingEl.textContent = tcpSwingAvg !== null ? (tcpSwingAvg > 0 ? '+' : '') + tcpSwingAvg.toFixed(2) : '—';

  // TCP Prediction: historic TCP % (full previous election) + current swing
  const tcpPredictionValues = rows.map((r, i) => {
    const id = getEffectiveTcpCandidateId(r);
    let historicPct = null;
    if (id && r.historicTcpPctById && r.historicTcpPctById[id] !== undefined) {
      historicPct = r.historicTcpPctById[id];
    } else {
      historicPct = r.alpHistoricTcpPct;
    }
    const swing = tcpSwingValues[i];
    if (historicPct !== null && !isNaN(historicPct) && swing !== null && !isNaN(swing)) {
      return historicPct + swing;
    }
    return null;
  });
  const tcpPredAvg = avg(tcpPredictionValues);
  const tcpPredEl = document.getElementById('total-alpTcpPrediction');
  if (tcpPredEl) tcpPredEl.textContent = tcpPredAvg !== null ? tcpPredAvg.toFixed(2) : '—';

  // Non-TCP percent columns: average
  const percentFields = [
    'alpPct', 'lnpPct', 'grnPct', 'onpPct', 'othPct'
  ];
  const swingFields = [
    'alpSwing', 'lnpSwing', 'grnSwing', 'onpSwing'
  ];
  const boothFields = [
    'totalBooths', 'primaryBooths', 'tcpBooths'
  ];
  for (const field of percentFields) {
    const avgVal = avg(rows.map(r => r[field]));
    const el = document.getElementById('total-' + field);
    if (el) el.textContent = avgVal !== null ? avgVal.toFixed(2) : '—';
  }
  for (const field of swingFields) {
    const avgVal = avg(rows.map(r => r[field]));
    const el = document.getElementById('total-' + field);
    if (el) el.textContent = avgVal !== null ? (avgVal > 0 ? '+' : '') + avgVal.toFixed(2) : '—';
  }
  for (const field of boothFields) {
    const { total, count } = sum(rows.map(r => r[field]));
    const el = document.getElementById('total-' + field);
    if (el) el.textContent = count > 0 ? Math.round(total).toLocaleString('en-AU') : '—';
  }

  // Update filter bar TCP cell party classes
  const partyClasses = ["col-party-alp", "col-party-lnp", "col-party-grn", "col-party-onp", "col-party-oth"];
  const tcpClass = `col-party-${globalTcpGroup}`;
  ["total-alpTcpPct", "total-alpTcpSwing", "total-alpTcpPrediction"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      partyClasses.forEach(cls => el.classList.remove(cls));
      el.classList.add(tcpClass);
    }
  });
}

function addFilterListeners() {
  const contestInput = document.getElementById("filter-contest");
  const stateInput = document.getElementById("filter-state");
  if (contestInput) contestInput.addEventListener("input", updateTableWithFilters);
  if (stateInput) stateInput.addEventListener("input", updateTableWithFilters);
  // Also listen for Enter to focus table
  if (contestInput) contestInput.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const firstRow = document.querySelector("#results-body tr");
      if (firstRow) firstRow.focus();
    }
  });
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
    loadTcpState();
    renderGlobalTcpDropdown();
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
  loadElectionData().then(() => {
    addFilterListeners();
    // Focus the Contest filter input in sticky bar on page load
    const contestInput = document.querySelector(".table-filter-bar-wrapper #filter-contest");
    if (contestInput) contestInput.focus();
    updateTableWithFilters();
  });
});
