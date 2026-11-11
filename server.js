const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const bloodlines = require("./bloodlines-engine");

const ROOT = __dirname;
const DATA_FILE = process.env.COMPANIES_FILE || path.join(ROOT, "data", "test.json");
const INITIAL_TEAMS_FILE = process.env.INITIAL_TEAMS_FILE;
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
const BANKING_BOND_RATE = 0.06;
const BANKING_DECADE_YEARS = 10;
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

function loadInitialTeams() {
  if (!INITIAL_TEAMS_FILE) return [];
  const file = path.resolve(ROOT, INITIAL_TEAMS_FILE);
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load initial teams from ${file}: ${error.message}`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(`Initial teams file ${file} must contain a JSON array.`);
  }

  const names = new Set();
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Initial teams file ${file}: team ${index + 1} must be an object.`);
    }
    const name = typeof entry.name === "string" ? entry.name.trim().replace(/\s+/g, " ") : "";
    const accessCode = typeof entry.accessCode === "string" ? entry.accessCode.trim() : "";
    const key = name.toLocaleLowerCase("en");
    if (!/^[\p{L}\p{N}][\p{L}\p{N} '&.-]{1,34}$/u.test(name)) {
      throw new Error(`Initial teams file ${file}: team ${index + 1} needs a name between 2 and 35 characters.`);
    }
    if (!accessCode || accessCode.length < 12) {
      throw new Error(`Initial teams file ${file}: team ${name} needs an access code of at least 12 characters.`);
    }
    if (names.has(key)) {
      throw new Error(`Initial teams file ${file}: duplicate team name "${name}".`);
    }
    names.add(key);
    const salt = crypto.randomBytes(16).toString("hex");
    return {
      name,
      key,
      salt,
      codeHash: crypto.scryptSync(accessCode, salt, 64).toString("hex"),
      createdAt: new Date().toISOString()
    };
  });
}

const initialTeams = loadInitialTeams();

function readStore() {
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      const store = {
        bids: [],
        teams: [...initialTeams],
        results: {},
        initialTeamsSeeded: initialTeams.length > 0,
        auction: { status: "waiting", era: null, companyId: null },
        activeRound: 1,
        banking: null
      };
      ensureBankingState(store);
      if (initialTeams.length) writeStore(store);
      return store;
    }
    throw error;
  }
  if (!Array.isArray(stored.bids)) throw new Error("Bids data must be an array.");
  const store = {
    bids: stored.bids,
    teams: Array.isArray(stored.teams) ? stored.teams : [],
    results: stored.results && typeof stored.results === "object" ? stored.results : {},
    initialTeamsSeeded: stored.initialTeamsSeeded === true,
    auction: stored.auction && typeof stored.auction === "object"
      ? stored.auction
      : { status: "waiting", era: null, companyId: null },
    activeRound: stored.activeRound === 2 ? 2 : 1,
    banking: stored.banking && typeof stored.banking === "object" ? stored.banking : null
  };
  if (initialTeams.length && !store.initialTeamsSeeded) {
    const existingKeys = new Set(store.teams.map((team) => team.key));
    const conflicts = initialTeams.filter((team) => existingKeys.has(team.key));
    if (conflicts.length) {
      throw new Error(`Cannot seed initial teams because these names already exist: ${conflicts.map((team) => team.name).join(", ")}. Rename them in the initial teams file.`);
    }
    store.teams.push(...initialTeams);
    store.initialTeamsSeeded = true;
    writeStore(store);
  }
  if (ensureBankingState(store)) writeStore(store);
  return store;
}

function writeStore(store) {
  const directory = path.dirname(STORE_FILE);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryFile = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, STORE_FILE);
}

function companyEraOrder() {
  return [...new Set(companies.map((company) => company.era))];
}

function parseDecadeStart(decade) {
  const match = typeof decade === "string"
    ? decade.trim().match(/^(\d{4})\s*[-–—]\s*(\d{4})$/)
    : null;
  if (!match || Number(match[2]) - Number(match[1]) !== 9) return null;
  return Number(match[1]);
}

function decadesForEra(era) {
  const groups = new Map();
  for (const company of companies.filter((item) => item.era === era)) {
    if (!groups.has(company.decade)) {
      groups.set(company.decade, { decade: company.decade, start: parseDecadeStart(company.decade), companies: [] });
    }
    groups.get(company.decade).companies.push(company);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.start !== null && b.start !== null) return a.start - b.start;
    return String(a.decade).localeCompare(String(b.decade));
  });
}

