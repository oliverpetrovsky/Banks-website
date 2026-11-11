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
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_BODY_BYTES = 16 * 1024;
const companies = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
const sessions = new Map();
const loginAttempts = new Map();

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error("Set ADMIN_PASSWORD to a value of at least 12 characters before starting the server.");
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT must be an integer between 1 and 65535.");
  process.exit(1);
}
if (!Array.isArray(companies) || companies.length === 0) {
  console.error("The selected companies dataset must contain at least one company.");
  process.exit(1);
}

function readStore() {
  try {
    const stored = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (!Array.isArray(stored.bids)) throw new Error("Bids data must be an array.");
    return {
      bids: stored.bids,
      teams: Array.isArray(stored.teams) ? stored.teams : [],
      results: stored.results && typeof stored.results === "object" ? stored.results : {},
      auction: stored.auction && typeof stored.auction === "object"
        ? stored.auction
        : { status: "waiting", era: null, companyId: null }
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        bids: [],
        teams: [],
        results: {},
        auction: { status: "waiting", era: null, companyId: null }
      };
    }
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
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([key]) => key));
}

function getSession(request) {
  const token = parseCookies(request.headers.cookie).synergy_session;
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function setSessionCookie(response, token, maxAge = SESSION_TTL_MS / 1000) {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `synergy_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`
  );
}

function bvi(bid, company) {
  return (bid.principal / company.principalRequired)
    * ((company.maximumRate - bid.ratePercent) / company.maximumRate);
}

function sortedBidsFor(company, bids) {
  return bids
    .filter((bid) => bid.companyId === company.id && bid.era === company.era)
    .sort((a, b) => {
      const scoreDifference = Math.round(bvi(b, company) * 10000)
        - Math.round(bvi(a, company) * 10000);
      if (scoreDifference) return scoreDifference;
      if (a.ratePercent !== b.ratePercent) return a.ratePercent - b.ratePercent;
      return new Date(a.submittedAt) - new Date(b.submittedAt);
    });
}

function publicBid(bid, company, rank) {
  return {
    rank,
    team: bid.team,
    principal: bid.principal,
    ratePercent: bid.ratePercent,
    bvi: Number(bvi(bid, company).toFixed(4)),
    submittedAt: bid.submittedAt
  };
}

function minPrincipal(company) {
  return Math.ceil(
    (company.principalRequired * company.minimumFundingRatio) / 10000
  ) * 10000;
}

function publicCompany(company) {
  return {
    id: company.id,
    era: company.era,
    eraName: company.eraName,
    decade: company.decade,
    name: company.name,
    sector: company.sector,
    summary: company.summary,
    principalRequired: company.principalRequired,
    minimumPrincipal: minPrincipal(company),
    maximumRate: company.maximumRate
  };
}

function leaderboardFor(company, bids) {
  return sortedBidsFor(company, bids).map((bid, index) => publicBid(bid, company, index + 1));
}

function auctionKey(era, companyId) {
  return `${era}:${companyId}`;
}

function finalizeAuction(store) {
  const { era, companyId } = store.auction;
  if (!era || !companyId) return;
  const company = companies.find((item) => item.era === era && item.id === companyId);
  if (!company) return;
  const winningBid = sortedBidsFor(company, store.bids)[0];
  if (!winningBid) return;
  store.results[auctionKey(era, companyId)] = {
    era,
    companyId,
    winnerTeamKey: winningBid.teamKey,
    closedAt: new Date().toISOString()
  };
}

function publicResults(store) {
  return companies.map((company) => {
    const result = store.results[auctionKey(company.era, company.id)];
    if (!result) return null;
    const winner = sortedBidsFor(company, store.bids)[0];
    if (!winner) return null;
    return {
      companyId: company.id,
      era: company.era,
      eraName: company.eraName,
      companyName: company.name,
      status: "awarded",
      winner: winner.team,
      bvi: Number(bvi(winner, company).toFixed(4)),
      closedAt: result.closedAt
    };
  }).filter(Boolean);
}

