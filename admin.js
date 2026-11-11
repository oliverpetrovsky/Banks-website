const adminState = {
  data: null,
  poll: null,
  editingSelection: false,
  authenticated: false
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
  document.querySelector("#admin-login-card").hidden = false;
  document.querySelector("#admin-dashboard").hidden = true;
  document.querySelector("#bloodlines-admin-panel").hidden = true;
}

function renderDashboard() {
  adminState.authenticated = true;
  document.querySelector("#admin-login-card").hidden = true;
  const eraSelect = document.querySelector("#auction-control-form select[name=era]");
  eraSelect.replaceChildren(...adminState.data.eras.map((era) => {
    const option = document.createElement("option");
    option.value = era.id;
    option.textContent = era.name;
    return option;
  }));
  refreshCompanySelect();
  applyRoundMode();
}

function applyRoundMode() {
  const isRoundTwo = document.body.dataset.round === "2";
  document.querySelector("#admin-dashboard").hidden = isRoundTwo || !adminState.authenticated;
  document.querySelector("#bloodlines-admin-panel").hidden = !isRoundTwo || !adminState.authenticated;
  const form = document.querySelector("#auction-control-form");
  form.elements.era.disabled = isRoundTwo;
  form.elements.companyId.disabled = isRoundTwo;
  form.querySelector('button[type="submit"]').disabled = isRoundTwo;
  document.querySelector("#close-auction").disabled = isRoundTwo;
  if (isRoundTwo && adminState.authenticated) refreshBloodlines();
}

function refreshCompanySelect(selectedId = "") {
  const form = document.querySelector("#auction-control-form");
  const era = form.elements.era.value;
  const companies = adminState.data.companies.filter((company) => company.era === era);
  const select = form.elements.companyId;
  select.replaceChildren(...companies.map((company) => {
    const option = document.createElement("option");
    option.value = company.id;
    option.textContent = `${company.id} · ${company.name}`;
    return option;
  }));
  if (selectedId && companies.some((company) => company.id === selectedId)) select.value = selectedId;
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
    item.textContent = team.name;
    return item;
  }));
}

function renderStandings(auction, board) {
  const status = document.querySelector("#admin-auction-status");
  const title = document.querySelector("#admin-board-title");
  const caption = document.querySelector("#admin-board-caption");
  const target = document.querySelector("#admin-live-board");
  renderTeams(board.teams);

  if (!auction.company) {
    status.textContent = "Waiting for an auction.";
    title.textContent = "No company selected";
    caption.textContent = "Choose a company and start the auction. The team leaderboard will appear here.";
    target.replaceChildren();
    return;
  }

  const company = auction.company;
  status.textContent = `${auction.status === "open" ? "BIDDING OPEN" : "BIDDING CLOSED"} · ${company.name}`;
  title.textContent = `${company.id} · ${company.name}`;
  caption.textContent = `${auction.leaderboard.length} bids · ${auction.status === "open" ? "Open — standings update as teams bid." : "Closed — top bid is the confirmed winner."}`;

  const control = document.querySelector("#auction-control-form");
  if (!adminState.editingSelection) {
    control.elements.era.value = company.era;
    refreshCompanySelect(company.id);
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

async function refreshDashboard() {
  try {
    if (document.body.dataset.round === "2") {
      await refreshBloodlines();
      return;
    }
    const [auction, teamData] = await Promise.all([
      api("/api/auction"),
      api("/api/admin/teams")
    ]);
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
    ? `Year ${state.year} · Stage ${state.stage} · ${state.stageName.replaceAll("_", " ")}`
    : "Waiting to start";
  document.querySelector("#bloodlines-admin-year").textContent = state.started ? String(state.year) : "—";
  document.querySelector("#bloodlines-admin-stage").textContent = state.started
    ? `${state.stage} / 5 · ${state.stageName.replaceAll("_", " ").toUpperCase()}`
    : "NOT STARTED";
  const submitted = state.teams.filter((team) => team.submitted).length;
  document.querySelector("#bloodlines-admin-submissions").textContent = `${submitted} / ${state.teams.length}`;
  document.querySelector("#bloodlines-admin-message").textContent = state.published
    ? "Final results are published to participants."
    : state.yearComplete
      ? "All four years are complete. Publish the final scoreboard when ready."
      : state.started
        ? `Year ${state.year}, stage ${state.stage}. Market ${state.marketRevealed ? "revealed" : "not yet revealed"}; event ${state.wheelEvent || (state.eventAssigned ? "assigned (hidden until Stage 5)" : "not assigned")}.`
        : "Start the simulation once all teams are registered.";

  const controls = {
    start: !state.started,
    advance_stage: state.started && state.stage < 5 && !state.yearComplete,
    close_year: state.started && state.stage === 5 && !state.yearComplete,
    publish: state.yearComplete && !state.published
  };
  document.querySelectorAll("[data-bloodlines-action]").forEach((button) => {
    button.hidden = !controls[button.dataset.bloodlinesAction];
    button.disabled = false;
  });

  const scoreByTeam = new Map((scoreboard?.teams || []).map((team) => [team.team, team.score]));
  const teamList = document.querySelector("#bloodlines-admin-teams");
  teamList.replaceChildren();
  for (const team of state.teams) {
    const row = document.createElement("div");
    row.className = "bloodlines-admin-team";
    const name = document.createElement("strong");
    name.textContent = team.name;
    const submission = document.createElement("span");
    submission.textContent = team.submitted ? "ALLOCATION SAVED" : "AWAITING ALLOCATION";
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
    const scoreboard = state.published || state.yearComplete ? await api("/api/bloodlines/scoreboard") : null;
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

async function initialize() {
  document.querySelector("#admin-login").addEventListener("submit", login);
  const control = document.querySelector("#auction-control-form");
  control.elements.era.addEventListener("change", () => {
    adminState.editingSelection = true;
    refreshCompanySelect();
  });
  control.elements.companyId.addEventListener("change", () => { adminState.editingSelection = true; });
  document.querySelector("#team-create-form").addEventListener("submit", createTeam);
  control.addEventListener("submit", openAuction);
  document.querySelector("#close-auction").addEventListener("click", closeAuction);
  document.querySelector("#admin-refresh").addEventListener("click", refreshDashboard);
  document.querySelector("#admin-logout").addEventListener("click", logout);
  document.querySelector("#bloodlines-admin-logout").addEventListener("click", logout);
  document.querySelector("#bloodlines-admin-refresh").addEventListener("click", refreshBloodlines);
  document.querySelectorAll("[data-bloodlines-action]").forEach((button) => button.addEventListener("click", runBloodlinesAction));
  document.addEventListener("banks-round-change", () => {
    applyRoundMode();
    if (adminState.authenticated) refreshDashboard();
  });
  applyRoundMode();
  try {
    adminState.data = await api("/api/events");
    const session = await api("/api/auth/session");
    if (session.authenticated && session.role === "admin") {
      renderDashboard();
      startPolling();
    }
  } catch (error) {
    setFormMessage(document.querySelector("#admin-login"), error.message, true);
  }
}

initialize();