function bankingSetupErrors() {
  const errors = [];
  const eras = companyEraOrder();
  if (!eras.length) errors.push("The company dataset must contain at least one era.");
  const companyKeys = new Set();
  for (const company of companies) {
    const key = `${company.era}:${company.id}`;
    if (!company.era || !company.id || !company.name || companyKeys.has(key)) {
      errors.push(`${company.id || "A company"} must have a unique ID, era, and name.`);
    }
    companyKeys.add(key);
    if (!Number.isFinite(company.principalRequired) || company.principalRequired <= 0) {
      errors.push(`${company.id}: principalRequired must be a positive number.`);
    }
    if (!Number.isFinite(company.minimumFundingRatio)
        || company.minimumFundingRatio <= 0 || company.minimumFundingRatio > 1) {
      errors.push(`${company.id}: minimumFundingRatio must be greater than 0 and no higher than 1.`);
    }
    if (!Number.isFinite(company.maximumRate) || company.maximumRate <= 0) {
      errors.push(`${company.id}: maximumRate must be a positive number.`);
    }
    if (!Number.isFinite(company.strategicCoefficient)
        || company.strategicCoefficient < 0 || company.strategicCoefficient > 100) {
      errors.push(`${company.id}: strategicCoefficient must be between 0 and 100.`);
    }
    if (!Number.isFinite(company.growthMultiplier) || company.growthMultiplier <= 0) {
      errors.push(`${company.id}: growthMultiplier must be a positive number.`);
    }
    if (parseDecadeStart(company.decade) === null) {
      errors.push(`${company.id}: decade must be a 10-year range such as "1811-1820".`);
    }
  }
  for (const era of eras) {
    const groups = decadesForEra(era);
    if (groups.length !== 10) {
      errors.push(`${era}: expected exactly 10 distinct decade groups, found ${groups.length}.`);
    }
    const starts = groups.map((group) => group.start).filter((start) => start !== null);
    if (new Set(starts).size !== starts.length) {
      errors.push(`${era}: decade year ranges must be unique.`);
    }
    for (let index = 1; index < groups.length; index += 1) {
      if (groups[index - 1].start !== null && groups[index].start !== null
          && groups[index].start < groups[index - 1].start + BANKING_DECADE_YEARS) {
        errors.push(`${era}: decade year ranges must not overlap.`);
        break;
      }
    }
  }
  return errors;
}

function newBankingAccount() {
  return { balance: VAULT_CAPITAL, portfolio: [], ledger: [] };
}

function ensureBankingState(store) {
  let changed = false;
  if (!store.banking || store.banking.schemaVersion !== 1) {
    const banking = {
      schemaVersion: 1,
      activeEraIndex: 0,
      decadeIndex: 0,
      complete: false,
      accounts: {},
      settlementHistory: [],
      positionHistory: []
    };
    for (const result of Object.values(store.results || {})) {
      if (!result?.winnerTeamKey) continue;
      const company = companies.find((item) => item.era === result.era && item.id === result.companyId);
      if (!company) continue;
      const winningBid = sortedBidsFor(company, store.bids)
        .find((bid) => bid.teamKey === result.winnerTeamKey);
      if (!winningBid) continue;
      const account = banking.accounts[winningBid.teamKey] ||= newBankingAccount();
      account.balance -= winningBid.principal;
      account.portfolio.push({
        era: company.era,
        decade: company.decade,
        companyId: company.id,
        teamKey: winningBid.teamKey,
        principal: winningBid.principal,
        ratePercent: winningBid.ratePercent,
        growthMultiplier: company.growthMultiplier,
        npi: null,
        interestPaid: 0,
        status: "active"
      });
    }
    store.banking = banking;
    changed = true;
  }
  for (const team of store.teams) {
    if (!store.banking.accounts[team.key]) {
      store.banking.accounts[team.key] = newBankingAccount();
      changed = true;
    }
  }
  return changed;
}

function currentBankingGroup(store) {
  const eras = companyEraOrder();
  if (store.banking.complete || store.banking.activeEraIndex >= eras.length) return null;
  const era = eras[store.banking.activeEraIndex];
  const groups = decadesForEra(era);
  return {
    era,
    eraName: companies.find((company) => company.era === era)?.eraName || era,
    decadeIndex: store.banking.decadeIndex,
    decadeCount: groups.length,
    group: groups[store.banking.decadeIndex] || null
  };
}

