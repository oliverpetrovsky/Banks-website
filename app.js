const state = {
  data: null,
  role: null,
  team: null,
  auction: null,
  activeCompanyId: null,
  adminPoll: null,
  participantPoll: null,
  toastTimeout: null
};

const formatRupees = (amount) => `₹${Number(amount).toLocaleString("en-IN")}`;
const getEra = (id) => state.data.eras.find((era) => era.id === id);

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

function setAuctionStatus(text, mode = "") {
  const statusText = document.querySelector("#round-status-text");
  const roundStatus = document.querySelector("#round-status");
  const auctionLabel = document.querySelector("#auction-status-label");
  statusText.textContent = text;
  auctionLabel.textContent = text;
  roundStatus.classList.toggle("is-open", mode === "open");
  roundStatus.classList.toggle("is-closed", mode === "closed");
  document.querySelector(".auction-status-card").classList.toggle("is-open", mode === "open");
  document.querySelector(".auction-status-card").classList.toggle("is-closed", mode === "closed");
}

function setParticipantView(authenticated) {
  document.querySelector("#participant-login-card").hidden = authenticated;
  document.querySelector("#participant-desk").hidden = !authenticated;
}

function setAdminLoginMessage(message, isError = true) {
  const form = document.querySelector("#admin-login");
  const output = form?.querySelector(".form-message");
  if (!output) return;
  output.textContent = message;
  output.classList.toggle("is-error", isError);
}

function bvi(principal, rate, company) {
  if (!company || !Number.isFinite(principal) || !Number.isFinite(rate)
      || principal < company.minimumPrincipal
      || principal > state.data.rules.singleBidLimit
      || principal % 10000 !== 0
      || rate < 0
      || rate > company.maximumRate
      || Math.round(rate * 100) % 50 !== 0) return null;
  return (principal / company.principalRequired)
    * ((company.maximumRate - rate) / company.maximumRate);
}

function renderActiveDeal(data) {
  const company = data.company;
  const waiting = document.querySelector("#auction-waiting");
  const deal = document.querySelector("#active-deal");
  const isOpen = data.status === "open" && company;

  if (!company || data.status === "waiting") {
    waiting.hidden = false;
    deal.hidden = true;
    state.activeCompanyId = null;
    setAuctionStatus("WAITING FOR THE AUCTION TO BEGIN");
    return;
  }

  waiting.hidden = true;
  deal.hidden = false;
  setAuctionStatus(
    isOpen ? `BIDDING OPEN · ${company.name}` : `BIDDING CLOSED · ${company.name}`,
    isOpen ? "open" : "closed"
  );
  const isNewCompany = state.activeCompanyId !== company.id;
  state.activeCompanyId = company.id;

  if (isNewCompany) {
    const form = document.querySelector("#bid-form");
    delete form.dataset.hasSubmitted;
    delete form.dataset.userEditing;
    document.querySelector("#deal-meta").textContent = `${company.id} · ${company.eraName} · ${company.decade}`;
    document.querySelector("#deal-name").textContent = company.name;
    document.querySelector("#deal-sector").textContent = company.sector;
    document.querySelector("#deal-summary").textContent = company.summary;
    document.querySelector("#deal-financials").innerHTML = `
      <div><span>CAPITAL REQUESTED</span><strong>${formatRupees(company.principalRequired)}</strong></div>
      <div><span>MINIMUM BID</span><strong>${formatRupees(company.minimumPrincipal)}</strong></div>
      <div><span>MAX. INTEREST</span><strong>${company.maximumRate}%</strong></div>`;

    form.elements.principal.min = String(company.minimumPrincipal);
    form.elements.principal.max = String(state.data.rules.singleBidLimit);
    form.elements.principal.value = data.myBid?.principal || company.minimumPrincipal;
    form.elements.ratePercent.min = "0";
    form.elements.ratePercent.max = String(company.maximumRate);
    form.elements.ratePercent.value = data.myBid?.ratePercent ?? Math.min(8, company.maximumRate);
  } else if (data.myBid && !document.querySelector("#bid-form").dataset.hasSubmitted
      && !document.querySelector("#bid-form").dataset.userEditing) {
    document.querySelector("#bid-form").elements.principal.value = data.myBid.principal;
    document.querySelector("#bid-form").elements.ratePercent.value = data.myBid.ratePercent;
  }

  const form = document.querySelector("#bid-form");
  form.elements.principal.disabled = !isOpen;
  form.elements.ratePercent.disabled = !isOpen;
  form.querySelector(".bid-submit").disabled = !isOpen;
  document.querySelector("#bid-form-heading span:last-child").textContent = isOpen
    ? "Adjust either number to preview your BVI before submitting."
    : "This auction is closed. Your submitted bid remains on the board.";
  renderParticipantLeaderboard(data.leaderboard || [], data.myBid);
  updateBviPreview();
}

