const state = {
  data: null,
  activeEra: "ERA_1",
  admin: false,
  toastTimeout: null
};

const formatRupees = (amount) => `₹${Number(amount).toLocaleString("en-IN")}`;
const getCompany = (id) => state.data.companies.find((company) => company.id === id);

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(state.toastTimeout);
  state.toastTimeout = setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function renderEras() {
  const tabs = document.querySelector("#era-switch");
  tabs.replaceChildren(...state.data.eras.map((era, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "era-tab";
    button.id = `tab-${era.id}`;
    button.role = "tab";
    button.setAttribute("aria-selected", String(era.id === state.activeEra));
    button.setAttribute("aria-controls", "company-grid");
    button.textContent = `ERA 0${index + 1} · ${era.name}`;
    button.addEventListener("click", () => {
      state.activeEra = era.id;
      renderEras();
      renderCompanies();
      updateRoundStatus();
      if (state.admin) loadLeaderboard();
    });
    return button;
  }));
}

function updateRoundStatus() {
  const era = state.data.eras.find((item) => item.id === state.activeEra);
  const status = document.querySelector("#round-status-text");
  const indicator = status.parentElement;
  status.textContent = era.status === "open" ? "BIDDING IS OPEN" : "BIDDING IS CLOSED";
  indicator.classList.toggle("is-open", era.status === "open");
  indicator.classList.toggle("is-closed", era.status === "closed");
}

function renderCompanies() {
  const container = document.querySelector("#company-grid");
  const companies = state.data.companies.filter((company) => company.era === state.activeEra);
  const era = state.data.eras.find((item) => item.id === state.activeEra);
  container.replaceChildren(...companies.map((company) => {
    const card = document.createElement("article");
    card.className = `company-card${era.status === "closed" ? " is-closed" : ""}`;
    const header = document.createElement("div");
    header.className = "company-meta";
    header.innerHTML = `<span class="company-id">${company.id}</span><span>${company.decade}</span>`;
    const title = document.createElement("h3");
    title.className = "company-title";
    title.textContent = company.name;
    const sector = document.createElement("div");
    sector.className = "company-sector";
    sector.textContent = company.sector;
    const summary = document.createElement("p");
    summary.className = "company-summary";
    summary.textContent = company.summary;
    const ask = document.createElement("div");
    ask.className = "company-ask";
    ask.innerHTML = `<div><span>CAPITAL ASK</span><strong>${formatRupees(company.principalRequired)}</strong></div><div><span>MINIMUM BID</span><strong>${formatRupees(company.minimumPrincipal)}</strong></div><div><span>MAX. RATE</span><strong>${company.maximumRate}%</strong></div>`;
    const form = document.createElement("form");
    form.className = "bid-form";
    form.innerHTML = `
      <label><span>PRINCIPAL OFFERED</span><input name="principal" type="number" min="${company.minimumPrincipal}" max="${state.data.rules.singleBidLimit}" step="10000" placeholder="₹ amount" required ${era.status === "closed" ? "disabled" : ""}></label>
      <label><span>INTEREST RATE (%)</span><input name="ratePercent" type="number" min="0" max="${company.maximumRate}" step="0.5" placeholder="e.g. 8.5" required ${era.status === "closed" ? "disabled" : ""}></label>
      <button class="button" type="submit" ${era.status === "closed" ? "disabled" : ""}>PLACE BID <span aria-hidden="true">→</span></button>`;
    const message = document.createElement("p");
    message.className = "bid-message";
    message.setAttribute("aria-live", "polite");
    form.addEventListener("submit", (event) => submitBid(event, company, message));
    card.append(header, title, sector, summary, ask, form, message);
    return card;
  }));
}

function setBudget(committed) {
  const vault = state.data.rules.vaultCapital;
  const deployed = Math.min(committed, vault);
  document.querySelector("#deployed-value").innerHTML = `${formatRupees(deployed)} <small>OF ${formatRupees(vault)}</small>`;
  document.querySelector("#remaining-value").textContent = `${formatRupees(vault - deployed)} AVAILABLE`;
  document.querySelector("#meter-fill").style.width = `${(deployed / vault) * 100}%`;
}

async function submitBid(event, company, message) {
  event.preventDefault();
  const form = event.currentTarget;
  const team = document.querySelector("#team-name").value.trim();
  if (!team) {
    message.textContent = "Enter your team name above before placing a bid.";
    message.classList.add("is-error");
    document.querySelector("#team-name").focus();
    return;
  }
  const button = form.querySelector("button");
  const data = new FormData(form);
  button.disabled = true;
  message.textContent = "Submitting sealed bid…";
  message.classList.remove("is-error");
  try {
    const result = await api("/api/bids", {
      method: "POST",
      body: JSON.stringify({
        team,
        companyId: company.id,
        principal: Number(data.get("principal")),
        ratePercent: Number(data.get("ratePercent"))
      })
    });
    message.textContent = `Bid recorded · BVI ${result.bvi.toFixed(4)} · ${formatRupees(result.remaining)} remaining in this era’s vault.`;
    form.reset();
    setBudget(result.committed);
    showToast("Sealed bid received.");
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("is-error");
  } finally {
    button.disabled = state.data.eras.find((era) => era.id === state.activeEra).status !== "open";
  }
}

