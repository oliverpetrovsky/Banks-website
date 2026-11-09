const teamState = {
  data: null,
  team: null,
  auction: null,
  companyId: null,
  poll: null,
  editingOffer: false
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
    const offer = document.createElement("small");
    offer.textContent = `${formatRupees(bid.principal)} · ${bid.ratePercent}% p.a.`;
    details.append(name, offer);
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

function updatePreview() {
  const form = document.querySelector("#bid-form");
  const company = teamState.auction?.company;
  if (!company) return;
  const score = bvi(Number(form.elements.principal.value), Number(form.elements.ratePercent.value), company);
  const scoreNode = document.querySelector("#bvi-value");
  const rankNode = document.querySelector("#rank-preview");
  if (score === null) {
    scoreNode.textContent = "—";
    rankNode.textContent = "Use the minimum bid and allowed increments to preview your rank.";
    return;
  }
  const roundedScore = Number(score.toFixed(4));
  scoreNode.textContent = roundedScore.toFixed(4);
  const ownBid = teamState.auction.myBid;
  const competitors = teamState.auction.leaderboard
    .filter((bid) => !ownBid || bid.team !== ownBid.team)
    .map((bid) => ({
      ...bid,
      score: Math.round(bid.bvi * 10000),
      time: new Date(bid.submittedAt).getTime()
    }));
  competitors.push({
    team: teamState.team,
    score: Math.round(roundedScore * 10000),
    ratePercent: Number(form.elements.ratePercent.value),
    time: Date.now()
  });
  competitors.sort((a, b) => b.score - a.score
    || a.ratePercent - b.ratePercent
    || a.time - b.time);
  const rank = competitors.findIndex((bid) => bid.team === teamState.team) + 1;
  rankNode.textContent = `Projected position: #${rank} of ${competitors.length}.`;
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
    document.querySelector("#team-auction-title").textContent = "Waiting for the auction";
    label.textContent = "WAITING";
    status.classList.remove("is-open", "is-closed");
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

async function refreshTeamPanel() {
  try {
    const [auction, results] = await Promise.all([
      api("/api/auction"),
      api("/api/team/results")
    ]);
    renderAuction(auction);
    showWonBids(results.results);
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
  const bidForm = document.querySelector("#bid-form");
  bidForm.addEventListener("submit", submitBid);
  ["principal", "ratePercent"].forEach((name) => {
    bidForm.elements[name].addEventListener("input", () => {
      teamState.editingOffer = true;
      updatePreview();
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
