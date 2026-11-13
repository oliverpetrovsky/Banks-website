const teamState = {
  data: null,
  team: null,
  auction: null,
  companyId: null,
  poll: null,
  editingOffer: false,
  previewTimer: null,
  previewRequestId: 0,
  bloodlinesState: null,
  loanCommentDrafts: new Map()
};

const formatRupees = (amount) => `₹${Number(amount).toLocaleString("en-IN")}`;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The request could not be completed.");
  return body;
}

function toast(message) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.classList.add("is-visible");
  setTimeout(() => element.classList.remove("is-visible"), 3200);
}

function formMessage(form, message, error = false) {
  const output = form.querySelector(".form-message");
  output.textContent = message;
  output.classList.toggle("is-error", error);
}

function bvi(principal, rate, company) {
  if (!company || !Number.isFinite(principal) || !Number.isFinite(rate)
      || principal < company.minimumPrincipal || principal > teamState.data.rules.singleBidLimit
      || principal % 10000 !== 0 || rate < 0 || rate > company.maximumRate
      || Math.round(rate * 100) % 50 !== 0) return null;
  return (principal / company.principalRequired) * ((company.maximumRate - rate) / company.maximumRate);
}

function showWonBids(results) {
  const section = document.querySelector("#team-results-section");
  const container = document.querySelector("#team-results");
  container.replaceChildren();
  section.hidden = results.length === 0;
  results.forEach((result) => {
    const card = document.createElement("article");
    card.className = "win-card";
    const era = document.createElement("span");
    era.className = "result-era";
    era.textContent = `${result.company.eraName} · ${result.company.id}`;
    const company = document.createElement("h3");
    company.textContent = result.company.name;
    const bid = document.createElement("span");
    bid.className = "win-bid";
    bid.textContent = `WINNING BID · ${formatRupees(result.bid.principal)} · ${result.bid.ratePercent}% · BVI ${result.bid.bvi.toFixed(4)}`;
    const briefing = document.createElement("p");
    briefing.textContent = result.briefing || "The event team has not added the winner briefing for this company yet.";
    card.append(era, company, bid, briefing);
    container.append(card);
  });
}

function renderBankingAccount(banking) {
  const section = document.querySelector("#banking-account");
  const period = document.querySelector("#banking-account-period");
  const balance = document.querySelector("#banking-account-balance");
  const portfolio = document.querySelector("#banking-account-portfolio");
  const ledger = document.querySelector("#banking-account-ledger");
  if (!banking) return;
  const settlementNote = document.querySelector("#banking-settlement-note");
  if (settlementNote) {
    settlementNote.textContent = "Settlements occur at the end of each decade and again at the end of each era.";
  }
  period.textContent = banking.current
    ? `${banking.current.eraName} · ${banking.current.decade || "Era settlement"} · decade ${banking.current.decadeIndex}/${banking.current.decadeCount}`
    : "All eras complete";
  balance.textContent = formatRupees(banking.balance);
  const positions = [
    ...(banking.portfolio || []).map((position) => ({ ...position, archived: false })),
    ...(banking.history || []).map((position) => ({ ...position, archived: true }))
  ];
  if (!positions.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No company positions yet. Uninvested cash compounds at 4% annually.";
    portfolio.replaceChildren(empty);
  } else {
    portfolio.replaceChildren(...positions.slice(-12).reverse().map((position) => {
      const row = document.createElement("article");
      const name = document.createElement("strong");
      name.textContent = position.companyName;
      const detail = document.createElement("span");
      detail.textContent = position.npi === null
        ? `${position.decade} · INVESTED ${formatRupees(position.principal)} · awaiting decade result`
        : `${position.decade} · NPI ${Number(position.npi).toFixed(2)} · interest ${formatRupees(position.interestPaid)}${position.archived ? ` · era-end principal ${formatRupees(position.principalReturned)}` : ""}`;
      row.append(name, detail);
      return row;
    }));
  }
  ledger.replaceChildren(...(banking.ledger || []).slice(0, 10).map((entry) => {
    const item = document.createElement("li");
    const amount = entry.amount >= 0 ? `+${formatRupees(entry.amount)}` : formatRupees(entry.amount);
    const source = entry.type === "bond"
      ? `4% bond growth · ${entry.decade}`
      : entry.type === "company-interest"
        ? `Company interest · ${entry.companyId}`
        : entry.type === "loan-funded"
          ? `Loan funded · ${entry.loanId}`
          : entry.type === "loan-issued"
            ? `Loan issued · ${entry.loanId}`
            : entry.type === "loan-payment"
              ? `Loan payment · ${entry.loanId}`
              : entry.type === "loan-repayment"
                ? `Loan repayment received · ${entry.loanId}`
                : `Principal return · ${entry.companyId}`;
    item.textContent = `${source} · ${amount}`;
    return item;
  }));
  section.hidden = document.body.dataset.round === "2";
}

