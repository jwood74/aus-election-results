/**
 * Cloudflare Worker — AEC Election Feed Proxy
 *
 * Stores gzip-compressed AEC XML data in KV, serves it with
 * caching and CORS headers to the GitHub Pages dashboard.
 *
 * Endpoints:
 *   GET  /feed/:electionId     Serve XML (public, cached)
 *   POST /upload/:electionId   Upload XML (authenticated)
 *   POST /admin/cache-ttl      Set cache TTL in seconds (authenticated)
 *   GET  /status/:electionId   Last-updated timestamp (public)
 */

const ALLOWED_ORIGIN = "https://jaxenwood.com";
const DEFAULT_TTL = 300; // 5 minutes

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Route: GET /feed/:electionId
    if (request.method === "GET" && parts[0] === "feed" && parts[1]) {
      return handleServe(request, env, parts[1]);
    }

    // Route: POST /upload/:electionId
    if (request.method === "POST" && parts[0] === "upload" && parts[1]) {
      return handleUpload(request, env, parts[1]);
    }

    // Route: POST /admin/cache-ttl
    if (request.method === "POST" && parts[0] === "admin" && parts[1] === "cache-ttl") {
      return handleSetTTL(request, env);
    }

    // Route: GET /status/:electionId
    if (request.method === "GET" && parts[0] === "status" && parts[1]) {
      return handleStatus(request, env, parts[1]);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleServe(request, env, electionId) {
  const compressed = await env.AEC_DATA.get(`xml:${electionId}`, { type: "arrayBuffer" });
  if (!compressed) {
    return jsonResponse(
      { error: `No data available for election ${electionId}. Data has not been uploaded yet.` },
      404,
      corsHeaders(request)
    );
  }

  // Read cache TTL from KV (default 5 min)
  const ttlStr = await env.AEC_DATA.get("config:cache-ttl");
  const ttl = ttlStr ? parseInt(ttlStr, 10) : DEFAULT_TTL;

  // Always decompress before serving — avoids conflicts with
  // Cloudflare's own compression layer on the edge.
  const ds = new DecompressionStream("gzip");
  const decompressed = new Response(compressed).body.pipeThrough(ds);

  return new Response(decompressed, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": `public, max-age=${ttl}, s-maxage=${ttl}`,
      ...corsHeaders(request),
    },
  });
}

async function handleUpload(request, env, electionId) {
  if (!authorize(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const xmlBody = await request.arrayBuffer();
  if (xmlBody.byteLength === 0) {
    return jsonResponse({ error: "Empty body" }, 400);
  }

  // Gzip-compress before storing (35MB XML → ~2-4MB, fits KV 25MB limit)
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(new Uint8Array(xmlBody));
  writer.close();
  const compressedBuf = await new Response(cs.readable).arrayBuffer();

  // Store compressed XML and metadata
  await env.AEC_DATA.put(`xml:${electionId}`, compressedBuf);
  await env.AEC_DATA.put(`meta:${electionId}`, JSON.stringify({
    updatedAt: new Date().toISOString(),
    originalSize: xmlBody.byteLength,
    compressedSize: compressedBuf.byteLength,
  }));

  return jsonResponse({
    ok: true,
    electionId,
    originalSize: xmlBody.byteLength,
    compressedSize: compressedBuf.byteLength,
  });
}

async function handleSetTTL(request, env) {
  if (!authorize(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const ttl = parseInt(body.ttl, 10);
  if (isNaN(ttl) || ttl < 10 || ttl > 86400) {
    return jsonResponse({ error: "ttl must be between 10 and 86400 seconds" }, 400);
  }

  await env.AEC_DATA.put("config:cache-ttl", String(ttl));
  return jsonResponse({ ok: true, ttl });
}

async function handleStatus(request, env, electionId) {
  const metaStr = await env.AEC_DATA.get(`meta:${electionId}`);
  if (!metaStr) {
    return jsonResponse(
      { error: `No data for election ${electionId}` },
      404,
      corsHeaders(request)
    );
  }

  const meta = JSON.parse(metaStr);
  const ttlStr = await env.AEC_DATA.get("config:cache-ttl");
  const ttl = ttlStr ? parseInt(ttlStr, 10) : DEFAULT_TTL;

  return jsonResponse({ electionId, ...meta, cacheTTL: ttl }, 200, corsHeaders(request));
}

// ── Utilities ────────────────────────────────────────────────────────────────

function authorize(request, env) {
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${env.UPLOAD_SECRET}`;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = origin === ALLOWED_ORIGIN || origin.startsWith("http://localhost");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}