function renderAdmin(leaderboardData) {
  const container = document.querySelector("#admin-content");
  const era = state.data.eras.find((item) => item.id === state.activeEra);
  container.replaceChildren();

  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";
  const title = document.createElement("div");
  title.innerHTML = `<h3>Live bid leaderboard</h3><p>${era.name} · ${leaderboardData.status === "open" ? "Bidding open" : "Bidding closed"}</p>`;
  const actions = document.createElement("div");
  actions.className = "admin-actions";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = `button ${leaderboardData.status === "open" ? "button-danger" : "button-dark"}`;
  toggle.textContent = leaderboardData.status === "open" ? "CLOSE BIDDING" : "REOPEN BIDDING";
  toggle.addEventListener("click", () => changeEraStatus(leaderboardData.status === "open" ? "closed" : "open"));
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "button button-outline";
  refresh.textContent = "REFRESH";
  refresh.addEventListener("click", loadLeaderboard);
  const logout = document.createElement("button");
  logout.type = "button";
  logout.className = "button button-outline";
  logout.textContent = "SIGN OUT";
  logout.addEventListener("click", logoutAdmin);
  actions.append(toggle, refresh, logout);
  toolbar.append(title, actions);

  const summary = document.createElement("div");
  summary.className = "admin-summary";
  summary.innerHTML = `<span>VALID BIDS<strong>${leaderboardData.validBidCount}</strong></span><span>TEAMS<strong>${leaderboardData.teamCount}</strong></span><span>MIN. BIDS PER TEAM / ERA<strong>${state.data.rules.minimumDistinctBids}</strong></span>`;
  const grid = document.createElement("div");
  grid.className = "leaderboard";
  leaderboardData.leaderboard.forEach((company) => {
    const card = document.createElement("article");
    card.className = "leaderboard-card";
    const heading = document.createElement("h4");
    heading.textContent = company.name;
    const ask = document.createElement("small");
    ask.textContent = `${company.companyId} · Ask ${formatRupees(company.principalRequired)} · Max rate ${company.maximumRate}%`;
    heading.append(ask);
    card.append(heading);
    if (!company.bids.length) {
      const empty = document.createElement("p");
      empty.className = "admin-empty";
      empty.textContent = "No bids submitted yet.";
      card.append(empty);
    } else {
      const list = document.createElement("ol");
      company.bids.slice(0, 5).forEach((bid) => {
        const item = document.createElement("li");
        const rank = document.createElement("span");
        rank.className = "rank-number";
        rank.textContent = String(bid.rank).padStart(2, "0");
        const details = document.createElement("span");
        details.innerHTML = `<strong></strong><span class="rank-details"></span>`;
        details.querySelector("strong").textContent = bid.team;
        details.querySelector(".rank-details").textContent = `${formatRupees(bid.principal)} · ${bid.ratePercent}% p.a.`;
        const score = document.createElement("span");
        score.className = "rank-bvi";
        score.textContent = bid.bvi.toFixed(4);
        item.append(rank, details, score);
        list.append(item);
      });
      card.append(list);
    }
    grid.append(card);
  });
  const note = document.createElement("p");
  note.className = "admin-hint";
  note.textContent = "Ranked by BVI (highest first); ties go to the lower rate, then the earliest current submission. Only the top five bids per company are shown.";
  container.append(toolbar, summary, grid, note);
}

async function loadLeaderboard() {
  try {
    const data = await api(`/api/admin/leaderboard?era=${encodeURIComponent(state.activeEra)}`);
    const era = state.data.eras.find((item) => item.id === state.activeEra);
    era.status = data.status;
    updateRoundStatus();
    renderCompanies();
    renderAdmin(data);
  } catch (error) {
    if (error.message.includes("Admin sign-in")) {
      state.admin = false;
      renderAdminLogin();
      return;
    }
    showToast(error.message);
  }
}

async function changeEraStatus(status) {
  try {
    await api("/api/admin/era-status", {
      method: "POST",
      body: JSON.stringify({ era: state.activeEra, status })
    });
    state.data.eras.find((era) => era.id === state.activeEra).status = status;
    updateRoundStatus();
    renderCompanies();
    await loadLeaderboard();
    showToast(status === "open" ? "Bidding reopened." : "Bidding closed for this era.");
  } catch (error) {
    showToast(error.message);
  }
}

function renderAdminLogin() {
  const container = document.querySelector("#admin-content");
  container.innerHTML = `
    <form id="admin-login" class="admin-login">
      <label><span>ADMIN PASSWORD</span><input id="admin-password" type="password" autocomplete="current-password" required></label>
      <button class="button button-dark" type="submit">UNLOCK ADMIN DESK <span aria-hidden="true">→</span></button>
    </form>
    <p class="admin-hint">Leaderboard and bid details are visible to signed-in admins only.</p>`;
  container.querySelector("form").addEventListener("submit", loginAdmin);
}

async function loginAdmin(event) {
  event.preventDefault();
  const password = document.querySelector("#admin-password").value;
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
    state.admin = true;
    await loadLeaderboard();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function logoutAdmin() {
  try {
    await api("/api/admin/logout", { method: "POST", body: "{}" });
    state.admin = false;
    renderAdminLogin();
  } catch (error) {
    showToast(error.message);
  }
}

async function initialize() {
  try {
    state.data = await api("/api/events");
    renderEras();
    renderCompanies();
    updateRoundStatus();
    setBudget(0);
    document.querySelector("#admin-login").addEventListener("submit", loginAdmin);
  } catch (error) {
    document.querySelector("#company-grid").innerHTML = `<p class="empty-state">${error.message}</p>`;
    showToast(error.message);
  }
}

initialize();