function positionFor(store, teamKey, era, companyId) {
  return store.banking.accounts[teamKey]?.portfolio.find(
    (position) => position.era === era && position.companyId === companyId
  );
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

function getClientIp(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  const address = typeof forwardedFor === "string"
    ? forwardedFor.split(",")[0].trim()
    : request.socket.remoteAddress || "unknown";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function getSession(request) {
  const token = parseCookies(request.headers.cookie).synergy_session;
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  if (session.role === "participant" && session.clientIp !== getClientIp(request)) return null;
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

function bidTermsError(principal, ratePercent, company) {
  if (!Number.isSafeInteger(principal) || principal % 10000 !== 0) {
    return "Enter a principal in increments of ₹10,000.";
  }
  if (principal < minPrincipal(company)) {
    return `The minimum offer for this company is ${minPrincipal(company).toLocaleString("en-IN")} rupees.`;
  }
  if (principal > SINGLE_BID_LIMIT) {
    return `The maximum offer for one company is ${SINGLE_BID_LIMIT.toLocaleString("en-IN")} rupees.`;
  }
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > company.maximumRate || Math.round(ratePercent * 100) % 50 !== 0) {
    return `Enter an interest rate in 0.5% increments, up to ${company.maximumRate}%.`;
  }
  return null;
}

function auctionKey(era, companyId) {
  return `${era}:${companyId}`;
}

function finalizeAuction(store) {
  const { era, companyId } = store.auction;
  if (!era || !companyId) return;
  const company = companies.find((item) => item.era === era && item.id === companyId);
  if (!company) return;
  const key = auctionKey(era, companyId);
  if (store.results[key]) return;
  const winningBid = sortedBidsFor(company, store.bids)[0];
  if (!winningBid) {
    store.results[key] = {
      era,
      companyId,
      winnerTeamKey: null,
      status: "no-bids",
      closedAt: new Date().toISOString()
    };
    return;
  }
  const account = store.banking.accounts[winningBid.teamKey];
  if (!account || winningBid.principal > account.balance) {
    throw new Error(`The winning bid for ${company.name} exceeds the team's available balance.`);
  }
  account.balance -= winningBid.principal;
  account.portfolio.push({
    era: company.era,
    decade: company.decade,
    companyId: company.id,
    teamKey: winningBid.teamKey,
    principal: winningBid.principal,
    ratePercent: winningBid.ratePercent,
    growthMultiplier: company.growthMultiplier,
    npi: null,
    interestPaid: 0,
    status: "active"
  });
  store.results[key] = {
    era,
    companyId,
    winnerTeamKey: winningBid.teamKey,
    status: "awarded",
    closedAt: new Date().toISOString()
  };
}

function publicResults(store) {
  return companies.map((company) => {
    const result = store.results[auctionKey(company.era, company.id)];
    if (!result || !result.winnerTeamKey) return null;
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

function privateBankingAccount(store, teamKey) {
  const account = store.banking.accounts[teamKey];
  if (!account) return null;
  const describePosition = (position) => {
    const company = companies.find((item) => item.id === position.companyId && item.era === position.era);
    return {
      companyId: position.companyId,
      companyName: company?.name || position.companyId,
      era: position.era,
      decade: position.decade,
      principal: position.principal,
      ratePercent: position.ratePercent,
      npi: position.npi,
      interestPaid: position.interestPaid,
      principalReturned: position.principalReturned ?? null,
      status: position.status
    };
  };
  const current = currentBankingGroup(store);
  return {
    balance: account.balance,
    portfolio: account.portfolio.map(describePosition),
    history: store.banking.positionHistory
      .filter((position) => position.teamKey === teamKey)
      .map(describePosition),
    current: current ? {
      era: current.era,
      eraName: current.eraName,
      decade: current.group?.decade || null,
      decadeIndex: current.decadeIndex + 1,
      decadeCount: current.decadeCount
    } : null,
    ledger: account.ledger.slice(-50).reverse().map(({ type, era, decade, companyId, amount, npi }) => ({
      type, era, decade, companyId, amount, npi
    }))
  };
}

function settleBankingDecade(store) {
  const setupErrors = bankingSetupErrors();
  if (setupErrors.length) {
    throw Object.assign(new Error(setupErrors.join(" ")), { status: 409 });
  }
  if (store.auction.status === "open") {
    throw Object.assign(new Error("Close the current company auction before settling this decade."), { status: 409 });
  }
  const current = currentBankingGroup(store);
  if (!current?.group) {
    throw Object.assign(new Error("There is no active decade to settle."), { status: 409 });
  }
  const missing = current.group.companies.filter(
    (company) => !store.results[auctionKey(company.era, company.id)]
  );
  if (missing.length) {
    throw Object.assign(new Error(`Close every company auction in this decade before settling: ${missing.map((company) => company.id).join(", ")}.`), { status: 409 });
  }

  const decade = current.group.decade;
  const bondFactor = (1 + BANKING_BOND_RATE) ** BANKING_DECADE_YEARS;
  const bondCredits = [];
  for (const team of store.teams) {
    const account = store.banking.accounts[team.key];
    const priorBalance = account.balance;
    account.balance = Math.round(account.balance * bondFactor);
    const amount = account.balance - priorBalance;
    account.ledger.push({
      type: "bond",
      era: current.era,
      decade,
      amount,
      at: new Date().toISOString()
    });
    bondCredits.push({ teamKey: team.key, amount });
  }

  const outcomes = [];
  for (const company of current.group.companies) {
    const result = store.results[auctionKey(company.era, company.id)];
    if (!result.winnerTeamKey) {
      result.npi = 0;
      result.interestPaid = 0;
      outcomes.push({
        companyId: company.id,
        companyName: company.name,
        winnerTeamKey: null,
        npi: 0,
        interestPaid: 0
      });
      continue;
    }
    const winningBid = sortedBidsFor(company, store.bids)
      .find((bid) => bid.teamKey === result.winnerTeamKey);
    const position = positionFor(store, result.winnerTeamKey, company.era, company.id);
    if (!winningBid || !position) {
      throw new Error(`The awarded position for ${company.id} is missing.`);
    }
    const fundingModifier = Math.min(100, winningBid.principal / company.principalRequired * 100);
    const interestDrag = winningBid.ratePercent;
    const npi = Number(Math.max(
      0,
      Math.min(100, company.strategicCoefficient * (fundingModifier - interestDrag) / 100)
    ).toFixed(2));
    const interestPaid = npi >= 50
      ? Math.round(winningBid.principal * winningBid.ratePercent / 100 * BANKING_DECADE_YEARS)
      : 0;
    result.npi = npi;
    result.interestPaid = interestPaid;
    position.npi = result.npi;
    position.interestPaid = interestPaid;
    position.status = "decade-settled";
    if (interestPaid) {
      const account = store.banking.accounts[result.winnerTeamKey];
      account.balance += interestPaid;
      account.ledger.push({
        type: "company-interest",
        era: current.era,
        decade,
        companyId: company.id,
        amount: interestPaid,
        npi: result.npi,
        at: new Date().toISOString()
      });
    }
    outcomes.push({
      companyId: company.id,
      companyName: company.name,
      winnerTeamKey: result.winnerTeamKey,
      npi: result.npi,
      interestPaid
    });
  }

  const settlement = {
    era: current.era,
    eraName: current.eraName,
    decade,
    decadeIndex: current.decadeIndex + 1,
    settledAt: new Date().toISOString(),
    bondCredits,
    outcomes,
    eraSettlement: null
  };
  store.banking.settlementHistory.push(settlement);
  store.banking.decadeIndex += 1;

  if (store.banking.decadeIndex === 10) {
    const principalReturns = [];
    for (const team of store.teams) {
      const account = store.banking.accounts[team.key];
      const remaining = [];
      for (const position of account.portfolio) {
        if (position.era !== current.era) {
          remaining.push(position);
          continue;
        }
        const principalFactor = position.npi < 50
          ? 0.4
          : position.npi >= 75 ? position.growthMultiplier : 1;
        const principalReturned = Math.round(position.principal * principalFactor);
        account.balance += principalReturned;
        position.principalReturned = principalReturned;
        position.status = "era-settled";
        position.settledAt = new Date().toISOString();
        account.ledger.push({
          type: "principal-return",
          era: current.era,
          decade: position.decade,
          companyId: position.companyId,
          amount: principalReturned,
          npi: position.npi,
          at: position.settledAt
        });
        store.banking.positionHistory.push({ ...position });
        const result = store.results[auctionKey(position.era, position.companyId)];
        if (result) result.principalReturned = principalReturned;
        principalReturns.push({
          teamKey: team.key,
          teamName: team.name,
          companyId: position.companyId,
          companyName: companies.find((company) =>
            company.era === position.era && company.id === position.companyId
          )?.name || position.companyId,
          npi: position.npi,
          principalReturned
        });
      }
      account.portfolio = remaining;
    }
    settlement.eraSettlement = {
      settledAt: new Date().toISOString(),
      principalReturns
    };
    store.banking.activeEraIndex += 1;
    store.banking.decadeIndex = 0;
    if (store.banking.activeEraIndex >= companyEraOrder().length) {
      store.banking.complete = true;
    }
  }
  store.auction = { status: "waiting", era: null, companyId: null };
  return settlement;
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
  return `${getClientIp(request)}:${identity}`;
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
  if (request.method === "GET" && pathname === "/round-switcher.js") {
    return serveAsset(response, "round-switcher.js", "text/javascript; charset=utf-8");
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
      eras,
      rules: {
        vaultCapital: VAULT_CAPITAL,
        singleBidLimit: SINGLE_BID_LIMIT,
        minimumDistinctBids: MIN_DISTINCT_BIDS,
        bondAnnualRate: BANKING_BOND_RATE,
        decadeYears: BANKING_DECADE_YEARS
      },
      banking: {
        interestThreshold: 50,
        growthThreshold: 75,
        lowNpiPrincipalReturn: 0.4
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
  if (request.method === "GET" && pathname === "/api/round") {
    const store = readStore();
    return sendJson(response, 200, { round: store.activeRound });
  }
  if (request.method === "POST" && pathname === "/api/admin/round") {
    if (!requireRole(request, response, "admin")) return;
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)
        || body.round !== 1 && body.round !== 2) {
      return sendError(response, 400, "Choose Round 1 or Round 2.");
    }
    const store = readStore();
    store.activeRound = body.round;
    writeStore(store);
    return sendJson(response, 200, { round: store.activeRound });
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
    const clientIp = getClientIp(request);
    for (const [token, activeSession] of sessions) {
      if (activeSession.expiresAt <= Date.now()) {
        sessions.delete(token);
        continue;
      }
      if (activeSession.role === "participant"
          && activeSession.teamKey === team.key
          && activeSession.clientIp !== clientIp) {
        return sendError(response, 409, "This team account is already signed in from another IP address. Sign out there or wait for that session to expire.");
      }
    }
    clearLoginFailures(request, identity);
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, {
      role: "participant",
      teamKey: team.key,
      teamName: team.name,
      clientIp,
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
    return sendJson(response, 200, {
      results: privateTeamResults(store, session.teamKey),
      banking: privateBankingAccount(store, session.teamKey)
    });
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
        participantCount: store.teams.length,
        banking: session.role === "participant"
          ? privateBankingAccount(store, session.teamKey)?.current || null
          : undefined
      });
    }
    const allBids = leaderboardFor(company, store.bids);
    const ownBid = session.role === "participant"
      ? store.bids.find((bid) => bid.teamKey === session.teamKey && bid.companyId === company.id && bid.era === company.era)
      : null;
    const bids = session.role === "participant"
      ? allBids.map(({ rank, team, bvi: score }) => ({ rank, team, bvi: score }))
      : allBids;
    return sendJson(response, 200, {
      status: store.auction.status,
      era: store.auction.era,
      company: publicCompany(company),
      leaderboard: bids,
      myBid: ownBid ? publicBid(ownBid, company, bids.find((bid) => bid.team === ownBid.team)?.rank || null) : null,
      participantCount: store.teams.length,
      banking: session.role === "participant"
        ? privateBankingAccount(store, session.teamKey)?.current || null
        : undefined
    });
  }
  if (request.method === "POST" && pathname === "/api/bids/preview") {
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
    const team = store.teams.find((item) => item.key === session.teamKey);
    if (!team) return sendError(response, 401, "This team account is no longer available.");
    const principal = Number(body.principal);
    const ratePercent = Number(body.ratePercent);
    const termsError = bidTermsError(principal, ratePercent, company);
    if (termsError) return sendError(response, 400, termsError);
    const account = store.banking.accounts[session.teamKey];
    if (!account || principal > account.balance) {
      return sendError(response, 400, "This offer exceeds your available cash balance.");
    }
    const candidate = {
      era: company.era,
      companyId: company.id,
      team: team.name,
      teamKey: team.key,
      principal,
      ratePercent,
      submittedAt: new Date().toISOString()
    };
    const ranking = sortedBidsFor(company, [
      ...store.bids.filter((bid) => bid.teamKey !== session.teamKey),
      candidate
    ]);
    return sendJson(response, 200, {
      bvi: Number(bvi(candidate, company).toFixed(4)),
      rank: ranking.findIndex((bid) => bid.teamKey === session.teamKey) + 1,
      competingBids: ranking.length - 1,
      balanceIfAwarded: account.balance - principal
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
    const termsError = bidTermsError(principal, ratePercent, company);
    if (termsError) return sendError(response, 400, termsError);
    const team = store.teams.find((item) => item.key === session.teamKey);
    if (!team) return sendError(response, 401, "This team account is no longer available.");
    const existingIndex = store.bids.findIndex((bid) =>
      bid.era === company.era && bid.companyId === company.id && bid.teamKey === session.teamKey
    );
    const account = store.banking.accounts[session.teamKey];
    if (!account || principal > account.balance) {
      return sendError(response, 400, "This offer exceeds your available cash balance.");
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
      balanceIfAwarded: account.balance - principal
    });
  }
  if (pathname.startsWith("/api/admin/")) {
    const session = requireRole(request, response, "admin");
    if (!session) return;

    if (request.method === "GET" && pathname === "/api/admin/events") {
      const eras = companyEraOrder().map((era) => ({
        id: era,
        name: companies.find((company) => company.era === era).eraName
      }));
      return sendJson(response, 200, {
        companies: companies.map(publicCompany),
        eras,
        setupErrors: bankingSetupErrors()
      });
    }

    if (request.method === "GET" && pathname === "/api/admin/banking") {
      const store = readStore();
      const current = currentBankingGroup(store);
      return sendJson(response, 200, {
        ready: bankingSetupErrors().length === 0,
        setupErrors: bankingSetupErrors(),
        complete: store.banking.complete,
        eraIndex: store.banking.activeEraIndex,
        decadeIndex: store.banking.decadeIndex,
        current: current?.group ? {
          era: current.era,
          eraName: current.eraName,
          decade: current.group.decade,
          decadeIndex: current.decadeIndex + 1,
          decadeCount: current.decadeCount,
          companies: current.group.companies.map((company) => {
            const result = store.results[auctionKey(company.era, company.id)];
            return {
              id: company.id,
              name: company.name,
              auctioned: Boolean(result),
              status: result?.status || "waiting",
              winner: result?.winnerTeamKey
                ? store.teams.find((team) => team.key === result.winnerTeamKey)?.name || null
                : null,
              npi: result?.npi ?? null,
              interestPaid: result?.interestPaid ?? null
            };
          })
        } : null,
        teams: store.teams.map((team) => ({
          name: team.name,
          balance: store.banking.accounts[team.key]?.balance ?? VAULT_CAPITAL,
          invested: (store.banking.accounts[team.key]?.portfolio || [])
            .reduce((sum, position) => sum + position.principal, 0)
        })),
        lastSettlement: store.banking.settlementHistory.at(-1) || null
      });
    }

    if (request.method === "POST" && pathname === "/api/admin/banking/settle-decade") {
      const store = readStore();
      const settlement = settleBankingDecade(store);
      writeStore(store);
      return sendJson(response, 200, { settlement });
    }

    if (request.method === "GET" && pathname === "/api/admin/teams") {
      const store = readStore();
      return sendJson(response, 200, {
        teams: store.teams.map((team) => ({
          name: team.name,
          createdAt: team.createdAt,
          balance: store.banking.accounts[team.key]?.balance ?? VAULT_CAPITAL
        }))
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
      ensureBankingState(store);
      writeStore(store);
      return sendJson(response, 201, { team: name, accessCode: code });
    }
    if (request.method === "POST" && pathname === "/api/admin/auction") {
      const body = await readJson(request);
      const store = readStore();
      if (body.status === "closed") {
        if (store.auction.status !== "open") {
          return sendError(response, 409, "There is no open company auction to close.");
        }
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
      const setupErrors = bankingSetupErrors();
      if (setupErrors.length) {
        return sendError(response, 409, setupErrors.join(" "));
      }
      if (store.auction.status === "open") {
        return sendError(response, 409, "Close the current company auction before starting another.");
      }
      const current = currentBankingGroup(store);
      if (!current?.group || company.era !== current.era
          || !current.group.companies.some((item) => item.id === company.id)) {
        return sendError(response, 409, "Only a company in the active decade can be opened.");
      }
      if (store.results[auctionKey(company.era, company.id)]) {
        return sendError(response, 409, "This company auction has already closed.");
      }
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
  if (pathname.startsWith("/api/bloodlines/")) {
    const session = getSession(request);
    const store = readStore();
    return bloodlines.handle(request, response, pathname, session, store.teams);
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