function renderTeamLoans(data) {
  const section = document.querySelector("#inter-team-loans");
  const lenderSelect = document.querySelector("#loan-request-form select[name=lenderKey]");
  const selectedLender = lenderSelect.value;
  lenderSelect.replaceChildren(...data.counterparties.map((team) => {
    const option = document.createElement("option");
    option.value = team.key;
    option.textContent = team.name;
    return option;
  }));
  if (data.counterparties.some((team) => team.key === selectedLender)) lenderSelect.value = selectedLender;
  lenderSelect.disabled = data.counterparties.length === 0;
  document.querySelector("#loan-capacity").textContent =
    `LENDING CAPACITY · ${formatRupees(data.lendingCapacity)} · ${data.activeLoanCount}/${data.rules.maximumActiveLoans} ACTIVE`;
  document.querySelector("#loan-rules").textContent =
    `Rates 7%–20% · terms 1–19 years · equal annual installments. Simple interest is based on original principal; compound interest uses an annual amortized balance. Maximum lending is 15% of current cash; maximum ${data.rules.maximumActiveLoans} active loans.`;

  const list = document.querySelector("#team-loan-list");
  list.querySelectorAll("[data-loan-comment]").forEach((input) => {
    teamState.loanCommentDrafts.set(input.dataset.loanComment, input.value);
  });
  if (!data.loans.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No loan requests or active loans.";
    list.replaceChildren(empty);
  } else {
    list.replaceChildren(...data.loans.map((loan) => {
      const card = document.createElement("article");
      card.className = "loan-card";
      const heading = document.createElement("div");
      heading.className = "loan-card-heading";
      const title = document.createElement("strong");
      title.textContent = `${loan.borrower} → ${loan.lender}`;
      const status = document.createElement("span");
      status.textContent = loan.status.replaceAll("_", " ").toUpperCase();
      heading.append(title, status);
      const terms = document.createElement("p");
      terms.textContent = `${formatRupees(loan.principal)} · ${loan.ratePercent}% ${loan.interestType} · ${loan.termYears} years · ${loan.paidInstallments}/${loan.termYears} installments`;
      const initialComment = document.createElement("p");
      initialComment.textContent = `Request: ${loan.comments || "No comment provided."}`;
      card.append(heading, terms, initialComment);
      if (loan.lenderDecision) {
        const note = document.createElement("p");
        note.textContent = `Lender ${loan.lenderDecision.decision}: ${loan.lenderDecision.comments || "No comment."}`;
        card.append(note);
      }
      if (loan.adminDecision) {
        const note = document.createElement("p");
        note.textContent = `Admin ${loan.adminDecision.decision}: ${loan.adminDecision.comments || "No comment."}`;
        card.append(note);
      }
      if (loan.status === "active") {
        const outstanding = document.createElement("p");
        outstanding.textContent = `Outstanding principal ${formatRupees(loan.outstandingPrincipal)} · annual installment ${formatRupees(loan.annualPayment)} · payments occur automatically at decade settlements.`;
        card.append(outstanding);
      }
      if (loan.status === "defaulted") {
        const defaultNotice = document.createElement("p");
        defaultNotice.textContent = `Defaulted unpaid balance ${formatRupees(loan.defaultAmount)}.`;
        card.append(defaultNotice);
      }
      if (loan.payments?.length) {
        const paymentHistory = document.createElement("p");
        paymentHistory.textContent = `Payments: ${loan.payments.slice(-3).map((payment) =>
          `#${payment.installment} ${formatRupees(payment.paid)} (${payment.decade})`
        ).join(" · ")}`;
        card.append(paymentHistory);
      }
      if (loan.status === "pending_lender" && loan.lender === teamState.team) {
        const comment = document.createElement("textarea");
        comment.maxLength = 500;
        comment.placeholder = "Lender decision comment (required for rejection)";
        comment.dataset.loanComment = loan.id;
        comment.value = teamState.loanCommentDrafts.get(loan.id) || "";
        const actions = document.createElement("div");
        actions.className = "button-row";
        for (const decision of ["accepted", "rejected"]) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = decision === "accepted" ? "button button-primary" : "button button-danger";
          button.dataset.loanDecision = decision;
          button.dataset.loanId = loan.id;
          button.textContent = decision === "accepted" ? "ACCEPT FOR ADMIN REVIEW" : "REJECT REQUEST";
          actions.append(button);
        }
        card.append(comment, actions);
      }
      return card;
    }));
  }
  section.hidden = document.body.dataset.round === "2";
}

async function submitLoanRequest(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  formMessage(form, "Sending request…");
  try {
    await api("/api/loans/requests", {
      method: "POST",
      body: JSON.stringify({
        lenderKey: form.elements.lenderKey.value,
        principal: Number(form.elements.principal.value),
        ratePercent: Number(form.elements.ratePercent.value),
        termYears: Number(form.elements.termYears.value),
        interestType: form.elements.interestType.value,
        comments: form.elements.comments.value
      })
    });
    form.reset();
    form.elements.ratePercent.value = "7";
    form.elements.termYears.value = "1";
    formMessage(form, "Request sent to the lender.");
    await refreshTeamPanel();
  } catch (error) {
    formMessage(form, error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function decideLoanAsLender(event) {
  const button = event.target.closest("[data-loan-decision]");
  if (!button) return;
  const comments = document.querySelector(`[data-loan-comment="${button.dataset.loanId}"]`).value;
  button.disabled = true;
  try {
    await api(`/api/loans/${button.dataset.loanId}/lender-decision`, {
      method: "POST",
      body: JSON.stringify({ decision: button.dataset.loanDecision, comments })
    });
    teamState.loanCommentDrafts.delete(button.dataset.loanId);
    await refreshTeamPanel();
    toast(button.dataset.loanDecision === "accepted"
      ? "Loan sent to admin for approval."
      : "Loan request rejected.");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

function renderStandings(bids, myBid) {
  const list = document.querySelector("#participant-leaderboard");
  const empty = document.querySelector("#participant-board-empty");
  list.replaceChildren();
  empty.hidden = bids.length > 0;
  bids.slice(0, 10).forEach((bid) => {
    const item = document.createElement("li");
    if (myBid && bid.team === myBid.team) item.classList.add("is-own-bid");
    const rank = document.createElement("span");
    rank.className = "rank-number";
    rank.textContent = String(bid.rank).padStart(2, "0");
    const details = document.createElement("span");
    details.className = "rank-team";
    const name = document.createElement("strong");
    name.textContent = bid.team;
    details.append(name);
    if (myBid && bid.team === myBid.team) {
      const offer = document.createElement("small");
      offer.textContent = `${formatRupees(myBid.principal)} · ${myBid.ratePercent}% p.a.`;
      details.append(offer);
    }
    const score = document.createElement("span");
    score.className = "rank-bvi";
    score.textContent = bid.bvi.toFixed(4);
    item.append(rank, details, score);
    list.append(item);
  });
}

function renderFinancials(company) {
  const items = [
    ["CAPITAL REQUESTED", formatRupees(company.principalRequired)],
    ["MINIMUM BID", formatRupees(company.minimumPrincipal)],
    ["MAX. INTEREST", `${company.maximumRate}%`]
  ];
  const financials = document.querySelector("#deal-financials");
  financials.replaceChildren(...items.map(([label, value], index) => {
    const item = document.createElement("div");
    const labelElement = document.createElement("span");
    labelElement.textContent = label;
    const valueElement = document.createElement("strong");
    valueElement.textContent = value;
    item.append(labelElement, valueElement);
    if (index === 0) item.classList.add("financials-primary");
    return item;
  }));
}

async function updatePreview() {
  const form = document.querySelector("#bid-form");
  const company = teamState.auction?.company;
  if (!company) return;
  const score = bvi(Number(form.elements.principal.value), Number(form.elements.ratePercent.value), company);
  const scoreNode = document.querySelector("#bvi-value");
  const rankNode = document.querySelector("#rank-preview");
  const requestId = ++teamState.previewRequestId;
  if (score === null) {
    scoreNode.textContent = "—";
    rankNode.textContent = "Use the minimum bid and allowed increments to preview your rank.";
    return;
  }
  scoreNode.textContent = score.toFixed(4);
  if (teamState.auction.status !== "open") {
    const rank = teamState.auction.myBid?.rank;
    rankNode.textContent = rank ? `Final position: #${rank}.` : "This auction is closed.";
    return;
  }
  rankNode.textContent = "Calculating projected position…";
  try {
    const preview = await api("/api/bids/preview", {
      method: "POST",
      body: JSON.stringify({
        principal: Number(form.elements.principal.value),
        ratePercent: Number(form.elements.ratePercent.value)
      })
    });
    if (requestId !== teamState.previewRequestId) return;
    scoreNode.textContent = preview.bvi.toFixed(4);
    rankNode.textContent = `Projected position: #${preview.rank} of ${preview.competingBids + 1}.`;
  } catch (error) {
    if (requestId !== teamState.previewRequestId) return;
    rankNode.textContent = error.message;
  }
}

function renderAuction(data) {
  teamState.auction = data;
  const waiting = document.querySelector("#auction-waiting");
  const deal = document.querySelector("#active-deal");
  const status = document.querySelector("#team-auction-status");
  const label = status.querySelector("span:last-child");
  const company = data.company;
  const isOpen = data.status === "open" && company;

  if (!company) {
    waiting.hidden = false;
    deal.hidden = true;
    const currentPeriod = data.banking
      ? `${data.banking.eraName} · ${data.banking.decade || "era settlement"}`
      : "Waiting for the auction";
    document.querySelector("#team-auction-title").textContent = currentPeriod;
    label.textContent = "WAITING";
    status.classList.remove("is-open", "is-closed");
    waiting.querySelector("h3").textContent = "The next company will appear here.";
    waiting.querySelector("p").textContent = "Stay signed in. Your bid panel opens when the admin starts an auction.";
    teamState.companyId = null;
    return;
  }

  waiting.hidden = true;
  deal.hidden = false;
  document.querySelector("#team-auction-title").textContent = company.name;
  label.textContent = isOpen ? "BIDDING OPEN" : "AUCTION CLOSED";
  status.classList.toggle("is-open", isOpen);
  status.classList.toggle("is-closed", !isOpen);

  if (teamState.companyId !== company.id) {
    teamState.companyId = company.id;
    teamState.editingOffer = false;
    const form = document.querySelector("#bid-form");
    delete form.dataset.hasSubmitted;
    document.querySelector("#deal-meta").textContent = `${company.id} · ${company.eraName} · ${company.decade}`;
    document.querySelector("#deal-name").textContent = company.name;
    document.querySelector("#deal-sector").textContent = company.sector;
    document.querySelector("#deal-summary").textContent = company.summary;
    renderFinancials(company);
    form.elements.principal.min = String(company.minimumPrincipal);
    form.elements.principal.max = String(teamState.data.rules.singleBidLimit);
    form.elements.principal.value = data.myBid?.principal || company.minimumPrincipal;
    form.elements.ratePercent.min = "0";
    form.elements.ratePercent.max = String(company.maximumRate);
    form.elements.ratePercent.value = data.myBid?.ratePercent ?? Math.min(8, company.maximumRate);
  } else if (data.myBid && !teamState.editingOffer && !document.querySelector("#bid-form").dataset.hasSubmitted) {
    document.querySelector("#bid-form").elements.principal.value = data.myBid.principal;
    document.querySelector("#bid-form").elements.ratePercent.value = data.myBid.ratePercent;
  }

  const form = document.querySelector("#bid-form");
  form.elements.principal.disabled = !isOpen;
  form.elements.ratePercent.disabled = !isOpen;
  form.querySelector(".bid-submit").disabled = !isOpen;
  document.querySelector("#bid-form-heading span:last-child").textContent = isOpen
    ? "Edit your offer to preview BVI and position before submitting."
    : "This auction is closed. The winning team will receive its company briefing.";
  renderStandings(data.leaderboard, data.myBid);
  updatePreview();
}

function formatBloodlinesValue(value) {
  return `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function captureBloodlinesDraft() {
  const form = document.querySelector("#bloodlines-allocation-form");
  if (!form || !teamState.bloodlinesState
      || form.dataset.year !== String(teamState.bloodlinesState.year)
      || !form.querySelector("[data-instrument-row]")) return null;
  const trades = Object.fromEntries([...form.querySelectorAll("[data-instrument-row]")].map((row) => [
    row.dataset.tradeLine,
    {
      instrument: row.querySelector("[data-trade-instrument]").value,
      action: row.querySelector("[data-trade-action]").value,
      quantity: row.querySelector("input").value
    }
  ]));
  const insurance = [...form.querySelectorAll("[name=insurance]:checked")].map((input) => input.value);
  return { trades: Object.values(trades), insurance };
}

function renderBloodlines(state, draftOverride = null) {
  const previousState = teamState.bloodlinesState;
  const allocationForm = document.querySelector("#bloodlines-allocation-form");
  const preserveForm = !draftOverride
    && previousState?.subround === state.subround
    && previousState?.year === state.year
    && previousState?.stage === state.stage
    && allocationForm.querySelector("[data-instrument-row]");
  teamState.bloodlinesState = state;
  document.querySelector("#team-auction").hidden = true;
  document.querySelector("#bloodlines-team-panel").hidden = false;
  const title = document.querySelector("#bloodlines-title");
  const stage = document.querySelector("#bloodlines-stage");
  const notice = document.querySelector("#bloodlines-instructions");
  const draft = captureBloodlinesDraft() || {
    trades: (state.allocation?.trades || []).map((trade) => ({
      instrument: trade.instrument,
      action: trade.action,
      quantity: String(trade.quantity)
    })),
    insurance: state.allocation?.insurance || []
  };
  if (draftOverride) {
    draft.trades = draftOverride.trades;
    draft.insurance = draftOverride.insurance;
  }
  if (draft.trades.length === 0) draft.trades = [{ instrument: "TECH", action: "hold", quantity: "" }];
  title.textContent = state.started
    ? `Sub-round ${state.subround} / ${state.subrounds} · Years ${state.years.start}–${state.years.end}`
    : "Waiting for the simulation";
  stage.textContent = state.started
    ? `${state.stageName.replaceAll("_", " ").toUpperCase()}`
    : "WAITING";
  notice.textContent = state.started
    ? `Annual salary ${formatBloodlinesValue(state.current.salary)} · household expenses ${formatBloodlinesValue(state.current.expenses)} · ${state.status === "trading" ? "Allocation is open; save or update your portfolio." : state.stage === "allocation" ? "Waiting for the admin to set this sub-round's returns before allocations open." : `Simulation Year ${state.year} · decisions are locked until the next allocation window.`}`
    : "Your household ledger and investment decisions will appear when the admin starts Bloodlines.";
  document.querySelector("#bloodlines-coverage").textContent = state.started
    ? `ACTIVE INSURANCE · ${state.coverage.length ? state.coverage.join(" · ") : "No active cover"}`
    : "";

  const summary = document.querySelector("#bloodlines-summary");
  summary.replaceChildren();
  [
    ["CASH", formatBloodlinesValue(state.cash)],
    ["DEBT", formatBloodlinesValue(state.debt)],
    ["PORTFOLIO", String(Object.keys(state.holdings || {}).length + (state.deposits || []).filter((item) => !item.matured).length)],
    ["CURRENT NET WORTH", state.score === null ? "HIDDEN" : formatBloodlinesValue(state.score)]
  ].forEach(([label, value]) => {
    const item = document.createElement("div");
    const caption = document.createElement("span");
    caption.textContent = label;
    const amount = document.createElement("strong");
    amount.textContent = value;
    item.append(caption, amount);
    summary.append(item);
  });

  const news = document.querySelector("#bloodlines-news");
  news.replaceChildren();
  for (const item of state.news || []) {
    const article = document.createElement("article");
    const number = document.createElement("span");
    number.textContent = `YEAR ${String(item.year).padStart(2, "0")}`;
    const text = document.createElement("p");
    text.textContent = item.text;
    const effect = document.createElement("p");
    effect.className = "bloodlines-news-effect";
    effect.textContent = `EFFECT · ${item.effect || "No effect details provided"}`;
    const affectedNames = (item.affectedInstrumentIds || []).map((id) => (
      state.instruments.find((instrument) => instrument.id === id)?.name
    )).filter(Boolean);
    const affected = document.createElement("span");
    affected.className = "bloodlines-news-targets";
    affected.textContent = `AFFECTS · ${affectedNames.join(" · ") || "Not specified"}`;
    article.append(number, text, effect, affected);
    news.append(article);
  }
  const market = document.querySelector("#bloodlines-market");
  market.hidden = !state.started;
  market.replaceChildren();
  if (state.started) {
    const returnHeading = document.createElement("strong");
    returnHeading.textContent = `SUB-ROUND ${state.subround} ANNUAL RETURNS`;
    const returns = document.createElement("div");
    returns.className = "bloodlines-market-prices";
    for (const instrument of state.instruments) {
      const item = document.createElement("span");
      const annualReturn = Number(state.annualReturns?.[instrument.id]);
      const label = instrument.type === "fd" ? "annual FD rate" : "annual return";
      item.textContent = `${instrument.name} · ${Number.isFinite(annualReturn) ? `${annualReturn > 0 ? "+" : ""}${annualReturn.toFixed(2)}% ${label}` : "return not set"}`;
      returns.append(item);
    }
    market.append(returnHeading, returns);
  }
  if (state.market) {
    const heading = document.createElement("strong");
    heading.textContent = `YEAR ${state.market.year} MARKET PRICES`;
    const prices = document.createElement("div");
    prices.className = "bloodlines-market-prices";
    for (const instrument of state.instruments) {
      if (instrument.type === "fd") continue;
      const item = document.createElement("span");
      const price = instrument.type === "gold"
        ? state.market.gold
        : state.market[instrument.type === "equity" ? "equities" : "funds"][instrument.id];
      item.textContent = `${instrument.name} · ${formatBloodlinesValue(price)}`;
      prices.append(item);
    }
    market.append(heading, prices);
  }
  const wheel = document.querySelector("#bloodlines-wheel");
  const wheelVisible = ["wheel", "reallocation"].includes(state.stage)
    || state.wheel.entries.some((entry) => entry.status !== "waiting");
  wheel.hidden = !wheelVisible;
  document.querySelector("#bloodlines-wheel-spinner").classList.toggle("is-spinning", Boolean(state.wheel.current));
  document.querySelector("#bloodlines-wheel-current").textContent = state.wheel.current
    ? `${state.wheel.current.team} is spinning…`
    : state.stage === "wheel" ? "The next team is about to spin." : "All teams have completed their spin.";
  const wheelEntries = document.querySelector("#bloodlines-wheel-entries");
  wheelEntries.replaceChildren(...state.wheel.entries.map((entry) => {
    const item = document.createElement("li");
    item.className = entry.status === "spinning" ? "is-spinning" : "";
    const name = document.createElement("strong");
    name.textContent = entry.team;
    const outcome = document.createElement("span");
    outcome.textContent = entry.outcome
      ? `${entry.outcome.name} · ${formatBloodlinesValue(entry.outcome.effect)}`
      : entry.status === "spinning" ? "SPINNING NOW" : entry.status.toUpperCase();
    item.append(name, outcome);
    return item;
  }));

  const canTrade = state.status === "trading";
  allocationForm.hidden = !canTrade;
  allocationForm.dataset.year = String(state.year);
  document.querySelector("#bloodlines-allocation-heading").textContent = state.stage === "reallocation"
    ? "Reallocate after the Wheel"
    : "Set your opening allocation";
  document.querySelector(".bloodlines-insurance").hidden = !(
    state.stage === "reallocation" && state.subround < state.subrounds
      || state.stage === "allocation" && state.subround === 1
  );
  document.querySelector(".bloodlines-insurance legend").textContent = state.stage === "reallocation"
    ? "INSURANCE FOR NEXT SUB-ROUND"
    : "INSURANCE COVER";
  allocationForm.querySelectorAll("select, input, button").forEach((input) => { input.disabled = !canTrade; });
  const trades = document.querySelector("#bloodlines-trades");
  const instrumentById = new Map(state.instruments.map((instrument) => [instrument.id, instrument]));
  if (!preserveForm) trades.replaceChildren(...draft.trades.map((tradeDraft, index) => {
    const instrument = instrumentById.get(tradeDraft.instrument) || state.instruments[0];
    const row = document.createElement("tr");
    row.dataset.instrumentRow = "";
    row.dataset.tradeLine = String(index);
    const name = document.createElement("td");
    const instrumentSelect = document.createElement("select");
    instrumentSelect.dataset.tradeInstrument = "";
    instrumentSelect.setAttribute("aria-label", `Trade ${index + 1} instrument`);
    state.instruments.forEach((optionInstrument) => {
      const option = document.createElement("option");
      option.value = optionInstrument.id;
      option.textContent = optionInstrument.name;
      instrumentSelect.append(option);
    });
    instrumentSelect.value = instrument.id;
    name.append(instrumentSelect);
    const price = document.createElement("td");
    const renderTradePrice = () => {
      const selectedInstrument = instrumentById.get(instrumentSelect.value);
      price.textContent = selectedInstrument.type === "fd"
        ? `${selectedInstrument.rate * 100}% p.a.`
        : formatBloodlinesValue(state.tradePrices[selectedInstrument.id]);
    };
    renderTradePrice();
    const actionCell = document.createElement("td");
    const action = document.createElement("select");
    action.dataset.tradeAction = "";
    action.setAttribute("aria-label", `${instrument.name} action`);
    ["hold", "buy", "sell"].forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value.toUpperCase();
      action.append(option);
    });
    action.value = tradeDraft.action || "hold";
    actionCell.append(action);
    const quantityCell = document.createElement("td");
    const quantity = document.createElement("input");
    quantity.type = "number";
    quantity.min = "0";
    const renderQuantityStep = () => {
      const selectedInstrument = instrumentById.get(instrumentSelect.value);
      quantity.step = selectedInstrument.type === "fund" ? "0.01" : selectedInstrument.type === "fd" ? "10000" : "1";
      quantity.placeholder = selectedInstrument.type === "fd" ? "₹ amount" : "units";
    };
    renderQuantityStep();
    instrumentSelect.addEventListener("change", () => {
      renderTradePrice();
      renderQuantityStep();
    });
    quantity.value = tradeDraft.quantity || "";
    quantity.setAttribute("aria-label", `${instrument.name} units or amount`);
    quantityCell.append(quantity);
    row.append(name, price, actionCell, quantityCell);
    return row;
  }));
  const insuranceOptions = document.querySelector("#bloodlines-insurance-options");
  if (!preserveForm) insuranceOptions.replaceChildren(...state.insurance.map((policy) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "insurance";
    input.value = policy.id;
    input.checked = draft.insurance.includes(policy.id);
    const caption = document.createElement("span");
    caption.textContent = `${policy.name} · ${formatBloodlinesValue(policy.premium)}`;
    label.append(input, caption);
    return label;
  }));
  document.querySelector("#bloodlines-cash-preview").textContent = `AVAILABLE CASH · ${formatBloodlinesValue(state.cash)}`;

  const holdings = document.querySelector("#bloodlines-holdings");
  const holdingEntries = [
    ...Object.entries(state.holdings || {}).map(([id, holding]) => `${id}: ${holding.quantity} units`),
    ...(state.deposits || []).filter((item) => !item.matured).map((item) => `${item.term}-year FD: ${formatBloodlinesValue(item.principal)}`)
  ];
  holdings.textContent = holdingEntries.length ? holdingEntries.join(" · ") : "No investments held.";
  const ledger = document.querySelector("#bloodlines-ledger");
  ledger.replaceChildren(...(state.ledger || []).slice().reverse().map((entry) => {
    const item = document.createElement("li");
    item.textContent = `${entry.description} · ${formatBloodlinesValue(entry.amount)}`;
    return item;
  }));
  const results = document.querySelector("#bloodlines-results");
  results.hidden = state.score === null;
  if (state.score !== null) {
    document.querySelector("#bloodlines-scoreboard").textContent = `Final household net worth · ${formatBloodlinesValue(state.score)}`;
  }
}

async function submitBloodlinesAllocation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const trades = [...form.querySelectorAll("[data-instrument-row]")].flatMap((row) => {
    const action = row.querySelector("[data-trade-action]").value;
    const quantity = Number(row.querySelector("input").value);
    return action === "hold" || !quantity ? [] : [{
      instrument: row.querySelector("[data-trade-instrument]").value,
      action,
      quantity
    }];
  });
  const insurance = [...form.querySelectorAll("[name=insurance]:checked")].map((input) => input.value);
  try {
    const result = await api("/api/bloodlines/allocation", {
      method: "POST",
      body: JSON.stringify({ trades, insurance })
    });
    formMessage(form, `Allocation saved · available cash ${formatBloodlinesValue(result.cash)}.`, false);
    await refreshTeamPanel();
  } catch (error) {
    formMessage(form, error.message, true);
  }
}

async function refreshTeamPanel() {
  try {
    if (document.body.dataset.round === "2") {
      document.querySelector("#banking-account").hidden = true;
      const state = await api("/api/bloodlines/state");
      renderBloodlines(state);
      return;
    }
    document.querySelector("#banking-account").hidden = false;
    document.querySelector("#bloodlines-team-panel").hidden = true;
    document.querySelector("#team-auction").hidden = false;
    const [auction, results, loans] = await Promise.all([
      api("/api/auction"),
      api("/api/team/results"),
      api("/api/loans")
    ]);
    renderAuction(auction);
    showWonBids(results.results);
    renderBankingAccount(results.banking);
    renderTeamLoans(loans);
  } catch (error) {
    if (error.message.startsWith("Sign in")) {
      clearInterval(teamState.poll);
      teamState.team = null;
      document.querySelector("#team-login-card").hidden = false;
      document.querySelector("#team-dashboard").hidden = true;
      return;
    }
    toast(error.message);
  }
}

async function submitBid(event) {
  event.preventDefault();
  if (document.body.dataset.round === "2") return;
  const form = event.currentTarget;
  const button = form.querySelector(".bid-submit");
  const message = document.querySelector("#bid-message");
  button.disabled = true;
  formMessage(form, "");
  try {
    const result = await api("/api/bids", {
      method: "POST",
      body: JSON.stringify({
        principal: Number(form.elements.principal.value),
        ratePercent: Number(form.elements.ratePercent.value)
      })
    });
    form.dataset.hasSubmitted = "true";
    message.textContent = `Bid submitted · BVI ${result.bvi.toFixed(4)} · currently #${result.rank}. You can update it while bidding remains open.`;
    await refreshTeamPanel();
    toast("Your bid is on the live leaderboard.");
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("is-error");
    await refreshTeamPanel();
  } finally {
    button.disabled = teamState.auction?.status !== "open";
  }
}

function startPolling() {
  clearInterval(teamState.poll);
  refreshTeamPanel();
  teamState.poll = setInterval(() => {
    if (document.visibilityState === "visible") refreshTeamPanel();
  }, 2000);
}

async function signOut() {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    clearInterval(teamState.poll);
    teamState.team = null;
    document.querySelector("#team-login-card").hidden = false;
    document.querySelector("#team-dashboard").hidden = true;
  } catch (error) {
    toast(error.message);
  }
}

