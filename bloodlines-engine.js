const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const STORE_FILE = process.env.BLOODLINES_STORE_FILE || path.join(ROOT, ".data", "bloodlines.json");
const MARKET_FILE = process.env.BLOODLINES_MARKET_FILE || path.join(ROOT, "data", "bloodlines-test-market.json");
const SCHEMA_VERSION = 2;
const SIMULATION_YEARS = 80;
const SUBROUNDS = 9;
const MAX_BODY_BYTES = 16 * 1024;
const SPIN_DURATION_MS = 3200;
const STAGES = ["allocation", "news", "wheel", "reallocation", "complete"];
const DEFAULT_SCHEDULE = Array.from({ length: SUBROUNDS }, (_, index) => {
  const start = index * 9 + 1;
  return { start, end: index === SUBROUNDS - 1 ? SIMULATION_YEARS : start + 8 };
});

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

function emptyStore(teams = []) {
  return {
    schemaVersion: SCHEMA_VERSION,
    started: false,
    activeSubround: 1,
    activeStage: "allocation",
    currentYear: 1,
    schedule: structuredClone(DEFAULT_SCHEDULE),
    teamOrder: teams.map((team) => team.key),
    teams: Object.fromEntries(teams.map((team) => [team.key, newTeam(team)])),
    returnsBySubround: {},
    newsBySubround: {},
    wheelBySubround: {},
    currentSpin: null,
    published: false,
    completed: false,
    auditLog: []
  };
}

function newTeam(team) {
  return {
    name: team.name,
    cash: 0,
    holdings: {},
    deposits: [],
    debt: 0,
    ledger: [],
    incomeShock: false,
    pendingTermPayout: 0,
    currentInsurance: [],
    nextInsurance: [],
    allocationWindows: {}
  };
}

function readMarket() {
  try {
    const market = JSON.parse(fs.readFileSync(MARKET_FILE, "utf8"));
    if (!market?.prices?.equities || !market?.prices?.funds || !market.prices.gold
        || !market.household || !market.household.salary || !market.household.expenses) {
      throw new Error("Market file must include annual asset prices and household salary/expense schedules.");
    }
    const expandSeries = (series) => {
      if (Array.isArray(series)) {
        if (series.length !== SIMULATION_YEARS || series.some((value) => !Number.isFinite(value) || value <= 0)) {
          throw new Error("Every explicit annual series must contain 80 positive values.");
        }
        return series;
      }
      if (!series || !Number.isFinite(series.start) || series.start <= 0
          || !Number.isFinite(series.annualGrowth) || series.annualGrowth <= -1) {
        throw new Error("Each series must be 80 positive values or a valid { start, annualGrowth } test series.");
      }
      const values = Array.from({ length: SIMULATION_YEARS }, (_, year) => (
        Math.round(series.start * (1 + series.annualGrowth) ** year * 100) / 100
      ));
      if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error("Generated annual series values must remain finite and positive.");
      }
      return values;
    };
    for (const instrument of INSTRUMENTS.filter((item) => ["equity", "fund"].includes(item.type))) {
      const prices = instrument.type === "equity" ? market.prices.equities : market.prices.funds;
      prices[instrument.id] = expandSeries(prices[instrument.id]);
    }
    market.prices.gold = expandSeries(market.prices.gold);
    market.household.salary = expandSeries(market.household.salary);
    market.household.expenses = expandSeries(market.household.expenses);
    if (!Number.isFinite(market.household.startingCash) || market.household.startingCash < 0) {
      throw new Error("household.startingCash must be a non-negative number.");
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
    if (state.schemaVersion !== SCHEMA_VERSION) {
      throw new Error("Saved Bloodlines data uses an older game flow. Back it up and remove BLOODLINES_STORE_FILE to start the nine-subround version.");
    }
    state.returnsBySubround ||= {};
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyStore();
  }
}

function writeStore(state) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, STORE_FILE);
}

function ensureRegisteredTeams(state, teams) {
  const eligibleTeams = teams.map((team) => [
    team.key,
    state.teams[team.key] || newTeam(team)
  ]);
  state.teamOrder = eligibleTeams.map(([key]) => key);
  state.teams = Object.fromEntries(eligibleTeams);
}

function validateSchedule(schedule) {
  if (!Array.isArray(schedule) || schedule.length !== SUBROUNDS) {
    throw new Error(`Configure exactly ${SUBROUNDS} sub-round year ranges.`);
  }
  let nextYear = 1;
  const normalized = schedule.map((range, index) => {
    const start = Number(range?.start);
    const end = Number(range?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start !== nextYear || end < start || end > SIMULATION_YEARS) {
      throw new Error(`Sub-round ${index + 1} must continue the schedule at Year ${nextYear} with a valid end year.`);
    }
    nextYear = end + 1;
    return { start, end };
  });
  if (nextYear !== SIMULATION_YEARS + 1) throw new Error(`The nine sub-rounds must cover Years 1–${SIMULATION_YEARS} without gaps.`);
  return normalized;
}

