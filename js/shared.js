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

// ── XML / DOM Helpers ────────────────────────────────────────────────────────

/** First child element matching localName in the feed/null namespace, or null. */
function childNS(parent, localName) {
  if (!parent) return null;
  for (const node of parent.children) {
    if (node.localName === localName && node.namespaceURI === NS_FEED) return node;
    if (node.localName === localName && node.namespaceURI === null) return node;
  }
  return null;
}
// Alias used in contest.js
const getFirst = childNS;

/** All child elements matching localName in the feed/null namespace. */
function childrenNS(parent, localName) {
  if (!parent) return [];
  return Array.from(parent.children).filter(
    n => n.localName === localName && (n.namespaceURI === NS_FEED || n.namespaceURI === null)
  );
}
// Alias used in contest.js
const getAll = childrenNS;

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

// ── Formatting ───────────────────────────────────────────────────────────────

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

// ── Rendering Helpers ────────────────────────────────────────────────────────

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

function renderTable(rows) {
  const tbody = document.getElementById("results-body");
  tbody.innerHTML = "";
  for (const row of rows) {
    tbody.appendChild(renderRow(row));
  }
}

// ── Sorting ──────────────────────────────────────────────────────────────────

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
