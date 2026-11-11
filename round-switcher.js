let activeRound = null;
let adminAuthorized = false;
let roundRequestPending = false;

function renderRound(round) {
  const selectedRound = round === 2 ? "2" : "1";
  const changed = activeRound !== selectedRound;
  activeRound = selectedRound;
  document.body.dataset.round = selectedRound;
  document.querySelectorAll("[data-round-select]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.roundSelect === selectedRound));
  });
  document.querySelectorAll("[data-round-label]").forEach((label) => {
    label.textContent = selectedRound === "2"
      ? "ROUND 02 / BLOODLINES"
      : "ROUND 01 / THE BANKING SYNDICATE";
  });
  document.querySelectorAll("[data-round-indicator]").forEach((indicator) => {
    indicator.textContent = selectedRound === "2" ? "R2 · BLOODLINES" : "R1 · BANKING";
  });
  const notice = document.querySelector("#round-two-notice");
  if (notice) notice.hidden = selectedRound !== "2";
  if (changed) {
    document.dispatchEvent(new CustomEvent("banks-round-change", {
      detail: { round: selectedRound }
    }));
  }
}

function setAdminAuthorization(authorized) {
  adminAuthorized = authorized;
  const switcher = document.querySelector("#admin-round-switcher");
  if (!switcher) return;
  switcher.hidden = !authorized;
  switcher.querySelectorAll("button").forEach((button) => {
    button.disabled = !authorized || roundRequestPending;
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The request could not be completed.");
  return body;
}

async function refreshRound() {
  try {
    const data = await fetchJson("/api/round");
    renderRound(data.round);
  } catch (error) {
    document.querySelectorAll("[data-round-indicator]").forEach((indicator) => {
      indicator.textContent = "ROUND STATUS UNAVAILABLE";
    });
    const message = document.querySelector("#admin-round-message");
    if (message) message.textContent = error.message;
  }
}

async function refreshAdminAuthorization() {
  if (!document.querySelector("#admin-round-switcher")) return;
  try {
    const session = await fetchJson("/api/auth/session");
    const authorized = session.authenticated && session.role === "admin";
    setAdminAuthorization(authorized);
    if (authorized) await refreshRoundAccess();
  } catch (error) {
    setAdminAuthorization(false);
    const message = document.querySelector("#admin-round-message");
    if (message) message.textContent = error.message;
  }
}

async function refreshRoundAccess() {
  const switcher = document.querySelector("#admin-round-switcher");
  if (!switcher || !adminAuthorized) return;
  const roundTwoButton = switcher.querySelector('[data-round-select="2"]');
  const message = document.querySelector("#admin-round-message");
  try {
    const qualification = await fetchJson("/api/admin/round-one/qualification");
    roundTwoButton.disabled = roundRequestPending || !qualification.locked;
    if (!qualification.locked) {
      message.textContent = qualification.available
        ? "Select and lock Round 1 qualifiers to enable Bloodlines."
        : "Complete Round 1 and lock qualifiers to enable Bloodlines.";
    } else if (message.textContent.includes("qualifier")) {
      message.textContent = "";
    }
  } catch (error) {
    roundTwoButton.disabled = true;
    message.textContent = error.message;
  }
}

async function changeRound(event) {
  const button = event.currentTarget;
  const message = document.querySelector("#admin-round-message");
  if (!adminAuthorized || roundRequestPending) return;
  roundRequestPending = true;
  setAdminAuthorization(true);
  if (message) message.textContent = "";
  try {
    const result = await fetchJson("/api/admin/round", {
      method: "POST",
      body: JSON.stringify({ round: Number(button.dataset.roundSelect) })
    });
    renderRound(result.round);
  } catch (error) {
    if (message) message.textContent = error.message;
    await refreshRound();
    await refreshAdminAuthorization();
  } finally {
    roundRequestPending = false;
    setAdminAuthorization(adminAuthorized);
    if (adminAuthorized) await refreshRoundAccess();
  }
}

document.querySelectorAll("[data-round-select]").forEach((button) => {
  button.addEventListener("click", changeRound);
});
window.addEventListener("banks-admin-authenticated", () => refreshAdminAuthorization());
window.addEventListener("banks-admin-signed-out", () => setAdminAuthorization(false));

refreshRound();
refreshAdminAuthorization();
setInterval(refreshRound, 2000);
setInterval(refreshAdminAuthorization, 5000);
