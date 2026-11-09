const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const DATA_FILE = process.env.COMPANIES_FILE || path.join(ROOT, "data", "test.json");
const STORE_FILE = process.env.BIDS_FILE || path.join(ROOT, ".data", "bids.json");
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const VAULT_CAPITAL = 600000;
const SINGLE_BID_LIMIT = 250000;
const MIN_DISTINCT_BIDS = 3;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const companies = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
const sessions = new Map();
const eraStates = { ERA_1: "open", ERA_2: "open" };

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error("Set ADMIN_PASSWORD to a value of at least 12 characters before starting the server.");
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT must be an integer between 1 and 65535.");
  process.exit(1);
}

function readStore() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (!Array.isArray(store.bids)) throw new Error("Bids data must be an array.");
    return store;
  } catch (error) {
    if (error.code === "ENOENT") return { bids: [] };
    throw error;
  }
}

function writeStore(store) {
  const directory = path.dirname(STORE_FILE);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryFile = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, STORE_FILE);
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let exceededLimit = false;
    request.on("data", (chunk) => {
      if (exceededLimit) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        exceededLimit = true;
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
      }
    });
    request.on("end", () => {
      if (exceededLimit) return;
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Send a valid JSON request."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function authenticated(request) {
  const token = parseCookies(request.headers.cookie).admin_session;
  const expiresAt = token && sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return true;
}

function bvi(bid, company) {
  return (bid.principal / company.principalRequired)
    * ((company.maximumRate - bid.ratePercent) / company.maximumRate);
}

function sortedBidsFor(company, bids) {
  return bids
    .filter((bid) => bid.companyId === company.id && bid.era === company.era)
    .sort((a, b) => {
      const scoreDifference = bvi(b, company) - bvi(a, company);
      if (Math.abs(scoreDifference) >= 0.00005) return scoreDifference;
      if (a.ratePercent !== b.ratePercent) return a.ratePercent - b.ratePercent;
      return new Date(a.submittedAt) - new Date(b.submittedAt);
    });
}

function serveAsset(response, filename, contentType) {
  try {
    const body = fs.readFileSync(path.join(ROOT, filename));
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    response.end(body);
  } catch (error) {
    console.error(`Unable to serve ${filename}:`, error);
    sendError(response, 500, "The website could not load this page.");
  }
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/") {
    return serveAsset(response, "index.html", "text/html; charset=utf-8");
  }
  if (request.method === "GET" && pathname === "/app.css") {
    return serveAsset(response, "app.css", "text/css; charset=utf-8");
  }
  if (request.method === "GET" && pathname === "/app.js") {
    return serveAsset(response, "app.js", "text/javascript; charset=utf-8");
  }
  if (request.method === "GET" && pathname === "/api/events") {
    const publicCompanies = companies.map((company) => ({
      ...company,
      minimumPrincipal: Math.ceil(
        (company.principalRequired * company.minimumFundingRatio) / 10000
      ) * 10000
    }));
    return sendJson(response, 200, {
      companies: publicCompanies,
      eras: [...new Set(companies.map((company) => company.era))].map((era) => ({
        id: era,
        name: companies.find((company) => company.era === era).eraName,
        status: eraStates[era]
      })),
      rules: {
        vaultCapital: VAULT_CAPITAL,
        singleBidLimit: SINGLE_BID_LIMIT,
        minimumDistinctBids: MIN_DISTINCT_BIDS
      }
    });
  }
  if (request.method === "POST" && pathname === "/api/bids") {
    const body = await readJson(request);
    const team = typeof body.team === "string" ? body.team.trim().replace(/\s+/g, " ") : "";
    const company = companies.find((item) => item.id === body.companyId);
    const principal = Number(body.principal);
    const ratePercent = Number(body.ratePercent);

    if (!/^[\p{L}\p{N}][\p{L}\p{N} '&.-]{1,34}$/u.test(team)) {
      return sendError(response, 400, "Enter a team name between 2 and 35 characters.");
    }
    if (!company) return sendError(response, 400, "Choose a listed company.");
    if (eraStates[company.era] !== "open") {
      return sendError(response, 409, "Bidding for this era is closed.");
    }
    if (!Number.isSafeInteger(principal) || principal % 10000 !== 0) {
      return sendError(response, 400, "Principal must be in increments of ₹10,000.");
    }
    if (principal < company.principalRequired * company.minimumFundingRatio) {
      return sendError(response, 400, `The minimum principal for this company is ₹${Math.ceil((company.principalRequired * company.minimumFundingRatio) / 10000) * 10000}.`);
    }
    if (principal > SINGLE_BID_LIMIT) {
      return sendError(response, 400, `A single bid cannot exceed ₹${SINGLE_BID_LIMIT.toLocaleString("en-IN")}.`);
    }
    if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > company.maximumRate || Math.round(ratePercent * 100) % 50 !== 0) {
      return sendError(response, 400, `Interest must be in 0.5% increments and no higher than ${company.maximumRate}%.`);
    }

    const store = readStore();
    const teamKey = team.toLocaleLowerCase("en");
    const existingIndex = store.bids.findIndex((bid) =>
      bid.era === company.era
      && bid.companyId === company.id
      && bid.teamKey === teamKey
    );
    const currentCommitted = store.bids.reduce((total, bid) => {
      if (bid.era !== company.era || bid.teamKey !== teamKey) return total;
      return total + (existingIndex >= 0 && bid === store.bids[existingIndex] ? 0 : bid.principal);
    }, 0);
    if (currentCommitted + principal > VAULT_CAPITAL) {
      return sendError(response, 400, `This bid would exceed the ₹${VAULT_CAPITAL.toLocaleString("en-IN")} vault for this era.`);
    }

    const bid = {
      era: company.era,
      companyId: company.id,
      team,
      teamKey,
      principal,
      ratePercent,
      submittedAt: new Date().toISOString()
    };
    if (existingIndex >= 0) store.bids[existingIndex] = bid;
    else store.bids.push(bid);
    writeStore(store);

    return sendJson(response, 201, {
      message: "Your sealed bid has been recorded.",
      committed: currentCommitted + principal,
      remaining: VAULT_CAPITAL - currentCommitted - principal,
      bvi: Number(bvi(bid, company).toFixed(4))
    });
  }
  if (request.method === "POST" && pathname === "/api/admin/login") {
    const body = await readJson(request);
    const supplied = typeof body.password === "string" ? body.password : "";
    const expected = Buffer.from(ADMIN_PASSWORD);
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return sendError(response, 401, "That admin password was not accepted.");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
    return sendJson(response, 200, { message: "Admin access granted." }, {
      "Set-Cookie": `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
    });
  }
  if (request.method === "POST" && pathname === "/api/admin/logout") {
    const token = parseCookies(request.headers.cookie).admin_session;
    if (token) sessions.delete(token);
    return sendJson(response, 200, { message: "Signed out." }, {
      "Set-Cookie": "admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
    });
  }
  if (pathname.startsWith("/api/admin/")) {
    if (!authenticated(request)) return sendError(response, 401, "Admin sign-in is required.");

    if (request.method === "GET" && pathname === "/api/admin/leaderboard") {
      const era = url.searchParams.get("era");
      if (!["ERA_1", "ERA_2"].includes(era)) return sendError(response, 400, "Choose a valid era.");
      const store = readStore();
      const eraCompanies = companies.filter((company) => company.era === era);
      const bids = store.bids.filter((bid) => bid.era === era);
      const teams = new Set(bids.map((bid) => bid.teamKey));
      const leaderboard = eraCompanies.map((company) => {
        const ranked = sortedBidsFor(company, bids).map((bid, index) => ({
          rank: index + 1,
          team: bid.team,
          principal: bid.principal,
          ratePercent: bid.ratePercent,
          bvi: Number(bvi(bid, company).toFixed(4)),
          submittedAt: bid.submittedAt
        }));
        return {
          companyId: company.id,
          name: company.name,
          principalRequired: company.principalRequired,
          maximumRate: company.maximumRate,
          bids: ranked,
          bestBid: ranked[0] || null
        };
      });
      return sendJson(response, 200, {
        era,
        status: eraStates[era],
        validBidCount: bids.length,
        teamCount: teams.size,
        leaderboard
      });
    }
    if (request.method === "POST" && pathname === "/api/admin/era-status") {
      const body = await readJson(request);
      if (!["ERA_1", "ERA_2"].includes(body.era) || !["open", "closed"].includes(body.status)) {
        return sendError(response, 400, "Choose a valid era and status.");
      }
      eraStates[body.era] = body.status;
      return sendJson(response, 200, { era: body.era, status: body.status });
    }
  }
  return sendError(response, 404, "Page not found.");
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (error.status) return sendError(response, error.status, error.message);
    console.error("Request failed:", error);
    if (!response.headersSent) sendError(response, 500, "The request could not be completed.");
    else response.destroy();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SYNERGY bidding site listening on http://localhost:${PORT}`);
  console.log(`Bid data will be stored in ${STORE_FILE}`);
});
