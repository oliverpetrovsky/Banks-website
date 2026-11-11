async function requestJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not load the leaderboard.");
  return body;
}

function renderResults(results) {
  const board = document.querySelector("#public-leaderboard");
  if (results.length === 0) {
    board.innerHTML = '<p class="empty-state">No company auctions have been completed yet. Final standings will appear here after each auction closes.</p>';
    return;
  }
  board.replaceChildren(...results.map((result) => {
    const row = document.createElement("article");
    row.className = "result-row";
    const information = document.createElement("div");
    const era = document.createElement("span");
    era.className = "result-era";
    era.textContent = `${result.eraName} · ${result.companyId}`;
    const company = document.createElement("h3");
    company.className = "result-company";
    company.textContent = result.companyName;
    const winner = document.createElement("span");
    winner.className = "result-winner";
    winner.textContent = `Winning team: ${result.winner}`;
    information.append(era, company, winner);
    const score = document.createElement("strong");
    score.className = "result-score";
    score.textContent = `BVI ${result.bvi.toFixed(4)}`;
    row.append(information, score);
    return row;
  }));
}

async function refreshPublicBoard() {
  try {
    if (document.body.dataset.round === "2") {
      const data = await requestJson("/api/bloodlines/public-scoreboard");
      renderBloodlinesResults(data);
      return;
    }
    const data = await requestJson("/api/public/leaderboard");
    renderResults(data.results);
    const status = document.querySelector("#public-auction-status");
    const container = status.parentElement;
    if (data.activeCompany) {
      status.textContent = `LIVE AUCTION · ${data.activeCompany.name}`;
      container.classList.add("is-open");
      container.classList.remove("is-closed");
    } else {
      status.textContent = "NO LIVE AUCTION";
      container.classList.remove("is-open", "is-closed");
    }
  } catch (error) {
    const notice = document.createElement("p");
    notice.className = "empty-state";
    notice.textContent = error.message;
    document.querySelector("#public-leaderboard").replaceChildren(notice);
  }
}

function renderBloodlinesResults(data) {
  const board = document.querySelector("#bloodlines-public-leaderboard");
  const status = document.querySelector("#bloodlines-public-status");
  if (!data.published) {
    status.textContent = data.yearComplete
      ? "The simulation is complete. Final scores will appear after the admin publishes them."
      : "Final scores appear here after the admin publishes the completed simulation.";
    board.replaceChildren();
    return;
  }
  status.textContent = "Final household net worth after four simulated years.";
  if (!data.teams.length) {
    board.replaceChildren();
    return;
  }
  board.replaceChildren(...data.teams.map((team, index) => {
    const row = document.createElement("article");
    row.className = "result-row";
    const information = document.createElement("div");
    const rank = document.createElement("span");
    rank.className = "result-era";
    rank.textContent = `RANK ${String(index + 1).padStart(2, "0")}`;
    const name = document.createElement("h3");
    name.className = "result-company";
    name.textContent = team.team;
    information.append(rank, name);
    const score = document.createElement("strong");
    score.className = "result-score";
    score.textContent = `NET WORTH ${formatRupees(team.score)}`;
    row.append(information, score);
    return row;
  }));
}

function formatRupees(value) {
  return `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

refreshPublicBoard();
setInterval(() => {
  if (document.visibilityState === "visible") refreshPublicBoard();
}, 3000);
document.addEventListener("banks-round-change", refreshPublicBoard);