async function initialize() {
  const login = document.querySelector("#participant-login");
  login.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = login.querySelector("button");
    button.disabled = true;
    formMessage(login, "Signing in…");
    try {
      const result = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          team: new FormData(login).get("team"),
          code: new FormData(login).get("code")
        })
      });
      teamState.team = result.team;
      document.querySelector("#participant-team-name").textContent = result.team;
      document.querySelector("#team-login-card").hidden = true;
      document.querySelector("#team-dashboard").hidden = false;
      login.reset();
      startPolling();
    } catch (error) {
      formMessage(login, error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#participant-logout").addEventListener("click", signOut);
  document.querySelector("#loan-request-form").addEventListener("submit", submitLoanRequest);
  document.querySelector("#team-loan-list").addEventListener("click", decideLoanAsLender);
  document.querySelector("#bloodlines-allocation-form").addEventListener("submit", submitBloodlinesAllocation);
  document.querySelector("#bloodlines-add-trade").addEventListener("click", () => {
    if (!teamState.bloodlinesState) return;
    const currentDraft = captureBloodlinesDraft() || { trades: [], insurance: [] };
    currentDraft.trades.push({ instrument: "TECH", action: "hold", quantity: "" });
    renderBloodlines(teamState.bloodlinesState, currentDraft);
  });
  document.addEventListener("banks-round-change", refreshTeamPanel);
  const bidForm = document.querySelector("#bid-form");
  bidForm.addEventListener("submit", submitBid);
  ["principal", "ratePercent"].forEach((name) => {
    bidForm.elements[name].addEventListener("input", () => {
      teamState.editingOffer = true;
      clearTimeout(teamState.previewTimer);
      teamState.previewTimer = setTimeout(updatePreview, 150);
    });
  });
  try {
    teamState.data = await api("/api/events");
    const session = await api("/api/auth/session");
    if (session.authenticated && session.role === "participant") {
      teamState.team = session.team;
      document.querySelector("#participant-team-name").textContent = session.team;
      document.querySelector("#team-login-card").hidden = true;
      document.querySelector("#team-dashboard").hidden = false;
      startPolling();
    }
  } catch (error) {
    formMessage(login, error.message, true);
  }
}

initialize();