function validateReturns(returns) {
  if (!returns || typeof returns !== "object" || Array.isArray(returns)) {
    throw new Error("Set an annual return for every investment option.");
  }
  const normalized = {};
  for (const instrument of INSTRUMENTS) {
    const value = Number(returns[instrument.id]);
    if (returns[instrument.id] === undefined || returns[instrument.id] === ""
        || !Number.isFinite(value) || value <= -100 || value > 1000) {
      throw new Error(`${instrument.name} needs a return greater than -100% and no more than 1000%.`);
    }
    normalized[instrument.id] = Math.round(value * 100) / 100;
  }
  return normalized;
}

function hasConfiguredReturns(state, subround = state.activeSubround) {
  const returns = state.returnsBySubround[subround];
  return Boolean(returns && INSTRUMENTS.every((instrument) => Number.isFinite(returns[instrument.id])));
}

function applyConfiguredReturns(market, state) {
  for (const instrument of INSTRUMENTS.filter((item) => item.type !== "fd")) {
    const values = instrument.type === "gold"
      ? market.prices.gold
      : instrument.type === "equity"
        ? market.prices.equities[instrument.id]
        : market.prices.funds[instrument.id];
    let previousPrice = instrument.startPrice;
    for (let year = 1; year <= SIMULATION_YEARS; year += 1) {
      const subround = state.schedule.findIndex((range) => year >= range.start && year <= range.end) + 1;
      const annualReturn = state.returnsBySubround[subround]?.[instrument.id];
      if (Number.isFinite(annualReturn)) {
        previousPrice = Math.max(0.01, Math.round(previousPrice * (1 + annualReturn / 100) * 100) / 100);
        values[year - 1] = previousPrice;
      } else {
        previousPrice = values[year - 1];
      }
    }
  }
}

function priceFor(market, instrumentId, year) {
  if (year <= 0) return INSTRUMENTS.find((instrument) => instrument.id === instrumentId)?.startPrice;
  const values = instrumentId === "gold"
    ? market.prices.gold
    : market.prices.equities[instrumentId] || market.prices.funds[instrumentId];
  if (!values || !Number.isFinite(values[year - 1])) throw new Error(`Missing ${instrumentId} price for Year ${year}.`);
  return values[year - 1];
}

function tradePrice(market, instrument, year) {
  return instrument.type === "fd" ? 1 : priceFor(market, instrument.id, year);
}

function record(account, subround, year, type, amount, description, windowId = null) {
  account.ledger.push({
    subround,
    year,
    type,
    amount: Math.round(amount * 100) / 100,
    description,
    windowId,
    at: new Date().toISOString()
  });
}

function clonePortfolio(account) {
  return {
    cash: account.cash,
    holdings: structuredClone(account.holdings),
    deposits: structuredClone(account.deposits),
    debt: account.debt,
    currentInsurance: [...account.currentInsurance],
    nextInsurance: [...account.nextInsurance]
  };
}

function openAllocationWindow(state, subround, type) {
  for (const key of state.teamOrder) {
    const account = state.teams[key];
    account.allocationWindows[subround] ||= {};
    account.allocationWindows[subround][type] = {
      snapshot: clonePortfolio(account),
      allocation: null,
      id: `${subround}:${type}`
    };
  }
}

function settleShortfall(account, subround, year) {
  if (account.cash >= 0) return;
  const loan = -account.cash;
  account.debt += loan;
  record(account, subround, year, "loan", loan, "Emergency distress loan");
  account.cash = 0;
}

