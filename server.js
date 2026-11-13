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
const BANKING_BOND_RATE = 0.04;
const BANKING_DECADE_YEARS = 10;
const MAX_ACTIVE_LOANS = 2;
const MAX_LENDING_RATIO = 0.15;
const LOAN_REQUEST_WINDOW_MS = 60 * 1000;
const MAX_RECEIVED_LOAN_REQUESTS = 5;
const companies = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
const sessions = new Map();
const loginAttempts = new Map();
const loanRequestTimes = new Map();
const receivedLoanRequestTimes = new Map();

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
    if (!/^[\p{L}\p{N}][\p{L}\p{N} '&.,-]{1,34}$/u.test(name)) {
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
        roundOneCloseout: null,
        banking: null,
        loans: []
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
    roundOneCloseout: stored.roundOneCloseout && typeof stored.roundOneCloseout === "object"
      ? stored.roundOneCloseout
      : null,
    banking: stored.banking && typeof stored.banking === "object" ? stored.banking : null,
    loans: Array.isArray(stored.loans) ? stored.loans : []
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

function activeLoansFor(store, teamKey) {
  return store.loans.filter((loan) => loan.status === "active"
    && (loan.borrowerKey === teamKey || loan.lenderKey === teamKey));
}

function remainingScheduledLoanValue(loan) {
  let outstandingPrincipal = loan.outstandingPrincipal;
  const remainingInstallments = Math.max(0, loan.termYears - (loan.paidInstallments || 0));
  let total = 0;
  for (let index = 0; index < remainingInstallments; index += 1) {
    const interest = loan.interestType === "simple"
      ? Math.round(loan.principal * loan.ratePercent / 100)
      : Math.round(outstandingPrincipal * loan.ratePercent / 100);
    const scheduledPayment = loan.interestType === "simple"
      ? Math.round(loan.principal / loan.termYears) + interest
      : loan.annualPayment;
    const principalDue = Math.min(outstandingPrincipal, scheduledPayment - interest);
    total += interest + principalDue;
    outstandingPrincipal -= principalDue;
  }
  return total;
}

function roundOnePerformance(store) {
  const teams = new Map(store.teams.map((team) => {
    const account = store.banking.accounts[team.key];
    if (!account) throw new Error(`The Round 1 cash account for ${team.name} is missing.`);
    return [team.key, {
      teamKey: team.key,
      team: team.name,
      cash: account.balance,
      projectedCredits: 0,
      projectedDebts: 0
    }];
  }));
  for (const loan of store.loans) {
    if (loan.status !== "active") continue;
    const borrower = teams.get(loan.borrowerKey);
    const lender = teams.get(loan.lenderKey);
    if (!borrower || !lender) {
      throw new Error(`Active loan ${loan.id} refers to a team that is no longer registered.`);
    }
    const remaining = remainingScheduledLoanValue(loan);
    borrower.projectedDebts += remaining;
    lender.projectedCredits += remaining;
  }
  return [...teams.values()]
    .map((team) => ({
      ...team,
      projectedNet: team.cash + team.projectedCredits - team.projectedDebts
    }))
    .sort((a, b) => b.projectedNet - a.projectedNet
      || b.cash - a.cash
      || a.team.localeCompare(b.team));
}

function roundOneCloseoutError(store, allowEarlyClose = false) {
  if (!allowEarlyClose && !store.banking.complete) return "Complete all Round 1 eras and decade settlements first.";
  if (store.auction.status === "open") return "Close the active company auction before ending Round 1.";
  if (store.teams.length === 0) return "Register at least one team before ending Round 1.";
  if (!allowEarlyClose && store.teams.some((team) => (store.banking.accounts[team.key]?.portfolio || []).length > 0)) {
    return "Settle all Round 1 company positions before ending the round.";
  }
  return null;
}

function outstandingLendingFor(store, teamKey) {
  return store.loans.reduce((sum, loan) => {
    if (loan.status !== "active" || loan.lenderKey !== teamKey) return sum;
    return sum + loan.outstandingPrincipal;
  }, 0);
}

function recentRequestCount(limits, teamKey, now = Date.now()) {
  const recent = (limits.get(teamKey) || []).filter((timestamp) => now - timestamp < LOAN_REQUEST_WINDOW_MS);
  if (recent.length) limits.set(teamKey, recent);
  else limits.delete(teamKey);
  return recent.length;
}

function recordLoanRequest(limits, teamKey, now = Date.now()) {
  const recent = (limits.get(teamKey) || []).filter((timestamp) => now - timestamp < LOAN_REQUEST_WINDOW_MS);
  recent.push(now);
  limits.set(teamKey, recent);
}

function loanHasCounterpartyConflict(store, borrowerKey, lenderKey) {
  return store.loans.some((loan) => loan.status === "active"
    && loan.borrowerKey === lenderKey && loan.lenderKey === borrowerKey);
}

function sanitizeLoan(loan, viewerKey) {
  return {
    id: loan.id,
    borrower: loan.borrowerName,
    lender: loan.lenderName,
    principal: loan.principal,
    ratePercent: loan.ratePercent,
    interestType: loan.interestType,
    termYears: loan.termYears,
    comments: loan.comments,
    lenderDecision: loan.lenderDecision,
    adminDecision: loan.adminDecision,
    status: loan.status,
    createdAt: loan.createdAt,
    approvedAt: loan.approvedAt || null,
    paidInstallments: loan.paidInstallments || 0,
    annualPayment: loan.status === "active" ? loan.annualPayment : null,
    outstandingPrincipal: loan.status === "active" ? loan.outstandingPrincipal : 0,
    defaultAmount: loan.defaultAmount || 0,
    lastDecision: viewerKey === loan.borrowerKey
      ? loan.lenderDecision || loan.adminDecision
      : loan.adminDecision || loan.lenderDecision,
    payments: viewerKey === "admin" || viewerKey === loan.borrowerKey || viewerKey === loan.lenderKey
      ? (loan.payments || []).map((payment) => ({
        installment: payment.installment,
        due: payment.due,
        paid: payment.paid,
        interest: payment.interest,
        principal: payment.principal,
        unpaid: payment.unpaid,
        era: payment.era,
        decade: payment.decade,
        paidAt: payment.paidAt
      }))
      : []
  };
}

function processLoanCheckpoint(store, era, decade) {
  const payments = [];
  for (const loan of store.loans) {
    if (loan.status !== "active") continue;
    const borrower = store.banking.accounts[loan.borrowerKey];
    const lender = store.banking.accounts[loan.lenderKey];
    if (!borrower || !lender) {
      throw new Error(`Loan ${loan.id} refers to an account that no longer exists.`);
    }

    const installmentsThisCheckpoint = Math.min(
      BANKING_DECADE_YEARS,
      loan.termYears - loan.paidInstallments
    );
    let remainingCashToPay = borrower.balance;
    let totalPaid = 0;
    let totalInterest = 0;
    let totalPrincipal = 0;
    let defaulted = false;

    for (let index = 0; index < installmentsThisCheckpoint; index += 1) {
      const installmentNumber = loan.paidInstallments + 1;
      const interest = loan.interestType === "simple"
        ? Math.round(loan.principal * loan.ratePercent / 100)
        : Math.round(loan.outstandingPrincipal * loan.ratePercent / 100);
      const scheduledPayment = loan.interestType === "simple"
        ? Math.round(loan.principal / loan.termYears) + interest
        : loan.annualPayment;
      const principalDue = Math.min(loan.outstandingPrincipal, scheduledPayment - interest);
      const due = interest + principalDue;
      if (remainingCashToPay < due) {
        const paid = Math.max(0, remainingCashToPay);
        const interestPaid = Math.min(interest, paid);
        const principalPaid = Math.min(principalDue, paid - interestPaid);
        loan.outstandingPrincipal -= principalPaid;
        loan.paidInstallments += 1;
        totalPaid += paid;
        totalInterest += interestPaid;
        totalPrincipal += principalPaid;
        remainingCashToPay = 0;
        loan.defaultAmount = interest - interestPaid + loan.outstandingPrincipal;
        loan.status = "defaulted";
        defaulted = true;
        loan.payments.push({
          installment: installmentNumber,
          due,
          paid,
          interest: interestPaid,
          principal: principalPaid,
          unpaid: loan.defaultAmount,
          era,
          decade,
          paidAt: new Date().toISOString()
        });
        break;
      }

      remainingCashToPay -= due;
      totalPaid += due;
      totalInterest += interest;
      totalPrincipal += principalDue;
      loan.outstandingPrincipal -= principalDue;
      loan.paidInstallments += 1;
      loan.payments.push({
        installment: installmentNumber,
        due,
        paid: due,
        interest,
        principal: principalDue,
        unpaid: 0,
        era,
        decade,
        paidAt: new Date().toISOString()
      });
    }

    borrower.balance -= totalPaid;
    lender.balance += totalPaid;
    if (totalPaid) {
      borrower.ledger.push({ type: "loan-payment", loanId: loan.id, amount: -totalPaid, at: new Date().toISOString() });
      lender.ledger.push({ type: "loan-repayment", loanId: loan.id, amount: totalPaid, at: new Date().toISOString() });
    }
    if (loan.status === "active" && loan.paidInstallments >= loan.termYears) {
      loan.status = "repaid";
      loan.closedAt = new Date().toISOString();
    }
    if (defaulted) loan.closedAt = new Date().toISOString();
    if (totalPaid || defaulted) {
      payments.push({
        loanId: loan.id,
        borrowerName: loan.borrowerName,
        lenderName: loan.lenderName,
        installmentsPaid: loan.paidInstallments,
        totalPaid,
        interestPaid: totalInterest,
        principalPaid: totalPrincipal,
        defaultAmount: loan.defaultAmount || 0,
        status: loan.status
      });
    }
  }
  return payments;
}

function createLoanRequest(store, borrowerKey, body) {
  const borrower = store.teams.find((team) => team.key === borrowerKey);
  const lenderKey = typeof body.lenderKey === "string" ? body.lenderKey : "";
  const lender = store.teams.find((team) => team.key === lenderKey);
  const principal = Number(body.principal);
  const ratePercent = Number(body.ratePercent);
  const termYears = Number(body.termYears);
  const interestType = body.interestType;
  const comments = typeof body.comments === "string" ? body.comments.trim() : "";
  if (!borrower || !lender || borrower.key === lender.key) {
    throw Object.assign(new Error("Choose another registered team as the lender."), { status: 400 });
  }
  if (!Number.isSafeInteger(principal) || principal <= 0) {
    throw Object.assign(new Error("Enter a positive whole-number loan amount."), { status: 400 });
  }
  if (!Number.isFinite(ratePercent) || ratePercent < 7 || ratePercent > 20
      || Math.round(ratePercent * 100) !== ratePercent * 100) {
    throw Object.assign(new Error("Choose an annual interest rate from 7% to 20%, up to two decimal places."), { status: 400 });
  }
  if (!Number.isInteger(termYears) || termYears < 1 || termYears >= 20) {
    throw Object.assign(new Error("Choose a loan term from 1 to 19 years."), { status: 400 });
  }
  if (interestType !== "simple" && interestType !== "compound") {
    throw Object.assign(new Error("Choose simple or compound interest."), { status: 400 });
  }
  if (comments.length > 500) {
    throw Object.assign(new Error("Loan comments must be 500 characters or fewer."), { status: 400 });
  }
  if (loanHasCounterpartyConflict(store, borrower.key, lender.key)) {
    throw Object.assign(new Error("You cannot request a loan from a team that currently borrows from you."), { status: 409 });
  }

  const lenderAccount = store.banking.accounts[lender.key];
  if (!lenderAccount || principal > lenderAccount.balance
      || outstandingLendingFor(store, lender.key) + principal > lenderAccount.balance * MAX_LENDING_RATIO) {
    throw Object.assign(new Error("The requested amount exceeds this team's current lending capacity."), { status: 409 });
  }

  return {
    id: crypto.randomUUID(),
    borrowerKey: borrower.key,
    borrowerName: borrower.name,
    lenderKey: lender.key,
    lenderName: lender.name,
    principal,
    ratePercent,
    interestType,
    termYears,
    comments,
    lenderDecision: null,
    adminDecision: null,
    status: "pending_lender",
    createdAt: new Date().toISOString(),
    approvedAt: null,
    approvedEra: null,
    approvedDecade: null,
    paidInstallments: 0,
    outstandingPrincipal: principal,
    annualPayment: null,
    defaultAmount: 0,
    payments: []
  };
}

function addLoanDecision(loan, actor, decision, comments) {
  const normalized = typeof comments === "string" ? comments.trim() : "";
  if (normalized.length > 500) {
    throw Object.assign(new Error("Decision comments must be 500 characters or fewer."), { status: 400 });
  }
  if (decision === "rejected" && !normalized) {
    throw Object.assign(new Error("Add a comment explaining why the loan was rejected."), { status: 400 });
  }
  const record = {
    decision,
    comments: normalized,
    at: new Date().toISOString()
  };
  if (actor === "lender") loan.lenderDecision = record;
  else loan.adminDecision = record;
  return record;
}

function loanApprovalError(store, loan) {
  const borrower = store.banking.accounts[loan.borrowerKey];
  const lender = store.banking.accounts[loan.lenderKey];
  if (!borrower || !lender) return "A loan participant account is unavailable.";
  if (store.activeRound !== 1 || !currentBankingGroup(store)?.group) {
    return "An accepted loan can be approved only during an active Round 1 decade.";
  }
  if (activeLoansFor(store, loan.borrowerKey).length >= MAX_ACTIVE_LOANS
      || activeLoansFor(store, loan.lenderKey).length >= MAX_ACTIVE_LOANS) {
    return "Approval would exceed the two-active-loan limit for one of the teams.";
  }
  if (loanHasCounterpartyConflict(store, loan.borrowerKey, loan.lenderKey)) {
    return "These teams already have an active loan in the reverse direction.";
  }
  if (loan.principal > lender.balance
      || outstandingLendingFor(store, loan.lenderKey) + loan.principal > lender.balance * MAX_LENDING_RATIO) {
    return "The lender no longer has enough cash or lending capacity for this loan.";
  }
  return null;
}

function approveLoan(store, loan) {
  const error = loanApprovalError(store, loan);
  if (error) throw Object.assign(new Error(error), { status: 409 });
  const current = currentBankingGroup(store);
  const borrower = store.banking.accounts[loan.borrowerKey];
  const lender = store.banking.accounts[loan.lenderKey];
  const rate = loan.ratePercent / 100;
  loan.annualPayment = loan.interestType === "compound"
    ? Math.round(loan.principal * rate / (1 - (1 + rate) ** -loan.termYears))
    : Math.round(loan.principal / loan.termYears + loan.principal * rate);
  loan.approvedAt = new Date().toISOString();
  loan.approvedEra = current.era;
  loan.approvedDecade = current.group.decade;
  loan.status = "active";
  lender.balance -= loan.principal;
  borrower.balance += loan.principal;
  lender.ledger.push({ type: "loan-issued", loanId: loan.id, amount: -loan.principal, at: loan.approvedAt });
  borrower.ledger.push({ type: "loan-funded", loanId: loan.id, amount: loan.principal, at: loan.approvedAt });
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
    ledger: account.ledger.slice(-50).reverse().map(({ type, era, decade, companyId, loanId, amount, npi }) => ({
      type, era, decade, companyId, loanId, amount, npi
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
    loanPayments: processLoanCheckpoint(store, current.era, decade),
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
    if (body.round === 2 && !store.roundOneCloseout?.qualifierKeys?.length) {
      return sendError(response, 409, "End Round 1 and lock at least one qualifying team before starting Bloodlines.");
    }
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
  if (pathname === "/api/loans" && request.method === "GET") {
    const session = requireRole(request, response, "participant");
    if (!session) return;
    const store = readStore();
    const account = store.banking.accounts[session.teamKey];
    return sendJson(response, 200, {
      loans: store.loans
        .filter((loan) => loan.borrowerKey === session.teamKey || loan.lenderKey === session.teamKey)
        .map((loan) => sanitizeLoan(loan, session.teamKey))
        .reverse(),
      counterparties: store.teams
        .filter((team) => team.key !== session.teamKey)
        .map((team) => ({ key: team.key, name: team.name })),
      lendingCapacity: Math.max(
        0,
        Math.floor(account.balance * MAX_LENDING_RATIO) - outstandingLendingFor(store, session.teamKey)
      ),
      activeLoanCount: activeLoansFor(store, session.teamKey).length,
      rules: {
        minimumRatePercent: 7,
        maximumRatePercent: 20,
        minimumTermYears: 1,
        maximumTermYears: 19,
        maximumActiveLoans: MAX_ACTIVE_LOANS,
        requestCooldownSeconds: 60,
        maximumReceivedRequestsPerMinute: MAX_RECEIVED_LOAN_REQUESTS
      }
    });
  }
  if (pathname === "/api/loans/requests" && request.method === "POST") {
    const session = requireRole(request, response, "participant");
    if (!session) return;
    const store = readStore();
    if (store.activeRound !== 1 || bankingSetupErrors().length || !currentBankingGroup(store)?.group) {
      return sendError(response, 409, "Inter-team loans are available only during an active, configured Round 1.");
    }
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(response, 400, "Submit a valid loan request.");
    }
    const lenderKey = typeof body.lenderKey === "string" ? body.lenderKey : "";
    const now = Date.now();
    if (recentRequestCount(loanRequestTimes, session.teamKey, now) >= 1) {
      return sendError(response, 429, "You can create one loan request per minute.");
    }
    if (recentRequestCount(receivedLoanRequestTimes, lenderKey, now) >= MAX_RECEIVED_LOAN_REQUESTS) {
      return sendError(response, 429, "This team has already received five loan requests in the last minute.");
    }
    let loan;
    try {
      loan = createLoanRequest(store, session.teamKey, body);
    } catch (error) {
      return sendError(response, error.status || 400, error.message);
    }
    store.loans.push(loan);
    recordLoanRequest(loanRequestTimes, session.teamKey, now);
    recordLoanRequest(receivedLoanRequestTimes, lenderKey, now);
    writeStore(store);
    return sendJson(response, 201, { loan: sanitizeLoan(loan, session.teamKey) });
  }
  const lenderDecisionMatch = pathname.match(/^\/api\/loans\/([^/]+)\/lender-decision$/);
  if (lenderDecisionMatch && request.method === "POST") {
    const session = requireRole(request, response, "participant");
    if (!session) return;
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(response, 400, "Submit a valid lender decision.");
    }
    const store = readStore();
    const loan = store.loans.find((item) => item.id === lenderDecisionMatch[1]);
    if (!loan || loan.lenderKey !== session.teamKey) {
      return sendError(response, 404, "That incoming loan request was not found.");
    }
    if (loan.status !== "pending_lender") {
      return sendError(response, 409, "This loan request is no longer awaiting your decision.");
    }
    if (body.decision !== "accepted" && body.decision !== "rejected") {
      return sendError(response, 400, "Choose whether to accept or reject the request.");
    }
    try {
      addLoanDecision(loan, "lender", body.decision, body.comments);
    } catch (error) {
      return sendError(response, error.status || 400, error.message);
    }
    loan.status = body.decision === "accepted" ? "pending_admin" : "rejected_by_lender";
    writeStore(store);
    return sendJson(response, 200, { loan: sanitizeLoan(loan, session.teamKey) });
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

    if (request.method === "GET" && pathname === "/api/admin/round-one/qualification") {
      const store = readStore();
      const reason = roundOneCloseoutError(store);
      const closeout = store.roundOneCloseout;
      return sendJson(response, 200, {
        available: Boolean(closeout) || !reason,
        canClose: !closeout,
        reason: closeout ? null : reason,
        locked: Boolean(closeout),
        closedAt: closeout?.closedAt || null,
        qualifierKeys: closeout?.qualifierKeys || [],
        rankings: closeout?.rankings || (reason ? [] : roundOnePerformance(store))
      });
    }

    if (request.method === "POST" && pathname === "/api/admin/round-one/close") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)
          || !Array.isArray(body.qualifierKeys)) {
        return sendError(response, 400, "Select at least one team to qualify for Bloodlines.");
      }
      const forceEarlyClose = body.forceEarlyClose === true;
      const store = readStore();
      const reason = roundOneCloseoutError(store, forceEarlyClose);
      if (reason) return sendError(response, 409, reason);
      if (store.roundOneCloseout) {
        return sendError(response, 409, "Round 1 has already been closed and its qualifier list is locked.");
      }
      if (store.activeRound !== 1) {
        return sendError(response, 409, "Switch back to Round 1 before closing it.");
      }
      const uniqueKeys = new Set(body.qualifierKeys);
      if (uniqueKeys.size !== body.qualifierKeys.length || uniqueKeys.size === 0
          || [...uniqueKeys].some((key) => typeof key !== "string"
            || !store.teams.some((team) => team.key === key))) {
        return sendError(response, 400, "Choose one or more registered teams from the performance list.");
      }
      const rankings = roundOnePerformance(store);
      const selectedKeys = rankings
        .filter((team) => uniqueKeys.has(team.teamKey))
        .map((team) => team.teamKey);
      const closedAt = new Date().toISOString();
      for (const loan of store.loans) {
        if (loan.status === "pending_lender" || loan.status === "pending_admin") {
          loan.status = "expired_at_round_end";
          loan.closedAt = closedAt;
        }
      }
      if (forceEarlyClose) {
        store.banking.complete = true;
        store.banking.activeEraIndex = companyEraOrder().length;
        store.banking.decadeIndex = 0;
        store.auction = { status: "waiting", era: null, companyId: null };
      }
      store.roundOneCloseout = {
        closedAt,
        qualifierKeys: selectedKeys,
        rankings
      };
      writeStore(store);
      return sendJson(response, 200, {
        locked: true,
        closedAt: store.roundOneCloseout.closedAt,
        qualifierKeys: selectedKeys,
        rankings,
        earlyClose: forceEarlyClose
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

    if (request.method === "GET" && pathname === "/api/admin/loans") {
      const store = readStore();
      return sendJson(response, 200, {
        loans: store.loans.map((loan) => sanitizeLoan(loan, "admin")).reverse(),
        teams: store.teams.map((team) => ({
          name: team.name,
          activeLoanCount: activeLoansFor(store, team.key).length,
          cash: store.banking.accounts[team.key]?.balance ?? VAULT_CAPITAL,
          lendingCapacity: Math.max(
            0,
            Math.floor((store.banking.accounts[team.key]?.balance ?? VAULT_CAPITAL) * MAX_LENDING_RATIO)
              - outstandingLendingFor(store, team.key)
          )
        }))
      });
    }

    const adminLoanDecisionMatch = pathname.match(/^\/api\/admin\/loans\/([^/]+)\/decision$/);
    if (adminLoanDecisionMatch && request.method === "POST") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendError(response, 400, "Submit a valid admin decision.");
      }
      const store = readStore();
      const loan = store.loans.find((item) => item.id === adminLoanDecisionMatch[1]);
      if (!loan || loan.status !== "pending_admin") {
        return sendError(response, 404, "That lender-accepted loan request is not awaiting admin review.");
      }
      if (body.decision !== "approved" && body.decision !== "rejected") {
        return sendError(response, 400, "Choose whether to approve or reject the loan.");
      }
      try {
        addLoanDecision(loan, "admin", body.decision, body.comments);
        if (body.decision === "approved") approveLoan(store, loan);
        else loan.status = "rejected_by_admin";
      } catch (error) {
        return sendError(response, error.status || 400, error.message);
      }
      writeStore(store);
      return sendJson(response, 200, { loan: sanitizeLoan(loan, "admin") });
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
      if (!/^[\p{L}\p{N}][\p{L}\p{N} '&.,-]{1,34}$/u.test(name)) {
        return sendError(response, 400, "Enter a team name between 2 and 35 characters.");
      }
      const store = readStore();
      if (store.roundOneCloseout) {
        return sendError(response, 409, "Team registration is closed because the Round 1 qualifier list is locked.");
      }
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
    const publicScoreboard = pathname === "/api/bloodlines/public-scoreboard"
      && request.method === "GET";
    if (!publicScoreboard && store.activeRound !== 2) {
      return sendError(response, 409, "Bloodlines is not active. The admin must close Round 1 and select Round 2.");
    }
    if (!publicScoreboard && !store.roundOneCloseout?.qualifierKeys?.length) {
      return sendError(response, 409, "Round 1 qualifiers have not been selected.");
    }
    const qualifierKeys = new Set(store.roundOneCloseout?.qualifierKeys || []);
    const eligibleTeams = store.teams.filter((team) => qualifierKeys.has(team.key));
    return bloodlines.handle(request, response, pathname, session, eligibleTeams);
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
