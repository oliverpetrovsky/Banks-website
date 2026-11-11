const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const STORE_FILE = process.env.BLOODLINES_STORE_FILE || path.join(ROOT, ".data", "bloodlines.json");
const MARKET_FILE = process.env.BLOODLINES_MARKET_FILE || path.join(ROOT, "data", "bloodlines-test-market.json");
const MAX_BODY_BYTES = 16 * 1024;
const YEARS = [
  { year: 1, inflation: 0, expenses: 250000, salary: 600000, startingCash: 500000 },
  { year: 2, inflation: 0.06, expenses: 265000, salary: 600000, startingCash: 0 },
  { year: 3, inflation: 0.045, expenses: 276925, salary: 600000, startingCash: 0 },
  { year: 4, inflation: 0.03, expenses: 285233, salary: 600000, startingCash: 0 }
];
const NEWS = [
  [
    "The economy grows at 7.2%. The central bank holds interest rates steady and inflation stays at base level.",
    "Enterprise cloud spending surges and AI licensing deals exceed market forecasts.",
    "The government announces a major five-year EV purchase incentive and charging infrastructure fund.",
    "Healthcare and pharmaceutical demand remains steady with stable quarterly approvals.",
    "Strong consumer sentiment drives high footfall and robust sales across retail chains."
  ],
  [
    "Inflation jumps to 6.0%. The central bank raises rates sharply and borrowing gets expensive.",
    "Valuation corrections hit tech shares and AI firms miss aggressive revenue targets.",
    "Rising battery costs and supply chain constraints force auto manufacturers to cut delivery targets.",
    "High inflation dampens discretionary spending; retail margins come under pressure.",
    "Investors rotate into defensive sectors like healthcare, lifting pharma stocks."
  ],
  [
    "Inflation cools to 4.5%. The central bank starts cutting rates and economic confidence returns.",
    "Consumer demand rebounds strongly, and tech firms beat quarterly forecasts.",
    "A price war breaks out in the EV space, impacting short-term profit margins.",
    "Breakthrough AI adoptions spark a sharp recovery and heavy institutional buying.",
    "Steady growth continues across major pharmaceutical portfolios."
  ],
  [
    "Inflation eases to 3.0%, but fears of a global slowdown build up toward year-end.",
    "New lower-priced vehicle models launch successfully, causing orders to jump.",
    "Government proposals for strict price caps on key medicines put pressure on pharma stocks.",
    "Patent disputes and tighter regulatory oversight introduce volatility into AI and tech stocks.",
    "Volatility rises as consumer spending slows down due to broader economic caution."
  ]
];
const INSTRUMENTS = [
  { id: "fd-1", name: "1-Year Fixed Deposit", type: "fd", rate: 0.07, earlyPenalty: 0.02, startPrice: 1 },
  { id: "fd-2", name: "2-Year Fixed Deposit", type: "fd", rate: 0.085, earlyPenalty: 0.02, startPrice: 1 },
  { id: "fund-meridian", name: "Meridian Nifty Index Fund", type: "fund", startPrice: 100 },
  { id: "fund-ignis", name: "Ignis Aggressive Small-Cap Fund", type: "fund", startPrice: 100 },
  { id: "fund-sentinel", name: "Sentinel Hybrid Debt Fund", type: "fund", startPrice: 100 },
  { id: "TECH", name: "Technology Systems", type: "equity", dividend: 12, startPrice: 1200 },
  { id: "AUTO", name: "Automobile & EV", type: "equity", dividend: 10, startPrice: 800 },
  { id: "HLTH", name: "Healthcare & Pharma", type: "equity", dividend: 14, startPrice: 950 },
  { id: "AI", name: "Artificial Intelligence", type: "equity", dividend: 10, startPrice: 450 },
  { id: "RET", name: "Retail & Consumer", type: "equity", dividend: 8, startPrice: 500 },
  { id: "gold", name: "Gold", type: "gold", startPrice: 6000 }
];
const INSURANCE = [
  { id: "health", name: "Health", premium: 25000 },
  { id: "term", name: "Term Life", premium: 15000 },
  { id: "home", name: "Asset / Home", premium: 10000 }
];
const WHEEL_EVENTS = [
  { id: "medical", name: "Medical Emergency", amount: -350000, insurance: "health", coverage: 1 },
  { id: "earner", name: "Loss of Primary Earner", amount: 0, insurance: "term", coverage: 0.8, nextYearPayout: 480000 },
  { id: "tax", name: "Tax Audit Penalty", amount: 0 },
  { id: "cyber", name: "Cyber Financial Breach", amount: -150000 },
  { id: "social", name: "Family Social Obligation", amount: -200000 },
  { id: "fire", name: "Property Damage / Fire", amount: -250000, insurance: "home", coverage: 1 },
  { id: "windfall", name: "Ancestral Property Windfall", amount: 300000 }
];
const OPEN_STAGES = ["household", "news", "trading", "market_reveal", "wheel_event"];