function renderParticipantLeaderboard(bids, myBid) {
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
    const team = document.createElement("strong");
    team.textContent = bid.team;
    const offer = document.createElement("small");
    offer.textContent = `${formatRupees(bid.principal)} · ${bid.ratePercent}% p.a.`;
    details.append(team, offer);
    const score = document.createElement("span");
    score.className = "rank-bvi";
    score.textContent = bid.bvi.toFixed(4);
    item.append(rank, details, score);
    list.append(item);
  });
}

function compareOffers(a, b) {
  const scoreDifference = Math.round(b.bvi * 10000) - Math.round(a.bvi * 10000);
  if (scoreDifference) return scoreDifference;
  if (a.ratePercent !== b.ratePercent) return a.ratePercent - b.ratePercent;
  return a.submittedAt - b.submittedAt;
}

function updateBviPreview() {
  const data = state.auction;
  const company = data?.company;
  const form = document.querySelector("#bid-form");
  if (!company || form.hidden) return;
  const principal = Number(form.elements.principal.value);
  const rate = Number(form.elements.ratePercent.value);
  const score = bvi(principal, rate, company);
  const scoreElement = document.querySelector("#bvi-value");
  const rankElement = document.querySelector("#rank-preview");
  if (score === null) {
    scoreElement.textContent = "—";
    scoreElement.classList.remove("is-positive");
    rankElement.textContent = "Meet the minimum bid and use ₹10,000 principal and 0.5% rate increments to preview your rank.";
    return;
  }
  const roundedScore = Number(score.toFixed(4));
  scoreElement.textContent = roundedScore.toFixed(4);
  scoreElement.classList.toggle("is-positive", roundedScore > 0);

  const ownBid = data.myBid;
  const candidates = (data.leaderboard || [])
    .filter((bid) => !ownBid || bid.team !== ownBid.team)
    .map((bid) => ({ ...bid, submittedAt: new Date(bid.submittedAt).getTime() }));
  candidates.push({
    team: state.team,
    principal,
    ratePercent: rate,
    bvi: roundedScore,
    submittedAt: Date.now()
  });
  candidates.sort(compareOffers);
  const rank = candidates.findIndex((bid) => bid.team === state.team) + 1;
  rankElement.textContent = `Projected position: #${rank} of ${candidates.length} ${candidates.length === 1 ? "bid" : "bids"}.`;
}

async function loadParticipantState() {
  try {
    const data = await api("/api/auction");
    state.auction = data;
    renderActiveDeal(data);
  } catch (error) {
    if (error.message.startsWith("Sign in")) {
      state.role = null;
      state.team = null;
      clearInterval(state.participantPoll);
      setParticipantView(false);
    } else {
      showToast(error.message);
    }
  }
}

function startParticipantPolling() {
  clearInterval(state.participantPoll);
  loadParticipantState();
  state.participantPoll = setInterval(() => {
    if (document.visibilityState === "visible") loadParticipantState();
  }, 2000);
}

