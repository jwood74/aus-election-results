/**
 * AEC Election Results — Contest Detail Page (contest.js)
 *
 * Reads electionId + contestId from URL search params, fetches the matching
 * XML file, and renders a per-polling-place results table.
 */

// ── Sort State ───────────────────────────────────────────────────────────────

let allRowsData = [];
let sortState = { key: null, direction: null };

function getSortedRows(rows) {
  const normal    = rows.filter(r => !r.isVoteType);
  const voteTypes = rows.filter(r =>  r.isVoteType);
  if (!sortState.key || !sortState.direction) return [...normal, ...voteTypes];
  const sorted = [...normal].sort((a, b) => {
    const va = a[sortState.key];
    const vb = b[sortState.key];
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp = typeof va === "string" ? va.localeCompare(vb, "en-AU") : va - vb;
    return sortState.direction === "desc" ? -cmp : cmp;
  });
  return [...sorted, ...voteTypes];
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

// ── XML namespace URIs (same as app.js) ─────────────────────────────────────
const NS_FEED = "http://www.aec.gov.au/xml/schema/mediafeed";
const NS_EML  = "urn:oasis:names:tc:evs:schema:eml";

// ── Party groupings ──────────────────────────────────────────────────────────
const ALP_CODES = new Set(["ALP"]);
const LNP_CODES = new Set(["LP", "NP", "LNP", "CLP", "NTA"]);
const GRN_CODES = new Set(["GRN"]);
const ONP_CODES = new Set(["ON"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function childEML(parent, localName) {
  if (!parent) return null;
  for (const node of parent.children) {
    if (node.localName === localName && node.namespaceURI === NS_EML) return node;
  }
  return null;
}

function attr(el, name) {
  return el ? el.getAttribute(name) : null;
}

function floatAttr(el, name) {
  const v = attr(el, name);
  return v !== null ? parseFloat(v) : null;
}

function fmt(v, decimals = 2) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return v.toFixed(decimals);
}

function fmtInt(v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return Math.round(v).toLocaleString("en-AU");
}

/** Get the direct Votes child of a Candidate/Ghost element (not inside VotesByType). */
function getVotesEl(candidateEl) {
  for (const node of candidateEl.children) {
    if (node.localName === "Votes" && (node.namespaceURI === NS_FEED || node.namespaceURI === null)) {
      return node;
    }
  }
  return null;
}

/** Get all elements by localName in feed/null namespace under parent. */
function getAll(parent, localName) {
  if (!parent) return [];
  return Array.from(parent.children).filter(
    n => n.localName === localName && (n.namespaceURI === NS_FEED || n.namespaceURI === null)
  );
}

function getFirst(parent, localName) {
  return getAll(parent, localName)[0] ?? null;
}

/**
 * Build a map of candidateId → partyCode from contest-level FirstPreferences.
 * Includes both active Candidates and Ghosts.
 */
function buildCandidateMap(contestEl) {
  const fpEl = contestEl.getElementsByTagNameNS(NS_FEED, "FirstPreferences")[0] ||
               contestEl.getElementsByTagName("FirstPreferences")[0];
  if (!fpEl) return {};

  const map = {};
  const allCandidates = Array.from(fpEl.children).filter(
    n => n.localName === "Candidate" || n.localName === "Ghost"
  );

  for (const cand of allCandidates) {
    const cidEl  = childEML(cand, "CandidateIdentifier");
    const cid    = attr(cidEl, "Id");
    const affil  = childEML(cand, "AffiliationIdentifier");
    const code   = affil ? attr(affil, "ShortCode") : "IND";
    if (cid) map[cid] = code ?? "IND";
  }
  return map;
}

/**
 * Given a candidateId → partyCode map, determine the group for a code.
 * Returns "alp" | "lnp" | "grn" | "onp" | "oth" | "ind"
 */
function partyGroup(code) {
  if (!code) return "oth";
  if (ALP_CODES.has(code)) return "alp";
  if (LNP_CODES.has(code)) return "lnp";
  if (GRN_CODES.has(code)) return "grn";
  if (ONP_CODES.has(code)) return "onp";
  return "oth";
}

// ── Polling Place Parsing ────────────────────────────────────────────────────

/**
 * Parse one PollingPlace element into a flat row object.
 * candidateMap: { candidateId → shortCode }
 * tcpAlpCandId: the candidate ID of the ALP TCP candidate (null if ALP not in TCP)
 * tcpLnpCandId: the candidate ID of the L/NP TCP candidate (null if L/NP not in TCP)
 */
function parsePollingPlace(ppEl, candidateMap, tcpAlpCandId, tcpLnpCandId) {
  const ppIdEl = ppEl.getElementsByTagNameNS(NS_FEED, "PollingPlaceIdentifier")[0] ||
                 ppEl.getElementsByTagName("PollingPlaceIdentifier")[0];
  const name = attr(ppIdEl, "Name") ?? "Unknown";

  // ── First Preferences ──
  const fpEl = ppEl.getElementsByTagNameNS(NS_FEED, "FirstPreferences")[0] ||
               ppEl.getElementsByTagName("FirstPreferences")[0];

  // Expected Votes (Historic total at this booth) + Votes Cast
  const totalEl    = getFirst(fpEl, "Total");
  const totalVotes = totalEl ? getFirst(totalEl, "Votes") : null;
  const votesCast  = totalVotes ? parseInt(totalVotes.textContent, 10) : null;
  const expectedVotes = totalVotes ? parseInt(attr(totalVotes, "Historic"), 10) : null;

  // Formal votes (used for percentage/swing calculation and preference flow)
  const formalEl         = getFirst(fpEl, "Formal");
  const formalVotesEl    = formalEl ? getFirst(formalEl, "Votes") : null;
  const formalVotes      = formalVotesEl ? parseInt(formalVotesEl.textContent ?? "0", 10) : 0;
  const historicFormal   = formalVotesEl ? parseInt(attr(formalVotesEl, "Historic") ?? "0", 10) : 0;

  // Per-party accumulators
  const primary = {
    alp: { pct: null, swing: null, votes: 0 },
    lnp: { pct: 0,    swing: null, votes: 0, found: false },
    grn: { pct: null, swing: null, votes: 0 },
    onp: { pct: null, swing: null, votes: 0 },
    oth: { pct: 0,    votes: 0 },
  };

  if (fpEl) {
    const allCandidates = Array.from(fpEl.children).filter(
      n => n.localName === "Candidate" || n.localName === "Ghost"
    );

    for (const cand of allCandidates) {
      const isGhost = cand.localName === "Ghost";
      const cidEl  = childEML(cand, "CandidateIdentifier");
      const cid    = attr(cidEl, "Id");
      const code   = candidateMap[cid];
      const group  = partyGroup(code);
      const votesEl = getVotesEl(cand);
      if (!votesEl) continue;

      const votes        = parseInt(votesEl.textContent, 10) || 0;
      const historicVotes = parseInt(attr(votesEl, "Historic") ?? "0", 10) || 0;
      const xmlPct = floatAttr(votesEl, "Percentage");
      // Booth-level XML always has Percentage="0"; fall back to calculating from formal votes.
      const pct    = (xmlPct !== null && xmlPct !== 0)
        ? xmlPct
        : (formalVotes > 0 ? (votes / formalVotes) * 100 : 0);
      const xmlSwing = floatAttr(votesEl, "Swing");
      // Booth-level XML always has Swing="0"; calculate as pct - (historicVotes / historicFormal).
      const swing    = (xmlSwing !== null && xmlSwing !== 0)
        ? xmlSwing
        : (historicFormal > 0 ? pct - (historicVotes / historicFormal) * 100 : null);

      if (group === "alp") {
        primary.alp.pct   = pct;
        primary.alp.swing = swing;
        primary.alp.votes = votes;
      } else if (group === "lnp") {
        primary.lnp.pct   = (primary.lnp.pct ?? 0) + pct;
        primary.lnp.votes += votes;
        if (swing !== null && !primary.lnp.found) {
          primary.lnp.swing = swing;
          primary.lnp.found = true;
        }
      } else if (group === "grn") {
        primary.grn.pct   = pct;
        primary.grn.swing = swing;
        primary.grn.votes = votes;
      } else if (group === "onp") {
        primary.onp.pct   = pct;
        primary.onp.swing = swing;
        primary.onp.votes = votes;
      } else if (!isGhost) {
        primary.oth.pct   = (primary.oth.pct ?? 0) + pct;
        primary.oth.votes += votes;
      }
    }
  }

  // ── Two Candidate Preferred ──
  const tcpEl = ppEl.getElementsByTagNameNS(NS_FEED, "TwoCandidatePreferred")[0] ||
                ppEl.getElementsByTagName("TwoCandidatePreferred")[0];

  let alpTcpPct = null, alpTcpSwing = null, alpTcpVotes = 0;
  let lnpTcpVotes = 0;

  if (tcpEl) {
    const tcpCands = Array.from(tcpEl.children).filter(n => n.localName === "Candidate");
    for (const cand of tcpCands) {
      const cidEl  = childEML(cand, "CandidateIdentifier");
      const cid    = attr(cidEl, "Id");
      const votesEl = getVotesEl(cand);
      if (!votesEl) continue;

      const votes        = parseInt(votesEl.textContent, 10) || 0;
      const historicVotes = parseInt(attr(votesEl, "Historic") ?? "0", 10) || 0;
      const xmlPct = floatAttr(votesEl, "Percentage");
      const pct    = (xmlPct !== null && xmlPct !== 0)
        ? xmlPct
        : (formalVotes > 0 ? (votes / formalVotes) * 100 : 0);
      const xmlSwing = floatAttr(votesEl, "Swing");
      const swing    = (xmlSwing !== null && xmlSwing !== 0)
        ? xmlSwing
        : (historicFormal > 0 ? pct - (historicVotes / historicFormal) * 100 : null);

      if (tcpAlpCandId && cid === tcpAlpCandId) {
        alpTcpPct   = pct;
        alpTcpSwing = swing;
        alpTcpVotes = votes;
      }
      if (tcpLnpCandId && cid === tcpLnpCandId) {
        lnpTcpVotes = votes;
      }
    }
  }

  // ── Preference Flow ──
  // Flow = (TCP votes - first pref votes) / (formal - ALP first prefs - LNP first prefs)
  let flowAlp = null, flowLnp = null;
  if (tcpAlpCandId) {
    const othFormal = formalVotes - (primary.alp.votes ?? 0) - (primary.lnp.votes ?? 0);
    if (othFormal > 0) {
      const alpFlow = alpTcpVotes - (primary.alp.votes ?? 0);
      const lnpFlow = lnpTcpVotes - (primary.lnp.votes ?? 0);
      flowAlp = (alpFlow / othFormal) * 100;
      flowLnp = (lnpFlow / othFormal) * 100;
    }
  }

  return {
    name,
    expectedVotes,
    votesCast,
    alpTcpPct,
    alpTcpSwing,
    alpPct:   primary.alp.pct,
    lnpPct:   primary.lnp.pct === 0 && !primary.lnp.found ? null : primary.lnp.pct,
    grnPct:   primary.grn.pct,
    onpPct:   primary.onp.pct,
    othPct:   primary.oth.pct,
    alpSwing: primary.alp.swing,
    lnpSwing: primary.lnp.swing,
    grnSwing: primary.grn.swing,
    onpSwing: primary.onp.swing,
    flowAlp,
    flowLnp,
  };
}

/**
 * Scan contest-level TwoCandidatePreferred to find ALP and L/NP candidate IDs.
 * Returns { tcpAlpCandId, tcpLnpCandId } — either may be null.
 */
function findTcpCandidateIds(contestEl, candidateMap) {
  const tcpEl = contestEl.getElementsByTagNameNS(NS_FEED, "TwoCandidatePreferred")[0] ||
                contestEl.getElementsByTagName("TwoCandidatePreferred")[0];
  if (!tcpEl) return { tcpAlpCandId: null, tcpLnpCandId: null };

  let tcpAlpCandId = null, tcpLnpCandId = null;
  const tcpCands = Array.from(tcpEl.children).filter(n => n.localName === "Candidate");
  for (const cand of tcpCands) {
    const cidEl = childEML(cand, "CandidateIdentifier");
    const cid   = attr(cidEl, "Id");
    const code  = candidateMap[cid];
    const group = partyGroup(code);
    if (group === "alp") tcpAlpCandId = cid;
    if (group === "lnp") tcpLnpCandId = cid;
  }
  return { tcpAlpCandId, tcpLnpCandId };
}

/**
 * Parse all PollingPlaces for the given contest, then append
 * Absent / Provisional / PrePoll / Postal rows as virtual polling places.
 */
function parseAllPollingPlaces(contestEl) {
  const candidateMap = buildCandidateMap(contestEl);
  const { tcpAlpCandId, tcpLnpCandId } = findTcpCandidateIds(contestEl, candidateMap);

  const ppList = contestEl.getElementsByTagNameNS(NS_FEED, "PollingPlace");
  const fallback = contestEl.getElementsByTagName("PollingPlace");
  const places = ppList.length > 0 ? Array.from(ppList) : Array.from(fallback);

  const ppRows = places.map(pp => parsePollingPlace(pp, candidateMap, tcpAlpCandId, tcpLnpCandId));
  const typeRows = parseVoteTypeRows(contestEl, candidateMap, tcpAlpCandId, tcpLnpCandId);

  return [...ppRows, ...typeRows];
}

// ── Vote-type rows (Absent, Provisional, PrePoll, Postal) ────────────────────

const VOTE_TYPES = [
  { type: "Absent",      label: "Absent Votes"      },
  { type: "Provisional", label: "Provisional Votes"  },
  { type: "PrePoll",     label: "Pre-Poll Votes"     },
  { type: "Postal",      label: "Postal Votes"       },
];

/** Get VotesByType/Votes[@Type=voteType] under parentEl, or null. */
function getVotesByType(parentEl, voteType) {
  const vbt = getFirst(parentEl, "VotesByType");
  if (!vbt) return null;
  for (const node of vbt.children) {
    if (node.localName === "Votes" && node.getAttribute("Type") === voteType) return node;
  }
  return null;
}

/**
 * Parse one vote-type "virtual polling place" row from contest-level VotesByType data.
 */
function parseOneVoteTypeRow(contestEl, candidateMap, tcpAlpCandId, tcpLnpCandId, voteType, label) {
  const fpEl = contestEl.getElementsByTagNameNS(NS_FEED, "FirstPreferences")[0] ||
               contestEl.getElementsByTagName("FirstPreferences")[0];

  // Expected Votes (historic) + Votes Cast from Total/VotesByType
  const totalEl = getFirst(fpEl, "Total");
  const totalTypeVotes = getVotesByType(totalEl, voteType);
  const votesCast     = totalTypeVotes ? parseInt(totalTypeVotes.textContent, 10) : null;
  const expectedVotes = totalTypeVotes ? parseInt(attr(totalTypeVotes, "Historic"), 10) : null;

  // Formal votes of this type (for flow denominator)
  const formalEl = getFirst(fpEl, "Formal");
  const formalTypeEl = getVotesByType(formalEl, voteType);
  const formalVotes  = formalTypeEl ? parseInt(formalTypeEl.textContent, 10) : 0;

  // Per-party primary % and swing from each Candidate/Ghost VotesByType
  const primary = {
    alp: { pct: null, swing: null, votes: 0 },
    lnp: { pct: 0,    swing: null, votes: 0, found: false },
    grn: { pct: null, swing: null, votes: 0 },
    onp: { pct: null, swing: null, votes: 0 },
    oth: { pct: 0,    votes: 0 },
  };

  const allCandidates = fpEl
    ? Array.from(fpEl.children).filter(n => n.localName === "Candidate" || n.localName === "Ghost")
    : [];

  for (const cand of allCandidates) {
    const isGhost = cand.localName === "Ghost";
    const cidEl   = childEML(cand, "CandidateIdentifier");
    const cid     = attr(cidEl, "Id");
    const code    = candidateMap[cid];
    const group   = partyGroup(code);
    const typeVotesEl = getVotesByType(cand, voteType);
    if (!typeVotesEl) continue;

    const pct   = floatAttr(typeVotesEl, "Percentage") ?? 0;
    const swing = floatAttr(typeVotesEl, "Swing");
    const votes = parseInt(typeVotesEl.textContent, 10) || 0;

    if (group === "alp") {
      primary.alp.pct   = pct;
      primary.alp.swing = swing;
      primary.alp.votes = votes;
    } else if (group === "lnp") {
      primary.lnp.pct   = (primary.lnp.pct ?? 0) + pct;
      primary.lnp.votes += votes;
      if (swing !== null && !primary.lnp.found) {
        primary.lnp.swing = swing;
        primary.lnp.found = true;
      }
    } else if (group === "grn") {
      primary.grn.pct   = pct;
      primary.grn.swing = swing;
      primary.grn.votes = votes;
    } else if (group === "onp") {
      primary.onp.pct   = pct;
      primary.onp.swing = swing;
      primary.onp.votes = votes;
    } else if (!isGhost) {
      primary.oth.pct   = (primary.oth.pct ?? 0) + pct;
      primary.oth.votes += votes;
    }
  }

  // ALP TCP % and swing from TwoCandidatePreferred/Candidate VotesByType
  let alpTcpPct = null, alpTcpSwing = null, alpTcpVotes = 0, lnpTcpVotes = 0;
  const tcpEl = contestEl.getElementsByTagNameNS(NS_FEED, "TwoCandidatePreferred")[0] ||
                contestEl.getElementsByTagName("TwoCandidatePreferred")[0];

  if (tcpEl) {
    const tcpCands = Array.from(tcpEl.children).filter(n => n.localName === "Candidate");
    for (const cand of tcpCands) {
      const cidEl = childEML(cand, "CandidateIdentifier");
      const cid   = attr(cidEl, "Id");
      const typeVotesEl = getVotesByType(cand, voteType);
      if (!typeVotesEl) continue;

      if (tcpAlpCandId && cid === tcpAlpCandId) {
        alpTcpPct   = floatAttr(typeVotesEl, "Percentage");
        alpTcpSwing = floatAttr(typeVotesEl, "Swing");
        alpTcpVotes = parseInt(typeVotesEl.textContent, 10) || 0;
      }
      if (tcpLnpCandId && cid === tcpLnpCandId) {
        lnpTcpVotes = parseInt(typeVotesEl.textContent, 10) || 0;
      }
    }
  }

  // Preference flow
  let flowAlp = null, flowLnp = null;
  if (tcpAlpCandId) {
    const othFormal = formalVotes - (primary.alp.votes ?? 0) - (primary.lnp.votes ?? 0);
    if (othFormal > 0) {
      flowAlp = ((alpTcpVotes - primary.alp.votes) / othFormal) * 100;
      flowLnp = ((lnpTcpVotes - primary.lnp.votes) / othFormal) * 100;
    }
  }

  return {
    name: label,
    isVoteType: true,
    expectedVotes,
    votesCast,
    alpTcpPct,
    alpTcpSwing,
    alpPct:   primary.alp.pct,
    lnpPct:   primary.lnp.pct === 0 && !primary.lnp.found ? null : primary.lnp.pct,
    grnPct:   primary.grn.pct,
    onpPct:   primary.onp.pct,
    othPct:   primary.oth.pct,
    alpSwing: primary.alp.swing,
    lnpSwing: primary.lnp.swing,
    grnSwing: primary.grn.swing,
    onpSwing: primary.onp.swing,
    flowAlp,
    flowLnp,
  };
}

/** Parse all four vote-type rows for a contest. */
function parseVoteTypeRows(contestEl, candidateMap, tcpAlpCandId, tcpLnpCandId) {
  return VOTE_TYPES.map(({ type, label }) =>
    parseOneVoteTypeRow(contestEl, candidateMap, tcpAlpCandId, tcpLnpCandId, type, label)
  );
}

// ── Contest-level Totals Row ─────────────────────────────────────────────────

/**
 * Parse contest-level aggregate data into a totals row object.
 * At contest level, Percentage and Swing attributes are accurate (unlike booth level).
 */
function parseContestTotalsRow(contestEl, name, candidateMap, tcpAlpCandId, tcpLnpCandId) {
  const fpEl = contestEl.getElementsByTagNameNS(NS_FEED, "FirstPreferences")[0] ||
               contestEl.getElementsByTagName("FirstPreferences")[0];

  // Total votes cast
  const totalEl       = getFirst(fpEl, "Total");
  const totalVotesEl  = totalEl ? getFirst(totalEl, "Votes") : null;
  const votesCast     = totalVotesEl ? parseInt(totalVotesEl.textContent, 10) : null;
  const expectedVotes = totalVotesEl ? parseInt(attr(totalVotesEl, "Historic"), 10) : null;

  const formalEl      = getFirst(fpEl, "Formal");
  const formalVotesEl = formalEl ? getFirst(formalEl, "Votes") : null;
  const formalVotes   = formalVotesEl ? parseInt(formalVotesEl.textContent, 10) : 0;
  const historicFormal = formalVotesEl ? parseInt(attr(formalVotesEl, "Historic") ?? "0", 10) : 0;

  const primary = {
    alp: { pct: null, swing: null, votes: 0 },
    lnp: { pct: 0,    swing: null, votes: 0, found: false },
    grn: { pct: null, swing: null, votes: 0 },
    onp: { pct: null, swing: null, votes: 0 },
    oth: { pct: 0,    votes: 0 },
  };

  if (fpEl) {
    const allCandidates = Array.from(fpEl.children).filter(
      n => n.localName === "Candidate" || n.localName === "Ghost"
    );
    for (const cand of allCandidates) {
      const isGhost = cand.localName === "Ghost";
      const cidEl   = childEML(cand, "CandidateIdentifier");
      const cid     = attr(cidEl, "Id");
      const code    = candidateMap[cid];
      const group   = partyGroup(code);
      const votesEl = getVotesEl(cand);
      if (!votesEl) continue;

      const votes         = parseInt(votesEl.textContent, 10) || 0;
      const historicVotes = parseInt(attr(votesEl, "Historic") ?? "0", 10) || 0;
      const xmlPct        = floatAttr(votesEl, "Percentage");
      const pct           = (xmlPct !== null && xmlPct !== 0)
        ? xmlPct
        : (formalVotes > 0 ? (votes / formalVotes) * 100 : 0);
      const xmlSwing      = floatAttr(votesEl, "Swing");
      const swing         = (xmlSwing !== null && xmlSwing !== 0)
        ? xmlSwing
        : (historicFormal > 0 ? pct - (historicVotes / historicFormal) * 100 : null);

      if (group === "alp") {
        primary.alp.pct   = pct;   primary.alp.swing = swing;  primary.alp.votes = votes;
      } else if (group === "lnp") {
        primary.lnp.pct   = (primary.lnp.pct ?? 0) + pct;
        primary.lnp.votes += votes;
        if (swing !== null && !primary.lnp.found) { primary.lnp.swing = swing; primary.lnp.found = true; }
      } else if (group === "grn") {
        primary.grn.pct   = pct;   primary.grn.swing = swing;  primary.grn.votes = votes;
      } else if (group === "onp") {
        primary.onp.pct   = pct;   primary.onp.swing = swing;  primary.onp.votes = votes;
      } else if (!isGhost) {
        primary.oth.pct   = (primary.oth.pct ?? 0) + pct;
        primary.oth.votes += votes;
      }
    }
  }

  // ALP TCP from contest-level TwoCandidatePreferred
  let alpTcpPct = null, alpTcpSwing = null, alpTcpVotes = 0, lnpTcpVotes = 0;
  const tcpEl = contestEl.getElementsByTagNameNS(NS_FEED, "TwoCandidatePreferred")[0] ||
                contestEl.getElementsByTagName("TwoCandidatePreferred")[0];
  if (tcpEl) {
    const tcpCands = Array.from(tcpEl.children).filter(n => n.localName === "Candidate");
    for (const cand of tcpCands) {
      const cidEl  = childEML(cand, "CandidateIdentifier");
      const cid    = attr(cidEl, "Id");
      const votesEl = getVotesEl(cand);
      if (!votesEl) continue;
      const votes         = parseInt(votesEl.textContent, 10) || 0;
      const historicVotes = parseInt(attr(votesEl, "Historic") ?? "0", 10) || 0;
      const xmlPct        = floatAttr(votesEl, "Percentage");
      const pct           = (xmlPct !== null && xmlPct !== 0)
        ? xmlPct
        : (formalVotes > 0 ? (votes / formalVotes) * 100 : 0);
      const xmlSwing      = floatAttr(votesEl, "Swing");
      const swing         = (xmlSwing !== null && xmlSwing !== 0)
        ? xmlSwing
        : (historicFormal > 0 ? pct - (historicVotes / historicFormal) * 100 : null);

      if (tcpAlpCandId && cid === tcpAlpCandId) {
        alpTcpPct   = pct;  alpTcpSwing = swing;  alpTcpVotes = votes;
      }
      if (tcpLnpCandId && cid === tcpLnpCandId) {
        lnpTcpVotes = votes;
      }
    }
  }

  let flowAlp = null, flowLnp = null;
  if (tcpAlpCandId) {
    const othFormal = formalVotes - (primary.alp.votes ?? 0) - (primary.lnp.votes ?? 0);
    if (othFormal > 0) {
      flowAlp = ((alpTcpVotes - primary.alp.votes) / othFormal) * 100;
      flowLnp = ((lnpTcpVotes - primary.lnp.votes) / othFormal) * 100;
    }
  }

  return {
    name,
    isTotals: true,
    expectedVotes,
    votesCast,
    alpTcpPct,
    alpTcpSwing,
    alpPct:   primary.alp.pct,
    lnpPct:   primary.lnp.pct === 0 && !primary.lnp.found ? null : primary.lnp.pct,
    grnPct:   primary.grn.pct,
    onpPct:   primary.onp.pct,
    othPct:   primary.oth.pct,
    alpSwing: primary.alp.swing,
    lnpSwing: primary.lnp.swing,
    grnSwing: primary.grn.swing,
    onpSwing: primary.onp.swing,
    flowAlp,
    flowLnp,
  };
}

/**
 * Render the contest totals row into the #totals-row <tr> in <thead>.
 */
function renderTotalsRow(row) {
  const tr = document.getElementById("totals-row");
  tr.innerHTML = "";

  const hasVotes = row.votesCast !== null && row.votesCast > 0;

  const td = (text, cls) => {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (cls) cell.className = cls;
    return cell;
  };
  const pct = (v, party) => {
    const cell = document.createElement("td");
    cell.className = `col-num${party ? " " + party : ""}`;
    cell.textContent = hasVotes ? fmt(v) : "—";
    return cell;
  };
  const swing = (v, party = "") => {
    if (!hasVotes) {
      const c = document.createElement("td");
      c.className = `col-num swing-zero${party ? " " + party + " col-swing" : ""}`;
      c.textContent = "—";
      return c;
    }
    return swingCell(v, false, party);
  };

  tr.appendChild(td(row.name, "col-contest sticky-col totals-name"));
  tr.appendChild(td(fmtInt(row.expectedVotes), "col-num"));
  tr.appendChild(td(row.votesCast === null || row.votesCast === 0 ? "—" : fmtInt(row.votesCast), "col-num"));

  const tcpTd = document.createElement("td");
  tcpTd.className = "col-num col-party-alp";
  tcpTd.textContent = hasVotes ? fmt(row.alpTcpPct) : "—";
  tr.appendChild(tcpTd);

  tr.appendChild(swing(row.alpTcpSwing, "col-party-alp"));

  tr.appendChild(pct(row.alpPct, "col-party-alp"));
  tr.appendChild(pct(row.lnpPct, "col-party-lnp"));
  tr.appendChild(pct(row.grnPct, "col-party-grn"));
  tr.appendChild(pct(row.onpPct, "col-party-onp"));
  tr.appendChild(pct(row.othPct, "col-party-oth"));

  tr.appendChild(swing(row.alpSwing, "col-party-alp"));
  tr.appendChild(swing(row.lnpSwing, "col-party-lnp"));
  tr.appendChild(swing(row.grnSwing, "col-party-grn"));
  tr.appendChild(swing(row.onpSwing, "col-party-onp"));

  tr.appendChild(pct(row.flowAlp, "col-party-alp"));
  tr.appendChild(pct(row.flowLnp, "col-party-lnp"));
}



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

function renderRow(row) {
  const tr = document.createElement("tr");
  if (row.isVoteType) tr.classList.add("is-vote-type");

  const td = (text, extraClass = "") => {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (extraClass) cell.className = extraClass;
    return cell;
  };

  // Suppress percentages and swings when no votes have been cast
  const hasVotes = row.votesCast !== null && row.votesCast > 0;
  const pct = (v, party) => {
    const cell = document.createElement("td");
    cell.className = `col-num${party ? " " + party : ""}`;
    cell.textContent = hasVotes ? fmt(v) : "—";
    return cell;
  };
  const swing = (v, alp = false, party = "") => {
    if (!hasVotes) {
      const c = document.createElement("td");
      c.className = `col-num swing-zero${party ? " " + party + " col-swing" : ""}`;
      c.textContent = "—";
      return c;
    }
    return swingCell(v, alp, party);
  };

  tr.appendChild(td(row.name, "col-contest sticky-col"));
  tr.appendChild(td(fmtInt(row.expectedVotes), "col-num"));
  tr.appendChild(td(row.votesCast === null || row.votesCast === 0 ? "—" : fmtInt(row.votesCast), "col-num"));

  // ALP TCP %
  const tcpPctTd = document.createElement("td");
  tcpPctTd.className = "col-num col-party-alp";
  tcpPctTd.textContent = hasVotes ? fmt(row.alpTcpPct) : "—";
  tr.appendChild(tcpPctTd);

  tr.appendChild(swing(row.alpTcpSwing, true, "col-party-alp"));

  // Primary %
  tr.appendChild(pct(row.alpPct, "col-party-alp"));
  tr.appendChild(pct(row.lnpPct, "col-party-lnp"));
  tr.appendChild(pct(row.grnPct, "col-party-grn"));
  tr.appendChild(pct(row.onpPct, "col-party-onp"));
  tr.appendChild(pct(row.othPct, "col-party-oth"));

  // Primary Swings
  tr.appendChild(swing(row.alpSwing, true,  "col-party-alp"));
  tr.appendChild(swing(row.lnpSwing, false, "col-party-lnp"));
  tr.appendChild(swing(row.grnSwing, false, "col-party-grn"));
  tr.appendChild(swing(row.onpSwing, false, "col-party-onp"));

  // Preference Flow
  tr.appendChild(pct(row.flowAlp, "col-party-alp"));
  tr.appendChild(pct(row.flowLnp, "col-party-lnp"));

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

async function loadContestDetail() {
  const params     = new URLSearchParams(window.location.search);
  const electionId = params.get("electionId");
  const contestId  = params.get("contestId");

  const statusEl  = document.getElementById("status");
  const labelEl   = document.getElementById("election-label");
  const headerEl  = document.getElementById("contest-header");
  const titleEl   = document.getElementById("contest-title");
  const stateEl   = document.getElementById("contest-state");
  const enrolEl   = document.getElementById("contest-enrolment");

  if (!electionId || !contestId) {
    statusEl.textContent = "Error: Missing electionId or contestId in URL.";
    statusEl.classList.add("error");
    return;
  }

  try {
    // 1. Load config
    const cfgRes = await fetch("config.json");
    if (!cfgRes.ok) throw new Error(`Failed to load config.json (${cfgRes.status})`);
    const config = await cfgRes.json();

    const election = config.elections.find(e => String(e.id) === String(electionId));
    if (!election) throw new Error(`Election ID "${electionId}" not found in config.`);
    labelEl.textContent = election.name;

    // 2. Fetch and search XML files for the contest
    let contestEl = null;
    for (const filePath of election.files) {
      const xmlRes = await fetch(filePath);
      if (!xmlRes.ok) throw new Error(`Failed to load ${filePath} (${xmlRes.status})`);
      const xmlText = await xmlRes.text();
      const parser  = new DOMParser();
      const xmlDoc  = parser.parseFromString(xmlText, "application/xml");

      const parseErr = xmlDoc.querySelector("parsererror");
      if (parseErr) throw new Error(`XML parse error in ${filePath}`);

      // Find the contest matching contestId
      const allContests = xmlDoc.getElementsByTagNameNS(NS_FEED, "Contest");
      const fallback    = xmlDoc.getElementsByTagName("Contest");
      const list = allContests.length > 0 ? Array.from(allContests) : Array.from(fallback);

      for (const c of list) {
        const cidEl = childEML(c, "ContestIdentifier");
        if (attr(cidEl, "Id") === String(contestId)) {
          contestEl = c;
          break;
        }
      }
      if (contestEl) break;
    }

    if (!contestEl) throw new Error(`Contest ID "${contestId}" not found in election XML.`);

    // 3. Populate contest header
    const contestNameEl = childEML(childEML(contestEl, "ContestIdentifier"), "ContestName");
    const districtEl    = contestEl.getElementsByTagNameNS(NS_FEED, "PollingDistrictIdentifier")[0] ||
                          contestEl.getElementsByTagName("PollingDistrictIdentifier")[0];
    const stateIdEl     = districtEl
      ? districtEl.getElementsByTagNameNS(NS_FEED, "StateIdentifier")[0] ||
        districtEl.getElementsByTagName("StateIdentifier")[0]
      : null;
    const enrolEl2      = contestEl.getElementsByTagNameNS(NS_FEED, "Enrolment")[0] ||
                          contestEl.getElementsByTagName("Enrolment")[0];

    document.title = `${contestNameEl?.textContent?.trim() ?? "Contest"} — AEC Election Results`;

    // 4. Parse polling places (+ vote-type rows), render totals row, and render table
    allRowsData = parseAllPollingPlaces(contestEl);

    const contestLabel = `${contestNameEl?.textContent?.trim() ?? "Contest"} (${attr(stateIdEl, "Id") ?? "—"})`;
    document.getElementById("contest-label").textContent = contestLabel;
    const { tcpAlpCandId: alpId, tcpLnpCandId: lnpId } = findTcpCandidateIds(contestEl, buildCandidateMap(contestEl));
    const totalsRow = parseContestTotalsRow(contestEl, "", buildCandidateMap(contestEl), alpId, lnpId);
    renderTotalsRow(totalsRow);

    renderTable(getSortedRows(allRowsData));

    statusEl.textContent = "";
    statusEl.classList.remove("error");
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.classList.add("error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initSorting();
  loadContestDetail();
});