function readMarket() {
  try {
    const market = JSON.parse(fs.readFileSync(MARKET_FILE, "utf8"));
    if (!market || !market.prices || !market.prices.equities || !market.prices.funds || !market.prices.gold) {
      throw new Error("Market file must include equities, funds, and gold prices.");
    }
    for (const instrument of INSTRUMENTS.filter((item) => item.type === "equity" || item.type === "fund")) {
      const series = instrument.type === "equity"
        ? market.prices.equities[instrument.id]
        : market.prices.funds[instrument.id];
      if (!Array.isArray(series) || series.length !== 4
          || series.some((price) => !Number.isFinite(price) || price <= 0)) {
        throw new Error(`${instrument.id} must have four positive annual prices.`);
      }
    }
    if (!Array.isArray(market.prices.gold) || market.prices.gold.length !== 4
        || market.prices.gold.some((price) => !Number.isFinite(price) || price <= 0)) {
      throw new Error("Gold must have four positive annual prices.");
    }
    return market;
  } catch (error) {
    error.message = `Unable to load Bloodlines market data from ${MARKET_FILE}: ${error.message}`;
    throw error;
  }
}

function readStore() {
  try {
    const state = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (!state.teams || typeof state.teams !== "object") throw new Error("Bloodlines state has invalid teams.");
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      activeYear: 1,
      activeStage: 1,
      started: false,
      teams: {},
      eventsByYear: {},
      revealedYears: [],
      published: false,
      auditLog: []
    };
  }
}

function writeStore(state) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}

function ensureTeam(state, team) {
  if (!state.teams[team.key]) {
    state.teams[team.key] = {
      name: team.name,
      cash: 0,
      holdings: {},
      deposits: [],
      debt: 0,
      annual: {},
      incomeShock: false
    };
  }
  return state.teams[team.key];
}

function priceFor(market, instrumentId, year) {
  if (year === 0) return INSTRUMENTS.find((item) => item.id === instrumentId)?.startPrice;
  const series = instrumentId === "gold"
    ? market.prices.gold
    : market.prices.equities[instrumentId] || market.prices.funds[instrumentId];
  if (!Array.isArray(series) || !Number.isFinite(series[year - 1])) {
    throw new Error(`Missing ${instrumentId} market price for year ${year}.`);
  }
  return series[year - 1];
}

function priceForTrading(market, instrument, year) {
  return year === 1
    ? instrument.startPrice
    : priceFor(market, instrument.id, year - 1);
}

function record(ledger, type, amount, description) {
  ledger.entries.push({ type, amount: Math.round(amount * 100) / 100, description, at: new Date().toISOString() });
}