function applyAllocation(state, account, allocation, market, windowType) {
  const subround = state.activeSubround;
  const range = state.schedule[subround - 1];
  const year = windowType === "initial" ? range.start - 1 : range.end;
  const window = account.allocationWindows[subround]?.[windowType];
  if (!window) throw new Error("This allocation window is not open.");
  if (!Array.isArray(allocation.trades) || allocation.trades.length > 30) {
    throw new Error("Submit an allocation with at most 30 trade lines.");
  }
  const saved = window.snapshot;
  account.cash = saved.cash;
  account.holdings = structuredClone(saved.holdings);
  account.deposits = structuredClone(saved.deposits);
  account.debt = saved.debt;
  account.currentInsurance = [...saved.currentInsurance];
  account.nextInsurance = [...saved.nextInsurance];
  account.ledger = account.ledger.filter((entry) => entry.windowId !== window.id);

  for (const item of allocation.trades) {
    const instrument = INSTRUMENTS.find((entry) => entry.id === item.instrument);
    if (!instrument || !["buy", "sell", "hold"].includes(item.action)) {
      throw new Error("Choose a valid instrument and action.");
    }
    if (item.action === "hold") continue;
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Enter a valid quantity for ${instrument.name}.`);
    if (["equity", "gold", "fd"].includes(instrument.type) && !Number.isInteger(quantity)) {
      throw new Error(`${instrument.name} requires a whole-number quantity.`);
    }
    if (instrument.type === "fund" && Math.round(quantity * 100) !== quantity * 100) {
      throw new Error(`${instrument.name} units may have up to two decimal places.`);
    }
    const price = tradePrice(market, instrument, year);
    if (instrument.type === "fd") {
      if (item.action === "buy") {
        if (quantity % 10000 !== 0 || quantity > account.cash) {
          throw new Error(quantity % 10000 !== 0 ? "Fixed deposits must be purchased in ₹10,000 increments." : "Not enough cash for this fixed deposit.");
        }
        const term = instrument.id === "fd-1" ? 1 : 2;
        account.cash -= quantity;
        account.deposits.push({
          principal: quantity,
          rate: (state.returnsBySubround[subround]?.[instrument.id] ?? instrument.rate * 100) / 100,
          term,
          purchaseYear: Math.max(1, year),
          maturityYear: Math.max(1, year) + term,
          matured: false
        });
        record(account, subround, Math.max(1, year), "purchase", -quantity, instrument.name, window.id);
      } else {
        let remaining = quantity;
        if (remaining % 10000 !== 0) throw new Error("Fixed deposit withdrawals must be in ₹10,000 increments.");
        const requiredTerm = instrument.id === "fd-1" ? 1 : 2;
        for (const deposit of account.deposits) {
          if (deposit.term !== requiredTerm || deposit.matured || deposit.maturityYear <= year || remaining <= 0) continue;
          const withdrawn = Math.min(remaining, deposit.principal);
          const elapsed = Math.max(0, year - deposit.purchaseYear);
          const proceeds = withdrawn * ((1 + deposit.rate) ** Math.min(elapsed, deposit.term) - instrument.earlyPenalty);
          deposit.principal -= withdrawn;
          remaining -= withdrawn;
          account.cash += proceeds;
          record(account, subround, year, "sale", proceeds, `${instrument.name} early withdrawal after 2% penalty`, window.id);
        }
        account.deposits = account.deposits.filter((deposit) => deposit.principal > 0);
        if (remaining > 0) throw new Error("Cannot withdraw more than your eligible fixed deposits.");
      }
      continue;
    }
    const gross = quantity * price;
    const fee = instrument.type === "equity" ? gross * 0.01 : 0;
    const holding = account.holdings[instrument.id] || { quantity: 0, costBasis: 0 };
    if (item.action === "buy") {
      const cost = gross + fee;
      if (cost > account.cash) throw new Error(`Not enough cash to buy ${instrument.name}.`);
      holding.quantity += quantity;
      holding.costBasis += cost;
      account.cash -= cost;
      record(account, subround, Math.max(1, year), "purchase", -cost, `${instrument.name}${fee ? " including 1% fee" : ""}`, window.id);
    } else {
      if (quantity > holding.quantity) throw new Error(`Cannot sell more ${instrument.name} than your current holding.`);
      const proceeds = gross - fee;
      const basis = holding.costBasis * (quantity / holding.quantity);
      holding.quantity -= quantity;
      holding.costBasis -= basis;
      account.cash += proceeds;
      record(account, subround, year, "sale", proceeds, `${instrument.name}${fee ? " net of 1% fee" : ""}`, window.id);
    }
    if (holding.quantity > 0) account.holdings[instrument.id] = holding;
    else delete account.holdings[instrument.id];
  }

  if (windowType === "initial" && subround === 1) {
    account.currentInsurance = buyInsurance(account, allocation.insurance || [], subround, year, window.id);
  }
  if (windowType === "reallocation" && subround < SUBROUNDS) {
    account.nextInsurance = buyInsurance(account, allocation.insurance || [], subround, year, window.id);
  }
  settleShortfall(account, subround, year);
  window.allocation = { trades: allocation.trades, insurance: allocation.insurance || [], submittedAt: new Date().toISOString() };
  return window;
}

function buyInsurance(account, chosen, subround, year, windowId) {
  if (!Array.isArray(chosen)) throw new Error("Choose valid insurance policies.");
  const unique = [...new Set(chosen)];
  const policies = unique.map((id) => {
    const policy = INSURANCE.find((entry) => entry.id === id);
    if (!policy) throw new Error("Choose a valid insurance policy.");
    return policy;
  });
  for (const policy of policies) {
    if (policy.premium > account.cash) throw new Error(`Not enough cash for ${policy.name} insurance.`);
    account.cash -= policy.premium;
    record(account, subround, Math.max(1, year), "insurance", -policy.premium, `${policy.name} insurance premium`, windowId);
  }
  return unique;
}

function processYear(state, account, market, year) {
  const subround = state.activeSubround;
  const salary = market.household.salary[year - 1];
  const expenses = market.household.expenses[year - 1];
  if (account.incomeShock) {
    record(account, subround, year, "salary", 0, "Primary earner loss: salary paused");
    account.cash += account.pendingTermPayout;
    if (account.pendingTermPayout) record(account, subround, year, "insurance", account.pendingTermPayout, "Term life payout");
    account.incomeShock = false;
    account.pendingTermPayout = 0;
  } else {
    account.cash += salary;
    record(account, subround, year, "salary", salary, `Year ${year} salary`);
  }
  for (const [id, holding] of Object.entries(account.holdings)) {
    const instrument = INSTRUMENTS.find((entry) => entry.id === id);
    if (instrument?.type === "equity") {
      const dividend = holding.quantity * instrument.dividend;
      account.cash += dividend;
      record(account, subround, year, "dividend", dividend, `${id} dividend`);
    }
  }
  for (const deposit of account.deposits) {
    if (deposit.maturityYear === year && !deposit.matured) {
      const proceeds = deposit.principal * (1 + deposit.rate) ** deposit.term;
      account.cash += proceeds;
      deposit.matured = true;
      record(account, subround, year, "fd_maturity", proceeds, `${deposit.term}-year FD maturity`);
    }
  }
  account.cash -= expenses;
  record(account, subround, year, "expense", -expenses, `Year ${year} household expenses`);
  if (account.debt > 0) {
    const priorDebt = account.debt;
    account.debt *= 1.15;
    record(account, subround, year, "interest", -(account.debt - priorDebt), "Emergency loan interest");
    const repayment = Math.min(account.cash, account.debt);
    if (repayment > 0) {
      account.cash -= repayment;
      account.debt -= repayment;
      record(account, subround, year, "loan_repayment", -repayment, "Emergency loan repayment");
    }
  }
  settleShortfall(account, subround, year);
}

function netWorth(account, market, year = SIMULATION_YEARS) {
  let total = account.cash - account.debt;
  for (const [id, holding] of Object.entries(account.holdings)) {
    total += holding.quantity * priceFor(market, id, year);
  }
  for (const deposit of account.deposits) {
    if (deposit.matured) continue;
    const yearsToValue = Math.min(Math.max(0, year - deposit.purchaseYear), deposit.term);
    total += deposit.principal * (1 + deposit.rate) ** yearsToValue;
  }
  return total;
}

function wheelEntries(state, subround = state.activeSubround) {
  const entries = state.wheelBySubround[subround] || {};
  return state.teamOrder.map((key) => entries[key] || {
    teamKey: key,
    team: state.teams[key].name,
    status: "waiting",
    outcome: null
  });
}

function completeSpin(state, market) {
  const spin = state.currentSpin;
  if (!spin || Date.now() < spin.completesAt) return false;
  const entry = state.wheelBySubround[state.activeSubround][spin.teamKey];
  const event = WHEEL_EVENTS.find((item) => item.id === spin.eventId);
  const account = state.teams[spin.teamKey];
  let effect = event.amount;
  if (event.insurance && account.currentInsurance.includes(event.insurance)) {
    effect *= 1 - event.coverage;
  }
  if (event.id === "earner") {
    account.incomeShock = true;
    account.pendingTermPayout = account.currentInsurance.includes("term") ? event.nextYearPayout : 0;
  } else if (event.id === "tax") {
    const range = state.schedule[state.activeSubround - 1];
    const exempt = Object.keys(account.holdings).some((id) => id.startsWith("fund-"));
    let penalty = 0;
    if (!exempt) {
      for (const [id, holding] of Object.entries(account.holdings)) {
        const instrument = INSTRUMENTS.find((item) => item.id === id);
        if (instrument?.type === "equity") {
          const gain = holding.quantity * (priceFor(market, id, range.end) - priceFor(market, id, Math.max(0, range.start - 1)));
          if (gain > 0) penalty += gain * 0.2;
        }
      }
    }
    effect = -penalty;
  }
  account.cash += effect;
  if (effect) record(account, state.activeSubround, state.schedule[state.activeSubround - 1].end, "wheel", effect, event.name);
  settleShortfall(account, state.activeSubround, state.schedule[state.activeSubround - 1].end);
  entry.status = "done";
  entry.outcome = { id: event.id, name: event.name, effect: Math.round(effect * 100) / 100 };
  entry.completedAt = new Date().toISOString();
  state.currentSpin = null;
  if (wheelEntries(state).every((item) => item.status === "done")) {
    state.activeStage = "reallocation";
    openAllocationWindow(state, state.activeSubround, "reallocation");
  }
  return true;
}

function publicPrices(market, year) {
  return {
    year,
    equities: Object.fromEntries(Object.keys(market.prices.equities).map((id) => [id, priceFor(market, id, year)])),
    funds: Object.fromEntries(Object.keys(market.prices.funds).map((id) => [id, priceFor(market, id, year)])),
    gold: priceFor(market, "gold", year)
  };
}

function publicState(state, teamKey, market) {
  const account = state.teams[teamKey];
  const range = state.schedule[state.activeSubround - 1];
  const windowType = state.activeStage === "reallocation" ? "reallocation" : "initial";
  const allocation = account.allocationWindows[state.activeSubround]?.[windowType]?.allocation || null;
  const released = Object.keys(state.newsBySubround[state.activeSubround] || {}).map(Number);
  const latestReleasedYear = released.length ? Math.max(...released) : 0;
  const priceYear = latestReleasedYear || Math.max(0, range.start - 1);
  const open = state.started && ["allocation", "reallocation"].includes(state.activeStage)
    && (state.activeStage !== "allocation" || hasConfiguredReturns(state));
  return {
    started: state.started,
    subround: state.activeSubround,
    subrounds: SUBROUNDS,
    schedule: state.schedule,
    years: range,
    year: latestReleasedYear || range.start,
    stage: state.activeStage,
    stageName: state.activeStage.replaceAll("_", " "),
    current: latestReleasedYear
      ? { salary: market.household.salary[latestReleasedYear - 1], expenses: market.household.expenses[latestReleasedYear - 1] }
      : { salary: market.household.salary[range.start - 1], expenses: market.household.expenses[range.start - 1] },
    instruments: INSTRUMENTS,
    annualReturns: state.returnsBySubround[state.activeSubround] || {},
    tradePrices: Object.fromEntries(INSTRUMENTS.filter((item) => item.type !== "fd")
      .map((item) => [item.id, tradePrice(market, item, priceYear)])),
    insurance: INSURANCE,
    news: Object.values(state.newsBySubround[state.activeSubround] || {}).sort((a, b) => a.year - b.year),
    market: latestReleasedYear ? publicPrices(market, latestReleasedYear) : null,
    wheel: {
      entries: wheelEntries(state).map(({ teamKey: key, team, status: spinStatus, outcome }) => ({ team: state.teams[key]?.name || team, status: spinStatus, outcome })),
      current: state.currentSpin ? { team: state.teams[state.currentSpin.teamKey].name, startedAt: state.currentSpin.startedAt, completesAt: state.currentSpin.completesAt } : null,
      spinning: Boolean(state.currentSpin)
    },
    cash: account.cash,
    debt: account.debt,
    holdings: account.holdings,
    deposits: account.deposits,
    ledger: account.ledger,
    coverage: account.currentInsurance.map((id) => INSURANCE.find((policy) => policy.id === id)?.name).filter(Boolean),
    allocation,
    submitted: Boolean(allocation),
    status: open ? "trading" : "viewing",
    score: state.published ? netWorth(account, market) : null,
    completed: state.completed,
    visibleYear: latestReleasedYear || range.start
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

function bodyJson(request) {
  return new Promise((resolve, reject) => {
    let text = "";
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
      } else {
        text += chunk;
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(text)); } catch { reject(new Error("Send a valid JSON request.")); }
    });
    request.on("error", reject);
  });
}

function appendAudit(state, session, action, target, details = {}) {
  state.auditLog.push({
    actor: session.role === "admin" ? "admin" : session.teamKey,
    action,
    target,
    details,
    at: new Date().toISOString()
  });
}

function allTeamsSubmitted(state, windowType) {
  return state.teamOrder.every((key) => Boolean(state.teams[key].allocationWindows[state.activeSubround]?.[windowType]?.allocation));
}

function advance(state, data, session, market, registeredTeams) {
  if (data.action === "configure_schedule") {
    if (state.started) throw new Error("Year ranges can only be changed before Bloodlines starts.");
    state.schedule = validateSchedule(data.schedule);
    appendAudit(state, session, data.action, "bloodlines", { schedule: state.schedule });
    return;
  }
  if (data.action === "configure_returns") {
    const hasAllocation = state.teamOrder.some((key) => (
      state.teams[key].allocationWindows[state.activeSubround]?.initial?.allocation
    ));
    if (state.activeStage !== "allocation" || hasAllocation) {
      throw new Error("Investment returns can only be set before the first team submits its allocation.");
    }
    state.returnsBySubround[state.activeSubround] = validateReturns(data.returns);
    appendAudit(state, session, data.action, `subround-${state.activeSubround}`, {
      returns: state.returnsBySubround[state.activeSubround]
    });
    return;
  }
  if (data.action === "start") {
    if (state.started) throw new Error("Bloodlines has already started.");
    if (!hasConfiguredReturns(state, 1)) throw new Error("Set annual returns for all investment options before starting Bloodlines.");
    ensureRegisteredTeams(state, registeredTeams);
    if (!state.teamOrder.length) throw new Error("Register at least one team before starting Bloodlines.");
    state.started = true;
    state.activeSubround = 1;
    state.activeStage = "allocation";
    state.currentYear = state.schedule[0].start;
    for (const key of state.teamOrder) {
      const account = state.teams[key];
      account.cash = market.household.startingCash;
      account.holdings = {};
      account.deposits = [];
      account.debt = 0;
      account.ledger = [];
      account.incomeShock = false;
      account.pendingTermPayout = 0;
      account.currentInsurance = [];
      account.nextInsurance = [];
      account.allocationWindows = {};
      record(account, 1, 0, "opening", account.cash, "Bloodlines starting funds");
    }
    openAllocationWindow(state, 1, "initial");
  } else if (data.action === "begin_news") {
    if (state.activeStage !== "allocation" || !allTeamsSubmitted(state, "initial")) {
      throw new Error("Every team must submit its initial allocation before news begins.");
    }
    state.activeStage = "news";
  } else if (data.action === "release_news") {
    if (state.activeStage !== "news") throw new Error("News can only be released during the news stage.");
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text || text.length > 500) throw new Error("Enter a news flash of 1–500 characters.");
    const effect = typeof data.effect === "string" ? data.effect.trim() : "";
    const affectedInstrumentIds = Array.isArray(data.affectedInstrumentIds)
      ? [...new Set(data.affectedInstrumentIds)]
      : [];
    if (!effect || effect.length > 300) throw new Error("Describe the news effect in 1–300 characters.");
    if (!affectedInstrumentIds.length || affectedInstrumentIds.some((id) => !INSTRUMENTS.some((instrument) => instrument.id === id))) {
      throw new Error("Select at least one affected investment option.");
    }
    const year = state.currentYear;
    if (state.newsBySubround[state.activeSubround]?.[year]) throw new Error(`Year ${year} has already been released.`);
    for (const key of state.teamOrder) processYear(state, state.teams[key], market, year);
    state.newsBySubround[state.activeSubround] ||= {};
    state.newsBySubround[state.activeSubround][year] = {
      year,
      text,
      effect,
      affectedInstrumentIds,
      releasedAt: new Date().toISOString()
    };
    state.currentYear += 1;
  } else if (data.action === "begin_wheel") {
    const range = state.schedule[state.activeSubround - 1];
    if (state.activeStage !== "news" || state.currentYear <= range.end) {
      throw new Error("Release a news flash for every year in this sub-round before spinning.");
    }
    state.activeStage = "wheel";
    state.wheelBySubround[state.activeSubround] = Object.fromEntries(state.teamOrder.map((key) => [key, {
      teamKey: key,
      team: state.teams[key].name,
      status: "waiting",
      outcome: null
    }]));
  } else if (data.action === "spin_next") {
    if (state.activeStage !== "wheel") throw new Error("The Wheel is not active.");
    if (state.currentSpin) throw new Error("Wait for the current team's spin to finish.");
    const entry = wheelEntries(state).find((item) => item.status === "waiting");
    if (!entry) throw new Error("Every team has already spun this sub-round.");
    const event = WHEEL_EVENTS[crypto.randomInt(WHEEL_EVENTS.length)];
    state.currentSpin = {
      teamKey: entry.teamKey,
      eventId: event.id,
      startedAt: Date.now(),
      completesAt: Date.now() + SPIN_DURATION_MS
    };
    entry.status = "spinning";
  } else if (data.action === "close_subround") {
    if (state.activeStage !== "reallocation" || !allTeamsSubmitted(state, "reallocation")) {
      throw new Error("Every team must submit its post-Wheel reallocation before closing the sub-round.");
    }
    const finishedRound = state.activeSubround;
    if (finishedRound === SUBROUNDS) {
      state.activeStage = "complete";
      state.completed = true;
    } else {
      state.activeSubround += 1;
      state.activeStage = "allocation";
      state.currentYear = state.schedule[state.activeSubround - 1].start;
      for (const key of state.teamOrder) {
        const account = state.teams[key];
        account.currentInsurance = [...account.nextInsurance];
        account.nextInsurance = [];
      }
      openAllocationWindow(state, state.activeSubround, "initial");
    }
  } else if (data.action === "publish") {
    if (!state.completed) throw new Error("Complete all nine sub-rounds before publishing final scores.");
    state.published = true;
  } else {
    throw new Error("Choose a valid Bloodlines control action.");
  }
  appendAudit(state, session, data.action, `subround-${state.activeSubround}`, { stage: state.activeStage });
}

async function handle(request, res, pathname, session, registeredTeams = []) {
  if (!pathname.startsWith("/api/bloodlines/")) return false;
  const publicScoreboard = pathname === "/api/bloodlines/public-scoreboard" && request.method === "GET";
  if (!session && !publicScoreboard) {
    sendJson(res, 401, { error: "Sign in to access Bloodlines." });
    return true;
  }
  let state;
  let market;
  try {
    state = readStore();
    market = readMarket();
    applyConfiguredReturns(market, state);
  } catch (error) {
    sendJson(res, 503, { error: error.message });
    return true;
  }
  if (!publicScoreboard && !state.started) {
    ensureRegisteredTeams(state, registeredTeams);
    writeStore(state);
  }
  if (state.currentSpin && completeSpin(state, market)) writeStore(state);
  const eligibleKeys = new Set(registeredTeams.map((team) => team.key));
  if (state.started && !publicScoreboard
      && (state.teamOrder.some((key) => !eligibleKeys.has(key))
        || registeredTeams.some((team) => !state.teams[team.key]))) {
    sendJson(res, 409, { error: "Bloodlines was started with a different team roster. Reset its saved game before starting the qualified roster." });
    return true;
  }
  if (publicScoreboard) {
    const showWheel = ["wheel", "reallocation", "complete"].includes(state.activeStage);
    const result = {
      published: state.published,
      completed: state.completed,
      started: state.started,
      subround: state.activeSubround,
      subrounds: SUBROUNDS,
      years: state.schedule[state.activeSubround - 1],
      stage: state.activeStage,
      wheel: showWheel ? {
        entries: wheelEntries(state).filter(({ teamKey }) => eligibleKeys.has(teamKey))
          .map(({ teamKey, team, status, outcome }) => ({
            team: state.teams[teamKey]?.name || team,
            status,
            outcome
          })),
        current: state.currentSpin && eligibleKeys.has(state.currentSpin.teamKey)
          ? { team: state.teams[state.currentSpin.teamKey].name }
          : null
      } : null,
      teams: state.published
        ? state.teamOrder.filter((key) => eligibleKeys.has(key))
          .map((key) => ({ team: state.teams[key].name, score: Math.round(netWorth(state.teams[key], market) * 100) / 100 }))
          .sort((a, b) => b.score - a.score)
        : []
    };
    sendJson(res, 200, result);
    return true;
  }
  if (pathname === "/api/bloodlines/state" && request.method === "GET") {
    if (session.role !== "participant") {
      sendJson(res, 403, { error: "Sign in with a registered team account to access Bloodlines." });
      return true;
    }
    if (!eligibleKeys.has(session.teamKey)) {
      sendJson(res, 403, { error: "This team was not selected to advance to Bloodlines." });
      return true;
    }
    if (!state.teams[session.teamKey]) {
      sendJson(res, 403, { error: "This team is not registered in the Bloodlines game." });
      return true;
    }
    sendJson(res, 200, publicState(state, session.teamKey, market));
    return true;
  }
  if (pathname === "/api/bloodlines/allocation" && request.method === "POST") {
    if (session.role !== "participant") {
      sendJson(res, 403, { error: "Only registered team accounts can submit allocations." });
      return true;
    }
    if (!eligibleKeys.has(session.teamKey)) {
      sendJson(res, 403, { error: "This team was not selected to advance to Bloodlines." });
      return true;
    }
    if (!state.teams[session.teamKey]) {
      sendJson(res, 403, { error: "This team is not registered in the Bloodlines game." });
      return true;
    }
    const initial = state.activeStage === "allocation";
    const reallocation = state.activeStage === "reallocation";
    if (!state.started || (!initial && !reallocation)) {
      sendJson(res, 409, { error: "Allocation is closed. Submissions are only accepted in the allocation and reallocation windows." });
      return true;
    }
    const hasInitialAllocation = state.teamOrder.some((key) => (
      state.teams[key].allocationWindows[state.activeSubround]?.initial?.allocation
    ));
    if (initial && !hasConfiguredReturns(state) && !hasInitialAllocation) {
      sendJson(res, 409, { error: "The admin must set this sub-round's investment returns before teams can allocate." });
      return true;
    }
    try {
      const data = await bodyJson(request);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Submit a valid allocation.");
      const account = state.teams[session.teamKey];
      applyAllocation(state, account, data, market, reallocation ? "reallocation" : "initial");
      appendAudit(state, session, "allocation_saved", session.teamKey, { subround: state.activeSubround, stage: state.activeStage });
      writeStore(state);
      sendJson(res, 200, { message: "Allocation saved.", cash: account.cash, submittedAt: account.allocationWindows[state.activeSubround][reallocation ? "reallocation" : "initial"].allocation.submittedAt });
    } catch (error) {
      sendJson(res, error.status || 400, { error: error.message });
    }
    return true;
  }
  if (pathname === "/api/bloodlines/scoreboard" && request.method === "GET") {
    if (session.role !== "admin" && !state.published) {
      sendJson(res, 403, { error: "Final results have not been published." });
      return true;
    }
    sendJson(res, 200, {
      published: state.published,
      teams: state.teamOrder.map((key) => ({
        team: state.teams[key].name,
        score: state.published || session.role === "admin" && state.completed ? netWorth(state.teams[key], market) : null,
        subround: state.activeSubround
      })).sort((a, b) => (b.score || 0) - (a.score || 0))
    });
    return true;
  }
  if (!pathname.startsWith("/api/bloodlines/admin/") || session.role !== "admin") {
    sendJson(res, 403, { error: "Admin access is required for this Bloodlines action." });
    return true;
  }
  if (pathname === "/api/bloodlines/admin/state" && request.method === "GET") {
    if (!state.started) ensureRegisteredTeams(state, registeredTeams);
    writeStore(state);
    sendJson(res, 200, {
      started: state.started,
      subround: state.activeSubround,
      subrounds: SUBROUNDS,
      schedule: state.schedule,
      years: state.schedule[state.activeSubround - 1],
      instruments: INSTRUMENTS,
      annualReturns: state.returnsBySubround[state.activeSubround] || null,
      returnsConfigured: hasConfiguredReturns(state),
      returnsLocked: state.activeStage !== "allocation" || state.teamOrder.some((key) => (
        state.teams[key].allocationWindows[state.activeSubround]?.initial?.allocation
      )),
      year: state.currentYear,
      stage: state.activeStage,
      stageName: state.activeStage,
      completed: state.completed,
      published: state.published,
      news: Object.values(state.newsBySubround[state.activeSubround] || {}).sort((a, b) => a.year - b.year),
      newsRemaining: Math.max(0, state.schedule[state.activeSubround - 1].end - state.currentYear + 1),
      teams: state.teamOrder.map((key) => {
        const account = state.teams[key];
        return {
          name: account.name,
          cash: account.cash,
          debt: account.debt,
          submitted: Boolean(account.allocationWindows[state.activeSubround]?.[
            state.activeStage === "reallocation" ? "reallocation" : "initial"
          ]?.allocation),
          reallocated: Boolean(account.allocationWindows[state.activeSubround]?.reallocation?.allocation)
        };
      }),
      wheel: { entries: wheelEntries(state), current: state.currentSpin ? { team: state.teams[state.currentSpin.teamKey].name, startedAt: state.currentSpin.startedAt, completesAt: state.currentSpin.completesAt } : null },
      auditLog: state.auditLog.slice(-50)
    });
    return true;
  }
  if (pathname === "/api/bloodlines/admin/advance" && request.method === "POST") {
    try {
      if (!state.started) ensureRegisteredTeams(state, registeredTeams);
      const data = await bodyJson(request);
      advance(state, data, session, market, registeredTeams);
      writeStore(state);
      sendJson(res, 200, { subround: state.activeSubround, stage: state.activeStage, completed: state.completed, published: state.published });
    } catch (error) {
      sendJson(res, error.status || 400, { error: error.message });
    }
    return true;
  }
  sendJson(res, 404, { error: "Bloodlines endpoint not found." });
  return true;
}

module.exports = {
  handle,
  instruments: INSTRUMENTS,
  insurance: INSURANCE,
  wheelEvents: WHEEL_EVENTS,
  defaultSchedule: DEFAULT_SCHEDULE
};