async function submitBid(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector("#bid-message");
  const company = state.auction?.company;
  if (!company || state.auction.status !== "open") return;
  const principal = Number(form.elements.principal.value);
  const ratePercent = Number(form.elements.ratePercent.value);
  const button = form.querySelector(".bid-submit");
  button.disabled = true;
  message.textContent = "Submitting your bid…";
  message.classList.remove("is-error");
  try {
    const result = await api("/api/bids", {
      method: "POST",
      body: JSON.stringify({ principal, ratePercent })
    });
    form.dataset.hasSubmitted = "true";
    message.textContent = `Bid submitted. Your BVI is ${result.bvi.toFixed(4)}; current position is #${result.rank}. You can update your bid while this auction remains open.`;
    await loadParticipantState();
    showToast("Your bid is on the live leaderboard.");
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("is-error");
    await loadParticipantState();
  } finally {
    button.disabled = state.auction?.status !== "open";
  }
}

function renderLoginForm() {
  const form = document.querySelector("#participant-login");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    const message = form.querySelector(".form-message");
    const values = new FormData(form);
    button.disabled = true;
    message.textContent = "Signing in…";
    message.classList.remove("is-error");
    try {
      const result = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          team: values.get("team"),
          code: values.get("code")
        })
      });
      state.role = "participant";
      state.team = result.team;
      document.querySelector("#participant-team-name").textContent = result.team;
      setParticipantView(true);
      form.reset();
      startParticipantPolling();
    } catch (error) {
      message.textContent = error.message;
      message.classList.add("is-error");
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#participant-logout").addEventListener("click", async () => {
    await logout("/api/auth/logout");
    state.team = null;
    setParticipantView(false);
    setAuctionStatus("SIGN IN TO JOIN THE AUCTION");
  });
  const bidForm = document.querySelector("#bid-form");
  bidForm.addEventListener("submit", submitBid);
  bidForm.elements.principal.addEventListener("input", () => {
    bidForm.dataset.userEditing = "true";
    updateBviPreview();
  });
  bidForm.elements.ratePercent.addEventListener("input", () => {
    bidForm.dataset.userEditing = "true";
    updateBviPreview();
  });
}

function renderAdminLogin() {
  const container = document.querySelector("#admin-content");
  container.innerHTML = `
    <form id="admin-login" class="admin-login">
      <label><span>ADMIN PASSWORD</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="button button-dark" type="submit">ADMIN SIGN-IN <span aria-hidden="true">→</span></button>
      <p class="form-message" aria-live="polite"></p>
    </form>
    <p class="admin-hint">Participant access codes and the leaderboard are managed here.</p>`;
  container.querySelector("form").addEventListener("submit", loginAdmin);
}

async function loginAdmin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const message = form.querySelector(".form-message");
  const password = new FormData(form).get("password");
  button.disabled = true;
  message.textContent = "Signing in…";
  message.classList.remove("is-error");
  try {
    await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
    state.role = "admin";
    renderAdminDashboard();
    startAdminPolling();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("is-error");
  } finally {
    button.disabled = false;
  }
}