function beginYear(state, team, market, year) {
  const account = ensureTeam(state, team);
  if (account.annual[year]?.started) return account;
  const previous = account.annual[year - 1];
  if (year > 1 && (!previous || !previous.closed)) return account;
  const startCash = year === 1 ? YEARS[0].startingCash : account.cash;
  const ledger = { year, started: true, closed: false, entries: [], startCash, allocation: null, snapshot: null };
  account.cash = startCash;
  record(ledger, "opening", startCash, `Year ${year} opening cash`);
  if (account.incomeShock) {
    record(ledger, "salary", 0, "Primary earner loss: salary paused");
    account.cash += account.pendingTermPayout || 0;
    record(ledger, "insurance", account.pendingTermPayout || 0, "Term life payout");
    account.incomeShock = false;
    account.pendingTermPayout = 0;
  } else {
    account.cash += YEARS[year - 1].salary;
    record(ledger, "salary", YEARS[year - 1].salary, "Annual salary");
  }
  if (year > 1) {
    for (const [id, holding] of Object.entries(account.holdings)) {
      const instrument = INSTRUMENTS.find((item) => item.id === id);
      if (instrument?.type === "equity") {
        const dividend = holding.quantity * instrument.dividend;
        account.cash += dividend;
        record(ledger, "dividend", dividend, `${id} dividend`);
      }
    }
  }
  for (const deposit of account.deposits) {
    if (deposit.maturityYear === year && !deposit.matured) {
      const proceeds = deposit.principal * (1 + deposit.rate) ** deposit.term;
      account.cash += proceeds;
      deposit.matured = true;
      record(ledger, "fd_maturity", proceeds, `${deposit.term}-year FD maturity`);
    }
  }
  const expenses = YEARS[year - 1].expenses;
  account.cash -= expenses;
  record(ledger, "expense", -expenses, "Living expenses");
  if (account.debt > 0) {
    account.debt *= 1.15;
    record(ledger, "interest", -account.debt * (1 - 1 / 1.15), "Emergency loan interest");
    const repayment = Math.min(account.cash, account.debt);
    if (repayment > 0) {
      account.cash -= repayment;
      account.debt -= repayment;
      record(ledger, "loan_repayment", -repayment, "Emergency loan repayment");
    }
  }
  if (account.cash < 0) {
    account.debt += -account.cash;
    record(ledger, "loan", -account.cash, "Emergency distress loan");
    account.cash = 0;
  }
  ledger.snapshot = {
    cash: account.cash,
    holdings: structuredClone(account.holdings),
    deposits: structuredClone(account.deposits),
    debt: account.debt
  };
  account.annual[year] = ledger;
  return account;
}

