const adminState = {
  data: null,
  banking: null,
  loans: [],
  qualification: null,
  qualificationSelection: new Set(),
  poll: null,
  editingSelection: false,
  authenticated: false,
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

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function setFormMessage(form, message, error = false) {
  const output = form.querySelector(".form-message");
  output.textContent = message;
  output.classList.toggle("is-error", error);
}

function renderLogin() {
  adminState.authenticated = false;
  window.dispatchEvent(new Event("banks-admin-signed-out"));
  document.querySelector("#admin-login-card").hidden = false;
  document.querySelector("#admin-dashboard").hidden = true;
  document.querySelector("#bloodlines-admin-panel").hidden = true;
}

function renderDashboard() {
  adminState.authenticated = true;
  window.dispatchEvent(new Event("banks-admin-authenticated"));
  document.querySelector("#admin-login-card").hidden = true;
  const eraSelect = document.querySelector("#auction-control-form select[name=era]");
  eraSelect.replaceChildren(...adminState.data.eras.map((era) => {
    const option = document.createElement("option");
    option.value = era.id;
    option.textContent = era.name;
    return option;
  }));
  eraSelect.disabled = true;
  refreshCompanySelect();
  applyRoundMode();
}

function applyRoundMode() {
  const isRoundTwo = document.body.dataset.round === "2";
  document.querySelector("#admin-dashboard").hidden = isRoundTwo || !adminState.authenticated;
  document.querySelector("#bloodlines-admin-panel").hidden = !isRoundTwo || !adminState.authenticated;
  const form = document.querySelector("#auction-control-form");
  form.elements.era.disabled = true;
  form.elements.companyId.disabled = isRoundTwo;
  form.querySelector('button[type="submit"]').disabled = isRoundTwo;
  document.querySelector("#close-auction").disabled = isRoundTwo;
  if (isRoundTwo && adminState.authenticated) refreshBloodlines();
}

function refreshCompanySelect(selectedId = "") {
  const form = document.querySelector("#auction-control-form");
  const companies = (adminState.banking?.current?.companies || [])
    .filter((company) => !company.auctioned);
  const select = form.elements.companyId;
  select.replaceChildren(...companies.map((company) => {
    const option = document.createElement("option");
    option.value = company.id;
    option.textContent = `${company.id} · ${company.name}`;
    return option;
  }));
  if (selectedId && companies.some((company) => company.id === selectedId)) select.value = selectedId;
  select.disabled = !adminState.banking?.ready || companies.length === 0;
  form.querySelector('button[type="submit"]').disabled = select.disabled;
}

async function createTeam(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const result = document.querySelector("#team-code-result");
  button.disabled = true;
  setFormMessage(form, "Creating team login…", false);
  try {
    const created = await api("/api/admin/teams", {
      method: "POST",
      body: JSON.stringify({ name: new FormData(form).get("name") })
    });
    result.replaceChildren();
    const label = document.createElement("span");
    label.textContent = `Access code for ${created.team}. Share it privately; it cannot be viewed again:`;
    const code = document.createElement("strong");
    code.textContent = created.accessCode;
    result.append(label, code);
    result.hidden = false;
    form.reset();
    setFormMessage(form, "Team login created.", false);
    await refreshDashboard();
  } catch (error) {
    setFormMessage(form, error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function setAuction(status) {
  if (document.body.dataset.round === "2") return;
  const form = document.querySelector("#auction-control-form");
  const body = { status };
  if (status === "open") {
    body.era = form.elements.era.value;
    body.companyId = form.elements.companyId.value;
  }
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    await api("/api/admin/auction", { method: "POST", body: JSON.stringify(body) });
    adminState.editingSelection = false;
    setFormMessage(form, status === "open" ? "Company auction is live." : "Auction closed and winner confirmed.", false);
    await refreshDashboard();
    showToast(status === "open" ? "Auction opened." : "Auction closed; winner confirmed.");
  } catch (error) {
    setFormMessage(form, error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function openAuction(event) {
  event.preventDefault();
  return setAuction("open");
}

function closeAuction() {
  return setAuction("closed");
}

function renderTeams(teams) {
  document.querySelector("#team-count").textContent = String(teams.length);
  const list = document.querySelector("#admin-team-list");
  if (teams.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No team logins created yet.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...teams.map((team) => {
    const item = document.createElement("li");
    item.textContent = `${team.name} · CASH ${formatRupees(team.balance)}`;
    return item;
  }));
}

function renderBankingProgress(state, auctionStatus) {
  const period = document.querySelector("#banking-period");
  const progress = document.querySelector("#banking-progress");
  const message = document.querySelector("#banking-message");
  const errors = document.querySelector("#banking-errors");
  const settleButton = document.querySelector("#banking-settle-decade");
  const teams = document.querySelector("#banking-team-balances");
  const result = document.querySelector("#banking-settlement-result");
  const startButton = document.querySelector("#auction-control-form").querySelector('button[type="submit"]');

  errors.hidden = state.setupErrors.length === 0;
  errors.replaceChildren(...state.setupErrors.map((text) => {
    const item = document.createElement("p");
    item.textContent = text;
    return item;
  }));
  if (!state.current) {
    period.textContent = state.complete ? "Round 1 is complete" : "No active era";
    progress.textContent = state.complete ? "COMPLETE" : "NOT READY";
    message.textContent = state.complete
      ? "All eras and decade settlements are complete. Team balances carry forward with no open company positions."
      : "Correct the company dataset errors before running Round 1.";
  } else {
    period.textContent = `${state.current.eraName} · ${state.current.decade}`;
    progress.textContent = `DECADE ${String(state.current.decadeIndex).padStart(2, "0")} / ${state.current.decadeCount}`;
    const pending = state.current.companies.filter((company) => !company.auctioned).length;
    message.textContent = state.ready
      ? `${pending} company auction${pending === 1 ? "" : "s"} remain in this decade. Idle cash compounds at 4% annually; decade interest and NPI settle after every company closes.`
      : "Correct the company dataset errors before opening or settling auctions.";
  }
  teams.replaceChildren(...state.teams.map((team) => {
    const item = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = team.name;
    const balance = document.createElement("span");
    balance.textContent = `CASH ${formatRupees(team.balance)} · INVESTED ${formatRupees(team.invested)}`;
    item.append(name, balance);
    return item;
  }));
  const last = state.lastSettlement;
  result.hidden = !last;
  if (last) {
    const heading = document.createElement("strong");
    heading.textContent = `LAST SETTLEMENT · ${last.eraName} · ${last.decade}`;
    const rows = document.createElement("div");
    rows.className = "banking-settlement-rows";
    for (const outcome of last.outcomes) {
      const row = document.createElement("p");
      row.textContent = `${outcome.companyName || outcome.companyId} · NPI ${Number(outcome.npi).toFixed(2)} · Interest paid ${formatRupees(outcome.interestPaid)}`;
      rows.append(row);
    }
    if (last.eraSettlement) {
      const eraHeading = document.createElement("strong");
      eraHeading.textContent = "ERA-END PRINCIPAL RETURNS";
      rows.append(eraHeading);
      for (const payout of last.eraSettlement.principalReturns) {
        const row = document.createElement("p");
        row.textContent = `${payout.teamName} · ${payout.companyName} · NPI ${Number(payout.npi).toFixed(2)} · ${formatRupees(payout.principalReturned)}`;
        rows.append(row);
      }
    }
    result.replaceChildren(heading, rows);
  }
  const currentPending = state.current?.companies?.some((company) => !company.auctioned);
  settleButton.disabled = !state.ready || !state.current || Boolean(currentPending) || auctionStatus === "open";
  startButton.disabled = !state.ready || !currentPending || auctionStatus === "open";
}

function renderAdminLoans(loans) {
  const list = document.querySelector("#admin-loan-list");
  list.querySelectorAll("[data-admin-loan-comment]").forEach((input) => {
    adminState.loanCommentDrafts.set(input.dataset.adminLoanComment, input.value);
  });
  if (!loans.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No inter-team loan requests yet.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...loans.map((loan) => {
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
    const initialComments = document.createElement("p");
    initialComments.textContent = `Request: ${loan.comments || "No comment provided."}`;
    card.append(heading, terms, initialComments);
    if (loan.lenderDecision) {
      const lenderNote = document.createElement("p");
      lenderNote.textContent = `Lender ${loan.lenderDecision.decision}: ${loan.lenderDecision.comments || "No comment."}`;
      card.append(lenderNote);
    }
    if (loan.adminDecision) {
      const adminNote = document.createElement("p");
      adminNote.textContent = `Admin ${loan.adminDecision.decision}: ${loan.adminDecision.comments || "No comment."}`;
      card.append(adminNote);
    }
    if (loan.status === "active") {
      const outstanding = document.createElement("p");
      outstanding.textContent = `Outstanding principal ${formatRupees(loan.outstandingPrincipal)} · annual installment ${formatRupees(loan.annualPayment)} · scheduled payments at decade checkpoints`;
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
    if (loan.status === "pending_admin") {
      const comment = document.createElement("textarea");
      comment.maxLength = 500;
      comment.placeholder = "Admin decision comment (required for rejection)";
      comment.dataset.adminLoanComment = loan.id;
      comment.value = adminState.loanCommentDrafts.get(loan.id) || "";
      const actions = document.createElement("div");
      actions.className = "button-row";
      for (const decision of ["approved", "rejected"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = decision === "approved" ? "button button-primary" : "button button-danger";
        button.dataset.adminLoanDecision = decision;
        button.dataset.loanId = loan.id;
        button.textContent = decision === "approved" ? "APPROVE LOAN" : "REJECT LOAN";
        actions.append(button);
      }
      card.append(comment, actions);
    }
    return card;
  }));
}

function renderStandings(auction, board) {
  const status = document.querySelector("#admin-auction-status");
  const title = document.querySelector("#admin-board-title");
  const caption = document.querySelector("#admin-board-caption");
  const target = document.querySelector("#admin-live-board");
  document.querySelector("#close-auction").disabled = auction.status !== "open";
  renderTeams(board.teams);

  if (!auction.company) {
    document.querySelector("#auction-control-form").querySelector('button[type="submit"]').disabled =
      !adminState.banking?.ready || !adminState.banking?.current
      || !adminState.banking.current.companies.some((company) => !company.auctioned)
      || auction.status === "open";
    status.textContent = "Waiting for an auction.";
    title.textContent = "No company selected";
    caption.textContent = adminState.banking?.current
      ? "Only companies in the active decade can be opened. Future companies are hidden from participants."
      : "The team leaderboard will appear when the next company auction opens.";
    target.replaceChildren();
    return;
  }

  const company = auction.company;
  status.textContent = `${auction.status === "open" ? "BIDDING OPEN" : "BIDDING CLOSED"} · ${company.name}`;
  title.textContent = `${company.id} · ${company.name}`;
  caption.textContent = `${auction.leaderboard.length} bids · ${auction.status === "open" ? "Open — standings update as teams bid." : "Closed — top bid is the confirmed winner."}`;

  const control = document.querySelector("#auction-control-form");
  control.querySelector('button[type="submit"]').disabled = auction.status === "open"
    || !adminState.banking?.ready;
  if (!adminState.editingSelection) {
    control.elements.era.value = company.era;
    refreshCompanySelect(company.id);
    control.querySelector('button[type="submit"]').disabled = auction.status === "open"
      || !adminState.banking?.ready;
  }

  if (auction.leaderboard.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = auction.status === "closed"
      ? "No bids were submitted before this auction closed."
      : "No bids yet. Standings will update when teams submit offers.";
    target.replaceChildren(empty);
    return;
  }

  const table = document.createElement("div");
  table.className = "leaderboard-table";
  const header = document.createElement("div");
  header.className = "leaderboard-row leaderboard-header";
  ["RANK", "TEAM", "PRINCIPAL", "INTEREST", "BVI"].forEach((label) => {
    const cell = document.createElement("span");
    cell.textContent = label;
    header.append(cell);
  });
  table.append(header);
  auction.leaderboard.forEach((bid) => {
    const row = document.createElement("div");
    row.className = "leaderboard-row";
    [
      String(bid.rank).padStart(2, "0"),
      bid.team,
      formatRupees(bid.principal),
      `${bid.ratePercent}%`,
      bid.bvi.toFixed(4)
    ].forEach((value, index) => {
      const cell = document.createElement("span");
      cell.textContent = value;
      if (index === 0) cell.className = "rank-number";
      if (index === 1) cell.className = "rank-team-name";
      if (index === 4) cell.className = "rank-bvi";
      row.append(cell);
    });
    table.append(row);
  });
  target.replaceChildren(table);
}

function renderRoundOneQualification(state) {
  const status = document.querySelector("#round-one-closeout-status");
  const message = document.querySelector("#round-one-closeout-message");
  const list = document.querySelector("#round-one-qualifier-list");
  const closeButton = document.querySelector("#round-one-closeout-submit");
  const qualifierInputs = [...list.querySelectorAll("[data-qualifier-key]")];
  if (!state.locked && qualifierInputs.length) {
    adminState.qualificationSelection = new Set(
      qualifierInputs.filter((input) => input.checked)
        .map((input) => input.dataset.qualifierKey)
    );
  }
  if (state.locked) {
    adminState.qualificationSelection = new Set(state.qualifierKeys);
    status.textContent = "CLOSED";
    message.textContent = `Qualifier list locked ${new Date(state.closedAt).toLocaleString()}. Bloodlines will use its configured starting cash; Round 1 balances are not transferred.`;
    closeButton.disabled = true;
    closeButton.textContent = "ROUND 1 CLOSED";
  } else {
    status.textContent = state.available ? "READY TO CLOSE" : "IN PROGRESS";
    message.textContent = state.available
      ? "Select the teams that advance. Ranking adds current Round 1 cash and remaining scheduled loan credits, then subtracts remaining scheduled loan payments. This preview does not transfer money. Defaulted loans are excluded; requests not finally approved expire when Round 1 closes."
      : "The admin can end Round 1 early at any time. Select the teams that qualify now; the current standings are used immediately and Bloodlines always starts with the event's fixed cash amount.";
    closeButton.disabled = state.locked || adminState.qualificationSelection.size === 0;
    closeButton.textContent = state.available ? "END ROUND 1 & LOCK QUALIFIERS" : "END ROUND 1 NOW & LOCK QUALIFIERS";
  }
  document.querySelectorAll("#team-create-form input, #team-create-form button")
    .forEach((control) => { control.disabled = state.locked; });
  list.replaceChildren(...state.rankings.map((team, index) => {
    const row = document.createElement("label");
    row.className = "round-one-qualifier-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.qualifierKey = team.teamKey;
    checkbox.checked = adminState.qualificationSelection.has(team.teamKey);
    checkbox.disabled = state.locked || !state.canClose;
    const rank = document.createElement("strong");
    rank.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("strong");
    name.textContent = team.team;
    const cash = document.createElement("span");
    cash.textContent = `CASH ${formatRupees(team.cash)}`;
    const credit = document.createElement("span");
    credit.textContent = `CREDIT ${formatRupees(team.projectedCredits)}`;
    const debt = document.createElement("span");
    debt.textContent = `DEBT ${formatRupees(team.projectedDebts)}`;
    const net = document.createElement("b");
    net.textContent = `PROJECTED ${formatRupees(team.projectedNet)}`;
    row.append(checkbox, rank, name, cash, credit, debt, net);
    return row;
  }));
  if (!state.rankings.length && !state.locked) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "The performance list will appear when Round 1 is complete.";
    list.replaceChildren(empty);
  }
}

async function refreshDashboard() {
  try {
    if (document.body.dataset.round === "2") {
      await refreshBloodlines();
      return;
    }
    const [banking, auction, teamData, loanData, qualification] = await Promise.all([
      api("/api/admin/banking"),
      api("/api/auction"),
      api("/api/admin/teams"),
      api("/api/admin/loans"),
      api("/api/admin/round-one/qualification")
    ]);
    adminState.banking = banking;
    adminState.loans = loanData.loans;
    adminState.qualification = qualification;
    const eraSelect = document.querySelector("#auction-control-form").elements.era;
    if (banking.current && eraSelect.value !== banking.current.era) {
      eraSelect.value = banking.current.era;
    }
    refreshCompanySelect();
    renderBankingProgress(banking, auction.status);
    renderRoundOneQualification(qualification);
    renderAdminLoans(loanData.loans);
    renderStandings(auction, teamData);
  } catch (error) {
    if (error.message.includes("Sign in")) {
      clearInterval(adminState.poll);
      renderLogin();
      return;
    }
    showToast(error.message);
  }
}

function renderBloodlinesAdmin(state, scoreboard) {
  document.querySelector("#bloodlines-admin-status").textContent = state.started
    ? `Sub-round ${state.subround} / ${state.subrounds} · Years ${state.years.start}–${state.years.end} · ${state.stageName}`
    : "Waiting to start";
  document.querySelector("#bloodlines-admin-year").textContent = state.started
    ? `${state.subround} / ${state.subrounds} · ${state.years.start}–${state.years.end}`
    : "1–80";
  document.querySelector("#bloodlines-admin-stage").textContent = state.started
    ? state.stageName.toUpperCase()
    : "NOT STARTED";
  const wheelDone = state.wheel.entries.filter((entry) => entry.status === "done").length;
  const submitted = state.stage === "reallocation"
    ? state.teams.filter((team) => team.reallocated).length
    : state.stage === "wheel" ? wheelDone : state.teams.filter((team) => team.submitted).length;
  const submissionLabel = state.stage === "wheel" ? "SPINS" : state.stage === "reallocation" ? "REALLOCATED" : "ALLOCATED";
  document.querySelector("#bloodlines-admin-submissions").textContent = `${submissionLabel} · ${submitted} / ${state.teams.length}`;
  document.querySelector("#bloodlines-admin-message").textContent = state.published
    ? "Final results are published to participants."
    : state.completed
      ? "All 80 simulation years are complete. Publish the final scoreboard when ready."
      : state.started
        ? state.stage === "news"
          ? `Release one shared news flash per year. ${state.newsRemaining} year${state.newsRemaining === 1 ? "" : "s"} remain in this sub-round.`
          : state.stage === "wheel"
            ? "Spin teams one at a time. Participants see the active spin and each completed outcome live."
            : state.stage === "reallocation"
              ? "Every team must save a post-Wheel reallocation before this sub-round can close."
              : "Collect each team's initial allocation before opening the annual news sequence."
        : "Configure nine consecutive year ranges that cover Years 1–80, then start with the registered teams.";

  const controls = {
    start: !state.started,
    begin_news: state.started && state.stage === "allocation" && state.teams.length > 0 && state.teams.every((team) => team.submitted),
    begin_wheel: state.started && state.stage === "news" && state.newsRemaining === 0,
    spin_next: state.started && state.stage === "wheel" && !state.wheel.current && state.wheel.entries.some((entry) => entry.status === "waiting"),
    close_subround: state.started && state.stage === "reallocation" && state.teams.length > 0 && state.teams.every((team) => team.reallocated),
    publish: state.completed && !state.published
  };
  document.querySelectorAll("[data-bloodlines-action]").forEach((button) => {
    button.hidden = !controls[button.dataset.bloodlinesAction];
    button.disabled = button.dataset.bloodlinesAction === "spin_next" && Boolean(state.wheel.current);
  });

  const scheduleForm = document.querySelector("#bloodlines-schedule-form");
  scheduleForm.hidden = state.started;
  const scheduleRanges = document.querySelector("#bloodlines-schedule-ranges");
  if (!scheduleForm.dataset.dirty) {
    scheduleRanges.replaceChildren(...state.schedule.map((range, index) => {
      const row = document.createElement("label");
      row.className = "bloodlines-schedule-range";
      const caption = document.createElement("span");
      caption.textContent = `SUB-ROUND ${String(index + 1).padStart(2, "0")}`;
      const start = document.createElement("input");
      start.type = "number";
      start.name = `start-${index}`;
      start.min = "1";
      start.max = "80";
      start.value = range.start;
      start.setAttribute("aria-label", `Sub-round ${index + 1} start year`);
      const end = document.createElement("input");
      end.type = "number";
      end.name = `end-${index}`;
      end.min = "1";
      end.max = "80";
      end.value = range.end;
      end.setAttribute("aria-label", `Sub-round ${index + 1} end year`);
      row.append(caption, start, end);
      return row;
    }));
  }
  const newsForm = document.querySelector("#bloodlines-news-form");
  newsForm.hidden = !state.started || state.stage !== "news" || state.newsRemaining === 0;
  document.querySelector("#bloodlines-news-label").textContent = `YEAR ${state.year} NEWS FLASH`;

  const scoreByTeam = new Map((scoreboard?.teams || []).map((team) => [team.team, team.score]));
  const teamList = document.querySelector("#bloodlines-admin-teams");
  teamList.replaceChildren();
  for (const team of state.teams) {
    const row = document.createElement("div");
    row.className = "bloodlines-admin-team";
    const name = document.createElement("strong");
    name.textContent = team.name;
    const submission = document.createElement("span");
    const spin = state.wheel.entries.find((entry) => entry.team === team.name);
    if (state.stage === "wheel") submission.textContent = spin?.status?.toUpperCase() || "WAITING";
    else if (state.stage === "reallocation") submission.textContent = team.reallocated ? "REALLOCATION SAVED" : "AWAITING REALLOCATION";
    else submission.textContent = team.submitted ? "ALLOCATION SAVED" : "AWAITING ALLOCATION";
    const balance = document.createElement("span");
    balance.textContent = `CASH ${formatRupees(team.cash)} · DEBT ${formatRupees(team.debt)}`;
    row.append(name, submission, balance);
    if (state.published) {
      const score = document.createElement("b");
      score.textContent = formatRupees(scoreByTeam.get(team.name));
      row.append(score);
    }
    teamList.append(row);
  }
  const wheelBoard = document.querySelector("#bloodlines-admin-wheel");
  const currentSpin = state.wheel.current;
  const currentIndicator = document.querySelector("#bloodlines-admin-wheel-current");
  currentIndicator.hidden = !currentSpin;
  currentIndicator.lastChild.textContent = currentSpin ? ` ${currentSpin.team} SPINNING` : " SPINNING";
  wheelBoard.replaceChildren(...state.wheel.entries.map((entry) => {
    const row = document.createElement("div");
    row.className = `bloodlines-wheel-entry${entry.status === "spinning" ? " is-spinning" : ""}`;
    const spinner = document.createElement("span");
    spinner.className = "wheel-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const name = document.createElement("strong");
    name.textContent = entry.team;
    const status = document.createElement("span");
    status.textContent = entry.status.toUpperCase();
    row.append(spinner, name, status);
    if (entry.outcome) {
      const result = document.createElement("b");
      result.textContent = `${entry.outcome.name} · ${formatRupees(entry.outcome.effect)}`;
      row.append(result);
    }
    return row;
  }));
  const audit = document.querySelector("#bloodlines-audit-log");
  audit.replaceChildren(...(state.auditLog || []).slice().reverse().map((entry) => {
    const item = document.createElement("li");
    item.textContent = `${entry.at} · ${entry.actor} · ${entry.action} · ${entry.target}`;
    return item;
  }));
}

async function refreshBloodlines() {
  try {
    const state = await api("/api/bloodlines/admin/state");
    const scoreboard = state.published || state.completed ? await api("/api/bloodlines/scoreboard") : null;
    renderBloodlinesAdmin(state, scoreboard);
  } catch (error) {
    if (error.message.includes("Sign in")) {
      clearInterval(adminState.poll);
      renderLogin();
      return;
    }
    showToast(error.message);
  }
}

async function runBloodlinesAction(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api("/api/bloodlines/admin/advance", {
      method: "POST",
      body: JSON.stringify({ action: button.dataset.bloodlinesAction })
    });
    await refreshBloodlines();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function saveBloodlinesSchedule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const schedule = [...form.querySelectorAll(".bloodlines-schedule-range")].map((row) => ({
    start: Number(row.querySelector('[name^="start-"]').value),
    end: Number(row.querySelector('[name^="end-"]').value)
  }));
  try {
    await api("/api/bloodlines/admin/advance", {
      method: "POST",
      body: JSON.stringify({ action: "configure_schedule", schedule })
    });
    form.dataset.dirty = "";
    setFormMessage(form, "Year ranges saved.");
    await refreshBloodlines();
  } catch (error) {
    setFormMessage(form, error.message, true);
  }
}

async function releaseBloodlinesNews(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/bloodlines/admin/advance", {
      method: "POST",
      body: JSON.stringify({ action: "release_news", text: form.elements.text.value })
    });
    form.reset();
    setFormMessage(form, "News released to all teams.");
    await refreshBloodlines();
  } catch (error) {
    setFormMessage(form, error.message, true);
  } finally {
    button.disabled = false;
  }
}

function startPolling() {
  clearInterval(adminState.poll);
  refreshDashboard();
  adminState.poll = setInterval(() => {
    if (document.visibilityState === "visible") refreshDashboard();
  }, 2000);
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  setFormMessage(form, "Signing in…", false);
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: new FormData(form).get("password") })
    });
    adminState.data = await api("/api/admin/events");
    renderDashboard();
    startPolling();
  } catch (error) {
    setFormMessage(form, error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try {
    await api("/api/admin/logout", { method: "POST", body: "{}" });
    clearInterval(adminState.poll);
    renderLogin();
    document.querySelector("#admin-dashboard").hidden = true;
  } catch (error) {
    showToast(error.message);
  }
}

async function settleBankingDecade() {
  const button = document.querySelector("#banking-settle-decade");
  button.disabled = true;
  try {
    await api("/api/admin/banking/settle-decade", { method: "POST", body: "{}" });
    await refreshDashboard();
    showToast("Decade settled; cash growth and company outcomes are recorded.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function closeRoundOne() {
  const button = document.querySelector("#round-one-closeout-submit");
  if (!adminState.qualificationSelection.size) return;
  const forceEarlyClose = !adminState.qualification?.canClose;
  const confirmText = forceEarlyClose
    ? "End Round 1 early and lock the current qualifier list now?"
    : "End Round 1 and permanently lock this Bloodlines qualifier list?";
  if (!window.confirm(confirmText)) return;
  button.disabled = true;
  try {
    await api("/api/admin/round-one/close", {
      method: "POST",
      body: JSON.stringify({
        qualifierKeys: [...adminState.qualificationSelection],
        forceEarlyClose
      })
    });
    await refreshDashboard();
    showToast(forceEarlyClose
      ? "Round 1 ended early; Bloodlines qualifiers are locked."
      : "Round 1 closed; Bloodlines qualifiers are locked.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = adminState.qualification?.locked || adminState.qualificationSelection.size === 0;
  }
}

async function decideLoanAsAdmin(event) {
  const button = event.target.closest("[data-admin-loan-decision]");
  if (!button) return;
  const comments = document.querySelector(`[data-admin-loan-comment="${button.dataset.loanId}"]`).value;
  button.disabled = true;
  try {
    await api(`/api/admin/loans/${button.dataset.loanId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: button.dataset.adminLoanDecision, comments })
    });
    adminState.loanCommentDrafts.delete(button.dataset.loanId);
    await refreshDashboard();
    showToast(button.dataset.adminLoanDecision === "approved" ? "Loan approved and funded." : "Loan request rejected.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function initialize() {
  document.querySelector("#admin-login").addEventListener("submit", login);
  const control = document.querySelector("#auction-control-form");
  control.elements.companyId.addEventListener("change", () => { adminState.editingSelection = true; });
  document.querySelector("#team-create-form").addEventListener("submit", createTeam);
  control.addEventListener("submit", openAuction);
  document.querySelector("#close-auction").addEventListener("click", closeAuction);
  document.querySelector("#admin-refresh").addEventListener("click", refreshDashboard);
  document.querySelector("#banking-settle-decade").addEventListener("click", settleBankingDecade);
  document.querySelector("#round-one-closeout-submit").addEventListener("click", closeRoundOne);
  document.querySelector("#round-one-qualifier-list").addEventListener("change", (event) => {
    if (!event.target.matches("[data-qualifier-key]")) return;
    const key = event.target.dataset.qualifierKey;
    if (event.target.checked) adminState.qualificationSelection.add(key);
    else adminState.qualificationSelection.delete(key);
    document.querySelector("#round-one-closeout-submit").disabled =
      !adminState.qualification?.canClose || adminState.qualificationSelection.size === 0;
  });
  document.querySelector("#admin-loans-refresh").addEventListener("click", refreshDashboard);
  document.querySelector("#admin-loan-list").addEventListener("click", decideLoanAsAdmin);
  document.querySelector("#admin-logout").addEventListener("click", logout);
  document.querySelector("#bloodlines-admin-logout").addEventListener("click", logout);
  document.querySelector("#bloodlines-admin-refresh").addEventListener("click", refreshBloodlines);
  document.querySelectorAll("[data-bloodlines-action]").forEach((button) => button.addEventListener("click", runBloodlinesAction));
  const scheduleForm = document.querySelector("#bloodlines-schedule-form");
  scheduleForm.addEventListener("input", () => { scheduleForm.dataset.dirty = "true"; });
  scheduleForm.addEventListener("submit", saveBloodlinesSchedule);
  document.querySelector("#bloodlines-news-form").addEventListener("submit", releaseBloodlinesNews);
  document.addEventListener("banks-round-change", () => {
    applyRoundMode();
    if (adminState.authenticated) refreshDashboard();
  });
  applyRoundMode();
  try {
    const session = await api("/api/auth/session");
    if (session.authenticated && session.role === "admin") {
      adminState.data = await api("/api/admin/events");
      renderDashboard();
      startPolling();
    }
  } catch (error) {
    setFormMessage(document.querySelector("#admin-login"), error.message, true);
  }
}

initialize();