function renderAdminDashboard() {
  const container = document.querySelector("#admin-content");
  container.innerHTML = `
    <div class="admin-toolbar">
      <div><h3>Live auction control</h3><p id="admin-auction-status">Loading auction status…</p></div>
      <div class="admin-actions"><button class="button button-ghost" id="admin-refresh" type="button">REFRESH</button><button class="button button-outline" id="admin-logout" type="button">SIGN OUT</button></div>
    </div>
    <div class="admin-setup-grid">
      <form id="team-create-form" class="admin-panel">
        <span class="panel-index">01 / TEAM ACCESS</span><h4>Issue a team code</h4>
        <p>Create one account for each registered team. Share the generated access code privately with that team.</p>
        <label><span>TEAM NAME</span><input name="name" maxlength="35" required placeholder="Registered team name"></label>
        <button class="button button-primary" type="submit">CREATE TEAM CODE <span aria-hidden="true">→</span></button>
        <div id="team-code-result" class="team-code-result" hidden></div>
        <p class="form-message" aria-live="polite"></p>
      </form>
      <form id="auction-control-form" class="admin-panel">
        <span class="panel-index">02 / LIVE DEAL</span><h4>Choose the next company</h4>
        <p>Open one company at a time. Teams can adjust their offers until you close the auction or open the next deal.</p>
        <label><span>ERA</span><select name="era"></select></label>
        <label><span>COMPANY</span><select name="companyId"></select></label>
        <div class="admin-actions"><button class="button button-primary" type="submit">START / SWITCH COMPANY</button><button class="button button-danger" id="close-auction" type="button">CLOSE AUCTION</button></div>
        <p class="form-message" aria-live="polite"></p>
      </form>
    </div>
    <div class="admin-board-heading"><div><span class="panel-index">03 / LIVE STANDINGS</span><h4 id="admin-board-title">Leaderboard</h4></div><span class="live-indicator"><i></i> UPDATING LIVE</span></div>
    <p id="admin-board-caption" class="admin-hint">Open an auction to display its live leaderboard.</p>
    <div id="admin-live-board" class="admin-live-board"></div>`;

  const eraSelect = container.querySelector('[name="era"]');
  state.data.eras.forEach((era) => {
    const option = document.createElement("option");
    option.value = era.id;
    option.textContent = era.name;
    eraSelect.append(option);
  });
  const companySelect = container.querySelector('[name="companyId"]');
  const renderCompanyOptions = () => {
    const eraCompanies = state.data.companies.filter((company) => company.era === eraSelect.value);
    companySelect.replaceChildren(...eraCompanies.map((company) => {
      const option = document.createElement("option");
      option.value = company.id;
      option.textContent = `${company.id} · ${company.name}`;
      return option;
    }));
  };
  eraSelect.addEventListener("change", renderCompanyOptions);
  eraSelect.addEventListener("change", () => {
    container.querySelector("#auction-control-form").dataset.userChangedSelection = "true";
  });
  companySelect.addEventListener("change", () => {
    container.querySelector("#auction-control-form").dataset.userChangedSelection = "true";
  });
  renderCompanyOptions();
  container.querySelector("#team-create-form").addEventListener("submit", createTeam);
  container.querySelector("#auction-control-form").addEventListener("submit", openAuction);
  container.querySelector("#close-auction").addEventListener("click", closeAuction);
  container.querySelector("#admin-refresh").addEventListener("click", loadAdminState);
  container.querySelector("#admin-logout").addEventListener("click", async () => {
    await logout("/api/admin/logout");
    state.role = null;
    clearInterval(state.adminPoll);
    renderAdminLogin();
  });
}