function applyAllocation(account, ledger, allocation, market, year) {
  const snapshot = ledger.snapshot;
  account.cash = snapshot.cash;
  account.holdings = structuredClone(snapshot.holdings);
  account.deposits = structuredClone(snapshot.deposits);
  account.debt = snapshot.debt;
  ledger.entries = ledger.entries.filter((entry) => !["purchase", "sale", "insurance"].includes(entry.type));
  ledger.insurance = [];
  for (const item of allocation.trades) {
    const instrument = INSTRUMENTS.find((entry) => entry.id === item.instrument);
    if (!instrument || !["buy", "sell", "hold"].includes(item.action)) throw new Error("Choose a valid instrument and action.");
    if (item.action === "hold") continue;
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Enter a valid quantity for ${instrument.name}.`);
    if ((instrument.type === "equity" || instrument.type === "gold" || instrument.type === "fd") && !Number.isInteger(quantity)) {
      throw new Error(`${instrument.name} requires a whole-number quantity.`);
    }
    if (instrument.type === "fund" && Math.round(quantity * 100) !== quantity * 100) {
      throw new Error(`${instrument.name} units may have up to two decimal places.`);
    }
    const price = instrument.type === "fd" ? 1 : priceForTrading(market, instrument, year);
    if (instrument.type === "fd") {
      if (item.action === "buy") {
        const principal = quantity;
        if (principal % 10000 !== 0) throw new Error("Fixed deposits must be purchased in ₹10,000 increments.");
        if (principal > account.cash) throw new Error("Not enough cash for this fixed deposit.");
        account.cash -= principal;
        const term = instrument.id === "fd-1" ? 1 : 2;
        account.deposits.push({ principal, rate: instrument.rate, term, purchaseYear: year, maturityYear: year + term, matured: false });
        record(ledger, "purchase", -principal, instrument.name);
      } else {
        let remainingPrincipal = quantity;
        if (remainingPrincipal % 10000 !== 0) throw new Error("Fixed deposit withdrawals must be in ₹10,000 increments.");
        const requiredTerm = instrument.id === "fd-1" ? 1 : 2;
        for (const deposit of account.deposits) {
          if (deposit.term !== requiredTerm || deposit.matured || deposit.maturityYear <= year || remainingPrincipal <= 0) continue;
          const withdrawn = Math.min(remainingPrincipal, deposit.principal);
          const completedYears = Math.max(0, year - deposit.purchaseYear);
          const accrued = deposit.principal * (1 + deposit.rate) ** Math.min(completedYears, deposit.term);
          const proceeds = withdrawn * (accrued / deposit.principal - instrument.earlyPenalty);
          account.cash += proceeds;
          deposit.principal -= withdrawn;
          remainingPrincipal -= withdrawn;
          record(ledger, "sale", proceeds, `${instrument.name} early withdrawal after 2% penalty`);
        }
        account.deposits = account.deposits.filter((deposit) => deposit.principal > 0);
        if (remainingPrincipal > 0) throw new Error("Cannot withdraw more than your eligible fixed deposits.");
      }
      continue;
    }
    const gross = quantity * price;
    const fee = instrument.type === "equity" ? gross * 0.01 : 0;
    const key = instrument.id;
    const holding = account.holdings[key] || { quantity: 0, costBasis: 0 };
    if (item.action === "buy") {
      const cost = gross + fee;
      if (cost > account.cash) throw new Error(`Not enough cash to buy ${instrument.name}.`);
      holding.quantity += quantity;
      holding.costBasis += cost;
      account.cash -= cost;
      record(ledger, "purchase", -cost, `${instrument.name}${fee ? " including 1% fee" : ""}`);
    } else {
      if (quantity > holding.quantity) throw new Error(`Cannot sell more ${instrument.name} than your current holding.`);
      const proceeds = gross - fee;
      const basisSold = holding.costBasis * (quantity / holding.quantity);
      holding.quantity -= quantity;
      holding.costBasis -= basisSold;
      account.cash += proceeds;
      if (instrument.type === "equity") {
        const referencePrice = priceForTrading(market, instrument, year);
        ledger.realizedEquityGains ||= {};
        ledger.realizedEquityGains[key] = (ledger.realizedEquityGains[key] || 0)
          + quantity * (price - referencePrice) - fee;
      }
      record(ledger, "sale", proceeds, `${instrument.name}${fee ? " net of 1% fee" : ""}`);
    }
    if (holding.quantity > 0) account.holdings[key] = holding;
    else delete account.holdings[key];
  }
  const chosenInsurance = new Set(allocation.insurance || []);
  account.annual[year].insurance = [];
  for (const id of chosenInsurance) {
    const policy = INSURANCE.find((entry) => entry.id === id);
    if (!policy) throw new Error("Choose a valid insurance policy.");
    if (account.cash < policy.premium) throw new Error(`Not enough cash for ${policy.name} insurance.`);
    account.cash -= policy.premium;
    account.annual[year].insurance = [...(account.annual[year].insurance || []), id];
    record(ledger, "insurance", -policy.premium, `${policy.name} insurance premium`);
  }
  ledger.allocation = { ...allocation, submittedAt: new Date().toISOString() };
  return account;
}

function netWorth(account, market) {
  let total = account.cash - account.debt;
  for (const [id, holding] of Object.entries(account.holdings)) {
    total += holding.quantity * priceFor(market, id, 4);
  }
  for (const deposit of account.deposits) {
    if (deposit.matured) continue;
    const yearsToValue = deposit.purchaseYear === 4 || (deposit.purchaseYear === 3 && deposit.term === 2)
      ? deposit.purchaseYear === 3 ? 2 : 1
      : Math.min(4 - deposit.purchaseYear, deposit.term);
    const effectiveRate = deposit.purchaseYear === 4
      ? deposit.term === 1 ? 0.07 : 0.065
      : deposit.rate;
    total += deposit.principal * (1 + effectiveRate) ** yearsToValue;
  }
  return total;
}

function publicState(state, team, market) {
  const account = ensureTeam(state, team);
  if (state.started) beginYear(state, team, market, state.activeYear);
  const ledger = account.annual[state.activeYear] || null;
  const year = state.activeYear;
  const stage = state.activeStage;
  const pricesVisible = stage >= 4 && state.revealedYears.includes(year);
  const revealedEvent = stage >= 5 ? WHEEL_EVENTS.find((event) => event.id === state.eventsByYear[year]) : null;
  const yearPrices = pricesVisible ? {
    equities: Object.fromEntries(Object.entries(market.prices.equities).map(([id, series]) => [id, series[year - 1]])),
    funds: Object.fromEntries(Object.entries(market.prices.funds).map(([id, series]) => [id, series[year - 1]])),
    gold: market.prices.gold[year - 1]
  } : null;
  return {
    started: state.started,
    year,
    stage,
    stageName: OPEN_STAGES[stage - 1],
    current: YEARS[year - 1],
    instruments: INSTRUMENTS,
    tradePrices: Object.fromEntries(INSTRUMENTS.filter((item) => item.type !== "fd")
      .map((item) => [item.id, priceForTrading(market, item, year)])),
    insurance: INSURANCE,
    news: stage >= 2 ? NEWS[year - 1].map((text, index) => ({ number: index + 1, text })) : [],
    market: yearPrices,
    wheelEvent: revealedEvent ? {
      id: revealedEvent.id,
      name: revealedEvent.name,
      amount: revealedEvent.amount,
      description: revealedEvent.id === "earner"
        ? "Next year's salary pauses; term-life cover pays ₹4,80,000 at the start of next year."
        : "The event's household cash impact has been applied to your ledger."
    } : null,
    cash: account.cash,
    debt: account.debt,
    holdings: account.holdings,
    deposits: account.deposits,
    allocation: ledger?.allocation || null,
    ledger: ledger?.entries || [],
    submitted: Boolean(ledger?.allocation),
    status: !state.started ? "waiting" : stage === 3 ? "trading" : "viewing",
    score: state.published ? netWorth(account, market) : null
  };
}

function response(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function bodyJson(request) {
  return new Promise((resolve, reject) => {
    let text = "";
    let size = 0;
    let exceededLimit = false;
    request.on("data", (chunk) => {
      if (exceededLimit) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        exceededLimit = true;
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        return;
      }
      text += chunk;
    });
    request.on("end", () => {
      if (exceededLimit) return;
      try { resolve(JSON.parse(text)); } catch { reject(new Error("Send a valid JSON request.")); }
    });
    request.on("error", reject);
  });
}

async function handle(request, res, pathname, session, registeredTeams = []) {
  if (!pathname.startsWith("/api/bloodlines/")) return false;
  const isPublicScoreboard = pathname === "/api/bloodlines/public-scoreboard" && request.method === "GET";
  if (!session && !isPublicScoreboard) {
    response(res, 401, { error: "Sign in to access Bloodlines." });
    return true;
  }
  let state;
  let market;
  try {
    state = readStore();
    market = readMarket();
  } catch (error) {
    response(res, 503, { error: error.message });
    return true;
  }
  if (isPublicScoreboard) {
    response(res, 200, state.published
      ? {
        published: true,
        teams: Object.values(state.teams).map((account) => ({
          team: account.name,
          score: Math.round(netWorth(account, market) * 100) / 100
        })).sort((a, b) => b.score - a.score)
      }
      : { published: false, yearComplete: Boolean(state.yearComplete), teams: [] });
    return true;
  }
  const teamKey = session.teamKey;
  if (pathname === "/api/bloodlines/state" && request.method === "GET") {
    if (session.role !== "participant") {
      response(res, 403, { error: "Sign in with a team account to access the team dashboard." });
      return true;
    }
    const team = readTeam(teamKey);
    const value = publicState(state, team, market);
    writeStore(state);
    response(res, 200, value);
    return true;
  }
  if (pathname === "/api/bloodlines/allocation" && request.method === "POST") {
    if (session.role !== "participant") {
      response(res, 403, { error: "Only team accounts can submit allocations." });
      return true;
    }
    if (!state.started || state.activeStage !== 3) {
      response(res, 409, { error: "Trading is closed. Allocations can only be submitted during Stage 3." });
      return true;
    }
    try {
      const account = ensureTeam(state, readTeam(teamKey));
      const ledger = account.annual[state.activeYear];
      const allocation = await bodyJson(request);
      if (!allocation || typeof allocation !== "object" || Array.isArray(allocation)
          || !ledger || !Array.isArray(allocation.trades) || allocation.trades.length > 30) {
        response(res, 400, { error: "Submit a valid allocation with at most 30 trade lines." });
        return true;
      }
      applyAllocation(account, ledger, allocation, market, state.activeYear);
      state.teams[teamKey] = account;
      appendAudit(state, session, "allocation_saved", teamKey, { year: state.activeYear });
      writeStore(state);
      response(res, 200, { message: "Allocation saved.", cash: account.cash, submittedAt: ledger.allocation.submittedAt });
    } catch (error) {
      response(res, error.status || 400, { error: error.message });
    }
    return true;
  }
  if (pathname === "/api/bloodlines/scoreboard" && request.method === "GET") {
    if (session.role !== "admin" && !state.published) {
      response(res, 403, { error: "Final results have not been published." });
      return true;
    }
    const teams = Object.entries(state.teams).map(([key, account]) => ({
      team: account.name,
      score: state.published || (session.role === "admin" && state.yearComplete) ? netWorth(account, market) : null,
      year: state.activeYear,
      status: account.annual[state.activeYear]?.allocation ? "submitted" : "pending"
    }));
    response(res, 200, { published: state.published, teams: teams.sort((a, b) => (b.score || 0) - (a.score || 0)) });
    return true;
  }
  if (!pathname.startsWith("/api/bloodlines/admin/") || session.role !== "admin") {
    response(res, 403, { error: "Admin access is required for this Bloodlines action." });
    return true;
  }
  if (pathname === "/api/bloodlines/admin/state" && request.method === "GET") {
    if (!state.started) ensureRegisteredTeams(state, registeredTeams);
    writeStore(state);
    response(res, 200, {
      year: state.activeYear,
      stage: state.activeStage,
      stageName: OPEN_STAGES[state.activeStage - 1],
      started: state.started,
      published: state.published,
      yearComplete: Boolean(state.yearComplete),
      teams: Object.values(state.teams).map((account) => ({
        name: account.name,
        submitted: Boolean(account.annual[state.activeYear]?.allocation),
        cash: account.cash,
        debt: account.debt
      })),
      marketRevealed: state.revealedYears.includes(state.activeYear),
      eventAssigned: Boolean(state.eventsByYear[state.activeYear]),
      wheelEvent: state.activeStage >= 5
        ? WHEEL_EVENTS.find((event) => event.id === state.eventsByYear[state.activeYear])?.name || null
        : null,
      auditLog: state.auditLog.slice(-50)
    });
    return true;
  }
  if (pathname === "/api/bloodlines/admin/advance" && request.method === "POST") {
    try {
      if (!state.started) ensureRegisteredTeams(state, registeredTeams);
      const data = await bodyJson(request);
      advanceState(state, data, session, market);
      writeStore(state);
      response(res, 200, { year: state.activeYear, stage: state.activeStage, stageName: OPEN_STAGES[state.activeStage - 1], published: state.published });
    } catch (error) {
      response(res, 400, { error: error.message });
    }
    return true;
  }
  response(res, 404, { error: "Bloodlines endpoint not found." });
  return true;

  function readTeam(key) {
    const team = registeredTeams.find((item) => item.key === key)
      || { key, name: session.teamName || key };
    return team;
  }
}

function ensureRegisteredTeams(state, teams) {
  for (const team of teams) ensureTeam(state, team);
}

function appendAudit(state, session, action, target, details) {
  state.auditLog.push({ actor: session.role === "admin" ? "admin" : session.teamKey, action, target, details, at: new Date().toISOString() });
}

function advanceState(state, data, session, market) {
  const action = data.action;
  if (action === "start") {
    if (state.started) throw new Error("Bloodlines has already started.");
    if (Object.keys(state.teams).length === 0) throw new Error("Register at least one team before starting Bloodlines.");
    state.started = true;
    state.activeYear = 1;
    state.activeStage = 1;
    state.eventsByYear[1] = WHEEL_EVENTS[crypto.randomInt(WHEEL_EVENTS.length)].id;
    for (const [key, account] of Object.entries(state.teams)) {
      beginYear(state, { key, name: account.name }, market, 1);
    }
  } else if (action === "advance_stage") {
    if (!state.started || state.activeStage >= 5) throw new Error("No next stage is available.");
    if (state.activeStage === 3) {
      for (const account of Object.values(state.teams)) {
        const ledger = account.annual[state.activeYear];
        if (!ledger?.allocation) throw new Error(`Every team must submit before moving to Stage 4: ${account.name} has not submitted.`);
      }
    }
    state.activeStage += 1;
    if (state.activeStage === 4) state.revealedYears.push(state.activeYear);
    if (state.activeStage === 5) applyWheelToTeams(state, market);
  } else if (action === "close_year") {
    if (state.activeStage !== 5) throw new Error("Complete all five stages before closing the year.");
    for (const account of Object.values(state.teams)) {
      const ledger = account.annual[state.activeYear];
      if (ledger) {
        if (state.eventsByYear[state.activeYear] === "earner") {
          account.incomeShock = true;
          account.pendingTermPayout = ledger.insurance?.includes("term") ? 480000 : 0;
        }
        ledger.closed = true;
        ledger.closingCash = account.cash;
        ledger.closingDebt = account.debt;
        ledger.closingHoldings = structuredClone(account.holdings);
        ledger.netWorth = netWorth(account, market);
      }
    }
    if (state.activeYear === 4) {
      state.published = false;
      state.yearComplete = true;
    } else {
      state.activeYear += 1;
      state.activeStage = 1;
      state.eventsByYear[state.activeYear] = WHEEL_EVENTS[crypto.randomInt(WHEEL_EVENTS.length)].id;
      for (const account of Object.values(state.teams)) beginYear(state, { key: Object.keys(state.teams).find((key) => state.teams[key] === account), name: account.name }, market, state.activeYear);
    }
  } else if (action === "publish") {
    if (state.activeYear !== 4 || !state.yearComplete) throw new Error("Complete all four years before publishing scores.");
    state.published = true;
  } else {
    throw new Error("Choose a valid Bloodlines control action.");
  }
  appendAudit(state, session, action, `year-${state.activeYear}`, { stage: state.activeStage });
}

function applyWheelToTeams(state, market) {
  const event = WHEEL_EVENTS.find((item) => item.id === state.eventsByYear[state.activeYear]);
  if (!event) throw new Error("No Wheel event is configured for this year.");
  for (const account of Object.values(state.teams)) {
    const ledger = account.annual[state.activeYear];
    if (!ledger) continue;
    let effect = event.amount;
    if (event.insurance && ledger.insurance?.includes(event.insurance)) effect *= (1 - event.coverage);
    if (event.id === "tax") {
      const hasCurrentFund = Object.keys(account.holdings).some((id) => id.startsWith("fund-"));
      const previous = account.annual[state.activeYear - 1];
      const hadPreviousFund = previous?.closingHoldings
      && Object.keys(previous.closingHoldings).some((id) => id.startsWith("fund-"));
      if (!(hasCurrentFund && hadPreviousFund)) {
      let penalty = 0;
      for (const [id, holding] of Object.entries(account.holdings)) {
        const instrument = INSTRUMENTS.find((item) => item.id === id);
        if (instrument?.type === "equity") {
          const priceChange = priceFor(market, id, state.activeYear) - priceForTrading(market, instrument, state.activeYear);
          const gain = holding.quantity * priceChange + (ledger.realizedEquityGains?.[id] || 0);
          if (gain > 0) penalty += gain * 0.2;
        }
        }
        effect = -penalty;
      }
    }
    if (event.id === "earner") {
      record(ledger, "wheel", 0, "Primary earner loss: next year's salary paused");
      continue;
    }
    account.cash += effect;
    record(ledger, "wheel", effect, `${event.name}${event.insurance ? " (insurance applied if eligible)" : ""}`);
    if (account.cash < 0) {
      account.debt += -account.cash;
      record(ledger, "loan", -account.cash, "Emergency distress loan");
      account.cash = 0;
    }
  }
}

module.exports = {
  handle,
  years: YEARS,
  instruments: INSTRUMENTS,
  insurance: INSURANCE,
  wheelEvents: WHEEL_EVENTS
};