function privateTeamResults(store, teamKey) {
  return companies.flatMap((company) => {
    const result = store.results[auctionKey(company.era, company.id)];
    if (!result || result.winnerTeamKey !== teamKey) return [];
    const winner = sortedBidsFor(company, store.bids)[0];
    if (!winner || winner.teamKey !== teamKey) return [];
    return [{
      company: publicCompany(company),
      bid: publicBid(winner, company, 1),
      briefing: typeof company.winnerBriefing === "string" ? company.winnerBriefing : null,
      awardedAt: result.closedAt
    }];
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

function loginAttemptKey(request, identity) {
  return `${request.socket.remoteAddress || "unknown"}:${identity}`;
}

function isRateLimited(request, identity) {
  const key = loginAttemptKey(request, identity);
  const record = loginAttempts.get(key);
  if (!record) return false;
  if (record.expiresAt <= Date.now()) {
    loginAttempts.delete(key);
    return false;
  }
  return record.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedLogin(request, identity) {
  const key = loginAttemptKey(request, identity);
  const record = loginAttempts.get(key);
  if (!record || record.expiresAt <= Date.now()) {
    loginAttempts.set(key, { count: 1, expiresAt: Date.now() + LOGIN_WINDOW_MS });
    return;
  }
  record.count += 1;
}

function clearLoginFailures(request, identity) {
  loginAttempts.delete(loginAttemptKey(request, identity));
}

function requireRole(request, response, role) {
  const session = getSession(request);
  if (!session || session.role !== role) {
    sendError(response, 401, role === "admin"
      ? "Sign in as an admin to continue."
      : "Sign in with your team access code to continue.");
    return null;
  }
  return session;
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/healthz") {
    return sendJson(response, 200, { status: "ok" });
  }
  if (request.method === "GET" && pathname === "/") {
    return serveAsset(response, "index.html", "text/html; charset=utf-8");
  }
  if (request.method === "GET" && pathname === "/admin") {
    return serveAsset(response, "admin.html", "text/html; charset=utf-8");
  }
  if (request.method === "GET" && pathname === "/team") {
    return serveAsset(response, "team.html", "text/html; charset=utf-8");
  }
  if (request.method === "GET" && pathname === "/app.css") {
    return serveAsset(response, "app.css", "text/css; charset=utf-8");
  }
  if (request.method === "GET" && pathname === "/app.js") {
    return serveAsset(response, "public.js", "text/javascript; charset=utf-8");
  }
  if (request.method === "GET" && pathname === "/public.js") {
    return serveAsset(response, "public.js", "text/javascript; charset=utf-8");
  }
  if (request.method === "GET" && pathname === "/admin.js") {
    return serveAsset(response, "admin.js", "text/javascript; charset=utf-8");
  }
  if (request.method === "GET" && pathname === "/team.js") {
    return serveAsset(response, "team.js", "text/javascript; charset=utf-8");
  }
  if (request.method === "GET" && pathname === "/SynLogo.png") {
    return serveAsset(response, "SynLogo.png", "image/png");
  }
  if (request.method === "GET" && pathname === "/ecell-logo(withoutBG).png") {
    return serveAsset(response, "ecell-logo(withoutBG).png", "image/png");
  }
  if (request.method === "GET" && pathname === "/api/events") {
    const eras = [...new Set(companies.map((company) => company.era))].map((era) => ({
      id: era,
      name: companies.find((company) => company.era === era).eraName
    }));
    return sendJson(response, 200, {
      companies: companies.map(publicCompany),
      eras,
      rules: {
        vaultCapital: VAULT_CAPITAL,
        singleBidLimit: SINGLE_BID_LIMIT,
        minimumDistinctBids: MIN_DISTINCT_BIDS
      }
    });
  }
  if (request.method === "GET" && pathname === "/api/public/leaderboard") {
    const store = readStore();
    const activeCompany = store.auction.status === "open"
      ? companies.find((company) =>
        company.id === store.auction.companyId && company.era === store.auction.era
      )
      : null;
    return sendJson(response, 200, {
      results: publicResults(store),
      auctionStatus: store.auction.status,
      activeCompany: activeCompany
        ? { id: activeCompany.id, eraName: activeCompany.eraName, name: activeCompany.name }
        : null
    });
  }
  if (request.method === "GET" && pathname === "/api/auth/session") {
    const session = getSession(request);
    if (!session) return sendJson(response, 200, { authenticated: false });
    if (session.role === "admin") return sendJson(response, 200, { authenticated: true, role: "admin" });
    const store = readStore();
    const team = store.teams.find((item) => item.key === session.teamKey);
    if (!team) {
      sessions.delete(parseCookies(request.headers.cookie).synergy_session);
      return sendJson(response, 200, { authenticated: false });
    }
    return sendJson(response, 200, { authenticated: true, role: "participant", team: team.name });
  }
  if (request.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJson(request);
    const name = typeof body.team === "string" ? body.team.trim().replace(/\s+/g, " ") : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const identity = `team:${name.toLocaleLowerCase("en") || "unknown"}`;
    if (isRateLimited(request, identity)) {
      return sendError(response, 429, "Too many sign-in attempts for this team. Try again in 15 minutes.");
    }
    const team = readStore().teams.find((item) => item.key === name.toLocaleLowerCase("en"));
    let valid = false;
    if (team && code && typeof team.salt === "string" && typeof team.codeHash === "string") {
      const expected = Buffer.from(team.codeHash, "hex");
      const actual = crypto.scryptSync(code, team.salt, 64);
      valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }
    if (!valid) {
      recordFailedLogin(request, identity);
      return sendError(response, 401, "That team name and access code do not match.");
    }
    clearLoginFailures(request, identity);
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, {
      role: "participant",
      teamKey: team.key,
      expiresAt: Date.now() + SESSION_TTL_MS
    });
    setSessionCookie(response, token);
    return sendJson(response, 200, { message: "You are signed in.", team: team.name });
  }
  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const token = parseCookies(request.headers.cookie).synergy_session;
    if (token) sessions.delete(token);
    setSessionCookie(response, "", 0);
    return sendJson(response, 200, { message: "You are signed out." });
  }
  if (request.method === "POST" && pathname === "/api/admin/login") {
    const body = await readJson(request);
    if (isRateLimited(request, "admin")) {
      return sendError(response, 429, "Too many admin sign-in attempts. Try again in 15 minutes.");
    }
    const supplied = typeof body.password === "string" ? body.password : "";
    const expected = Buffer.from(ADMIN_PASSWORD);
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      recordFailedLogin(request, "admin");
      return sendError(response, 401, "That admin password was not accepted.");
    }
    clearLoginFailures(request, "admin");
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, { role: "admin", expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(response, token);
    return sendJson(response, 200, { message: "Admin access granted." });
  }
  if (request.method === "POST" && pathname === "/api/admin/logout") {
    const token = parseCookies(request.headers.cookie).synergy_session;
    if (token) sessions.delete(token);
    setSessionCookie(response, "", 0);
    return sendJson(response, 200, { message: "You are signed out." });
  }
  if (request.method === "GET" && pathname === "/api/team/results") {
    const session = requireRole(request, response, "participant");
    if (!session) return;
    const store = readStore();
    return sendJson(response, 200, { results: privateTeamResults(store, session.teamKey) });
  }
  if (request.method === "GET" && pathname === "/api/auction") {
    const session = getSession(request);
    if (!session) return sendError(response, 401, "Sign in to view the live auction.");
    const store = readStore();
    const company = companies.find((item) =>
      item.era === store.auction.era && item.id === store.auction.companyId
    );
    if (!company) {
      return sendJson(response, 200, {
        status: store.auction.status,
        era: store.auction.era,
        company: null,
        leaderboard: [],
        myBid: null,
        participantCount: store.teams.length
      });
    }
    const bids = leaderboardFor(company, store.bids);
    const ownBid = session.role === "participant"
      ? store.bids.find((bid) => bid.teamKey === session.teamKey && bid.companyId === company.id && bid.era === company.era)
      : null;
    return sendJson(response, 200, {
      status: store.auction.status,
      era: store.auction.era,
      company: publicCompany(company),
      leaderboard: bids,
      myBid: ownBid ? publicBid(ownBid, company, bids.find((bid) => bid.team === ownBid.team)?.rank || null) : null,
      participantCount: store.teams.length
    });
  }
  if (request.method === "POST" && pathname === "/api/bids") {
    const session = requireRole(request, response, "participant");
    if (!session) return;
    const body = await readJson(request);
    const store = readStore();
    if (store.auction.status !== "open" || !store.auction.companyId) {
      return sendError(response, 409, "The auction is not open yet.");
    }
    const company = companies.find((item) =>
      item.id === store.auction.companyId && item.era === store.auction.era
    );
    if (!company) return sendError(response, 409, "The active auction company is unavailable.");
    const principal = Number(body.principal);
    const ratePercent = Number(body.ratePercent);
    if (!Number.isSafeInteger(principal) || principal % 10000 !== 0) {
      return sendError(response, 400, "Enter a principal in increments of ₹10,000.");
    }
    if (principal < minPrincipal(company)) {
      return sendError(response, 400, `The minimum offer for this company is ${minPrincipal(company).toLocaleString("en-IN")} rupees.`);
    }
    if (principal > SINGLE_BID_LIMIT) {
      return sendError(response, 400, `The maximum offer for one company is ${SINGLE_BID_LIMIT.toLocaleString("en-IN")} rupees.`);
    }
    if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > company.maximumRate || Math.round(ratePercent * 100) % 50 !== 0) {
      return sendError(response, 400, `Enter an interest rate in 0.5% increments, up to ${company.maximumRate}%.`);
    }
    const team = store.teams.find((item) => item.key === session.teamKey);
    if (!team) return sendError(response, 401, "This team account is no longer available.");
    const existingIndex = store.bids.findIndex((bid) =>
      bid.era === company.era && bid.companyId === company.id && bid.teamKey === session.teamKey
    );
    const committed = store.bids.reduce((sum, bid, index) => {
      if (bid.era !== company.era || bid.teamKey !== session.teamKey || index === existingIndex) return sum;
      return sum + bid.principal;
    }, 0);
    if (committed + principal > VAULT_CAPITAL) {
      return sendError(response, 400, `This offer would exceed your ${VAULT_CAPITAL.toLocaleString("en-IN")} rupee vault for this era.`);
    }
    const bid = {
      era: company.era,
      companyId: company.id,
      team: team.name,
      teamKey: team.key,
      principal,
      ratePercent,
      submittedAt: new Date().toISOString()
    };
    if (existingIndex >= 0) store.bids[existingIndex] = bid;
    else store.bids.push(bid);
    writeStore(store);
    const rank = sortedBidsFor(company, store.bids)
      .findIndex((item) => item.teamKey === session.teamKey) + 1;
    return sendJson(response, 201, {
      message: "Your bid is on the leaderboard.",
      bvi: Number(bvi(bid, company).toFixed(4)),
      rank,
      committed: committed + principal,
      remaining: VAULT_CAPITAL - committed - principal
    });
  }
  if (pathname.startsWith("/api/admin/")) {
    const session = requireRole(request, response, "admin");
    if (!session) return;

    if (request.method === "GET" && pathname === "/api/admin/teams") {
      const store = readStore();
      return sendJson(response, 200, {
        teams: store.teams.map((team) => ({ name: team.name, createdAt: team.createdAt }))
      });
    }

    if (request.method === "POST" && pathname === "/api/admin/teams") {
      const body = await readJson(request);
      const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
      if (!/^[\p{L}\p{N}][\p{L}\p{N} '&.-]{1,34}$/u.test(name)) {
        return sendError(response, 400, "Enter a team name between 2 and 35 characters.");
      }
      const store = readStore();
      const key = name.toLocaleLowerCase("en");
      if (store.teams.some((team) => team.key === key)) {
        return sendError(response, 409, "A team with that name already exists.");
      }
      const code = crypto.randomBytes(9).toString("base64url");
      const salt = crypto.randomBytes(16).toString("hex");
      store.teams.push({
        name,
        key,
        salt,
        codeHash: crypto.scryptSync(code, salt, 64).toString("hex"),
        createdAt: new Date().toISOString()
      });
      writeStore(store);
      return sendJson(response, 201, { team: name, accessCode: code });
    }
    if (request.method === "POST" && pathname === "/api/admin/auction") {
      const body = await readJson(request);
      const store = readStore();
      if (body.status === "closed") {
        finalizeAuction(store);
        store.auction = { ...store.auction, status: "closed" };
        writeStore(store);
        return sendJson(response, 200, { auction: store.auction });
      }
      if (body.status !== "open") {
        return sendError(response, 400, "Choose a company to open the auction.");
      }
      const company = companies.find((item) => item.id === body.companyId && item.era === body.era);
      if (!company) return sendError(response, 400, "Choose a listed company.");
      if (store.auction.status === "open") finalizeAuction(store);
      delete store.results[auctionKey(company.era, company.id)];
      store.auction = { status: "open", era: company.era, companyId: company.id };
      writeStore(store);
      return sendJson(response, 200, { auction: store.auction });
    }
    if (request.method === "GET" && pathname === "/api/admin/leaderboard") {
      const era = url.searchParams.get("era");
      if (!companies.some((company) => company.era === era)) {
        return sendError(response, 400, "Choose a valid era.");
      }
      const store = readStore();
      const eraCompanies = companies.filter((company) => company.era === era);
      const bids = store.bids.filter((bid) => bid.era === era);
      return sendJson(response, 200, {
        auction: store.auction,
        teamCount: store.teams.length,
        validBidCount: bids.length,
        leaderboard: eraCompanies.map((company) => ({
          company: publicCompany(company),
          bids: leaderboardFor(company, bids)
        }))
      });
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
  console.log(`Banks & Bloodlines is listening on http://localhost:${PORT}`);
  console.log(`Participant and bid data will be stored in ${STORE_FILE}`);
});