async function createTeam(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const message = form.querySelector(".form-message");
  const result = document.querySelector("#team-code-result");
  const name = new FormData(form).get("name");
  button.disabled = true;
  message.textContent = "Creating team access…";
  message.classList.remove("is-error");
  try {
    const created = await api("/api/admin/teams", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    result.hidden = false;
    result.replaceChildren();
    const label = document.createElement("span");
    label.textContent = `Access code for ${created.team} — share privately; it will not be shown again:`;
    const code = document.createElement("strong");
    code.textContent = created.accessCode;
    result.append(label, code);
    form.reset();
    message.textContent = "Team account created.";
    await loadAdminState();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("is-error");
  } finally {
    button.disabled = false;
  }
}

async function setAuction(status) {
  const form = document.querySelector("#auction-control-form");
  const message = form.querySelector(".form-message");
  const body = { status };
  if (status === "open") {
    body.era = form.elements.era.value;
    body.companyId = form.elements.companyId.value;
  }
  try {
    await api("/api/admin/auction", { method: "POST", body: JSON.stringify(body) });
    message.textContent = status === "open" ? "Company auction is now live." : "Auction closed.";
    message.classList.remove("is-error");
    delete form.dataset.userChangedSelection;
    await loadAdminState();
    showToast(status === "open" ? "The company is open for bids." : "The auction is closed.");
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("is-error");
  }
}

function openAuction(event) {
  event.preventDefault();
  return setAuction("open");
}

function closeAuction() {
  return setAuction("closed");
}

function renderAdminLeaderboard(data) {
  const board = document.querySelector("#admin-live-board");
  const title = document.querySelector("#admin-board-title");
  const caption = document.querySelector("#admin-board-caption");
  const active = data.leaderboard.find((item) =>
    item.company.id === data.auction.companyId && item.company.era === data.auction.era
  );
  if (!active) {
    title.textContent = "No company auction selected";
    caption.textContent = `${data.teamCount} team accounts issued · ${data.validBidCount} bids recorded. Select a company and start the auction to show live standings.`;
    board.replaceChildren();
    return;
  }
  title.textContent = `${active.company.id} · ${active.company.name}`;
  caption.textContent = `${getEra(active.company.era).name} · ${data.auction.status === "open" ? "Bidding is open" : "Bidding is closed"} · ${active.bids.length} bids`;
  board.replaceChildren();
  const control = document.querySelector("#auction-control-form");
  if (!control.dataset.userChangedSelection) {
    control.elements.era.value = data.auction.era;
    control.elements.companyId.value = data.auction.companyId;
  }
  if (!active.bids.length) {
    const empty = document.createElement("p");
    empty.className = "admin-empty";
    empty.textContent = "No bids yet. The standings will update as teams submit offers.";
    board.append(empty);
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
  active.bids.forEach((bid) => {
    const row = document.createElement("div");
    row.className = "leaderboard-row";
    const values = [
      String(bid.rank).padStart(2, "0"),
      bid.team,
      formatRupees(bid.principal),
      `${bid.ratePercent}%`,
      bid.bvi.toFixed(4)
    ];
    values.forEach((value, index) => {
      const cell = document.createElement("span");
      cell.textContent = value;
      if (index === 0) cell.className = "rank-number";
      if (index === 1) cell.className = "rank-team-name";
      if (index === 4) cell.className = "rank-bvi";
      row.append(cell);
    });
    table.append(row);
  });
  board.append(table);
}

async function loadAdminState() {
  try {
    const auction = await api("/api/auction");
    state.auction = auction;
    document.querySelector("#admin-auction-status").textContent =
      auction.company && auction.status !== "waiting"
        ? `${auction.status === "open" ? "BIDDING OPEN" : "BIDDING CLOSED"} · ${auction.company.name}`
        : "Auction is waiting to start.";
    const fullBoard = await api(`/api/admin/leaderboard?era=${encodeURIComponent(auction.era || state.data.eras[0].id)}`);
    renderAdminLeaderboard(fullBoard);
    if (auction.company) {
      const control = document.querySelector("#auction-control-form");
      if (!control.dataset.userChangedSelection) {
        control.elements.era.value = auction.era;
        const eraEvent = new Event("change");
        control.elements.era.dispatchEvent(eraEvent);
        control.elements.companyId.value = auction.company.id;
        delete control.dataset.userChangedSelection;
      }
    }
    setAuctionStatus(
      auction.status === "open" && auction.company
        ? `BIDDING OPEN · ${auction.company.name}`
        : auction.status === "closed" && auction.company
          ? `BIDDING CLOSED · ${auction.company.name}`
          : "WAITING FOR THE AUCTION TO BEGIN",
      auction.status
    );
  } catch (error) {
    if (error.message.startsWith("Sign in")) {
      state.role = null;
      clearInterval(state.adminPoll);
      renderAdminLogin();
      return;
    }
    showToast(error.message);
  }
}

function startAdminPolling() {
  clearInterval(state.adminPoll);
  loadAdminState();
  state.adminPoll = setInterval(() => {
    if (document.visibilityState === "visible") loadAdminState();
  }, 2000);
}

async function logout(endpoint) {
  try {
    await api(endpoint, { method: "POST", body: "{}" });
  } catch (error) {
    showToast(error.message);
  }
}

function setPageSession(session) {
  if (!session.authenticated) return;
  state.role = session.role;
  if (session.role === "participant") {
    state.team = session.team;
    document.querySelector("#participant-team-name").textContent = session.team;
    setParticipantView(true);
    startParticipantPolling();
  } else {
    renderAdminDashboard();
    startAdminPolling();
  }
}

async function initialize() {
  renderLoginForm();
  renderAdminLogin();
  try {
    state.data = await api("/api/events");
    document.querySelector("#vault-value").textContent = formatRupees(state.data.rules.vaultCapital);
    const session = await api("/api/auth/session");
    setPageSession(session);
    if (!session.authenticated) setAuctionStatus("SIGN IN TO JOIN THE AUCTION");
  } catch (error) {
    setAuctionStatus("AUCTION INFORMATION UNAVAILABLE", "closed");
    showToast(error.message);
  }
}

initialize();
