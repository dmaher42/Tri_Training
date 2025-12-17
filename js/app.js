const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STORAGE_KEY = "triPlanState_v1";
let weekGridListenerAttached = false;
let basePlanGlobal = null;

const PATTERN = {
  Mon: { AM: "Swim", PM: "Mobility" },
  Tue: { AM: "Bike", PM: "Run" },
  Wed: { AM: "Run", PM: "Mobility" },
  Thu: { AM: "Swim", PM: "Bike" },
  Fri: { AM: "Mobility", PM: "Off" },
  Sat: { AM: "Bike", PM: "Run" },
  Sun: { AM: "Run", PM: "Swim" }
};

const DEFAULT_DETAILS = {
  Swim: "Easy technique-focused swim. Relaxed and feel-based.",
  Bike: "Easy spin, high cadence. Keep it aerobic only.",
  Run: "Easy aerobic run. Flat and relaxed.",
  Mobility: "Mobility and strength-durability work. Controlled and gentle.",
  Race: "Race day. Execute calmly and deliberately.",
  Off: "Off evening. Prioritize sleep."
};

const DEFAULT_DURATION = {
  Swim: "20–30m",
  Bike: "30–45m",
  Run: "20–30m",
  Mobility: "15–25m",
  Race: "Race day",
  Off: "-"
};

function parseIsoDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function loadLocal() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); }
  catch { return null; }
}

function saveLocal(obj) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}

function getSessionChecks() {
  return (loadLocal()?.sessionChecks || {});
}

function setSessionCheck(weekNum, day, idx, val) {
  const local = loadLocal() || {};
  local.sessionChecks = local.sessionChecks || {};
  const weekKey = String(weekNum);
  local.sessionChecks[weekKey] = local.sessionChecks[weekKey] || {};
  local.sessionChecks[weekKey][day] = local.sessionChecks[weekKey][day] || {};
  local.sessionChecks[weekKey][day][String(idx)] = !!val;
  saveLocal(local);
}

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

function durationToMinutes(s) {
  if (!s || s === "-") return 0;
  const parts = String(s).split("–").map(p => p.trim());
  const parseOne = (t) => {
    const s = String(t).trim();
    if (!s) return 0;

    // HH:MM format
    if (s.includes(":")) {
      const [hh, mm] = s.split(":").map(Number);
      return (hh * 60) + mm;
    }

    // Minutes, allow both "40m" and "40"
    const m = s.match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  };
  if (parts.length === 1) return parseOne(parts[0]);
  return Math.round((parseOne(parts[0]) + parseOne(parts[1])) / 2);
}

function minutesToHHMM(mins) {
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${hh}:${String(mm).padStart(2, "0")}`;
}

function minutesToRange(mins, pct = 0) {
  const m = Math.max(0, Math.round(mins * (1 - pct)));
  if (m >= 120) {
    const hh = Math.floor(m / 60), mm = m % 60;
    return `${hh}:${String(mm).padStart(2, "0")}`;
  }
  return `${m}m`;
}

function slotIndex(slot) { return slot === "PM" ? 1 : 0; }

function defaultSession(day, slot) {
  const type = PATTERN[day]?.[slot] || "Mobility";
  return {
    slot,
    type,
    duration: DEFAULT_DURATION[type] || "-",
    details: DEFAULT_DETAILS[type] || ""
  };
}

function normalizeDaySessions(dayName, sessions = [], weekNum) {
  const slotMap = { AM: null, PM: null };

  sessions.forEach((s, idx) => {
    const explicitSlot = s.slot === "PM" || s.slot === "AM" ? s.slot : null;
    const slot = explicitSlot || (!slotMap.AM ? "AM" : (!slotMap.PM ? "PM" : null));

    if (slot && !slotMap[slot]) {
      slotMap[slot] = {
        slot,
        type: s.type || PATTERN[dayName]?.[slot] || "Mobility",
        duration: s.duration || DEFAULT_DURATION[s.type] || "-",
        details: s.details || DEFAULT_DETAILS[s.type] || ""
      };
      return;
    }

    // Unused extra session for this day; keep it in the warning only.
  });

  if (sessions.length > 2) {
    console.warn(`[plan] ${weekNum ?? "?"} ${dayName}: found ${sessions.length} sessions; keeping AM/PM and ignoring extras`, sessions);
  }

  for (const slot of ["AM", "PM"]) {
    if (!slotMap[slot]) {
      slotMap[slot] = defaultSession(dayName, slot);
    }
  }

  return [slotMap.AM, slotMap.PM];
}

function normalizeWeek(week, weekNum) {
  const w = deepClone(week);
  for (const d of DAYS) {
    w.days[d] = normalizeDaySessions(d, w.days[d] || [], weekNum);
  }
  return w;
}

function isNonTrainingType(type) {
  return type === "Off";
}

function computeWeeklyTotals(weekObj, weekNum) {
  const local = loadLocal() || {};
  const checks = local.sessionChecks?.[String(weekNum)] || {};

  let plannedSessions = 0;
  let completedSessions = 0;
  let plannedMinutes = 0;
  let completedMinutes = 0;

  for (const d of DAYS) {
    const sessions = weekObj.days[d] || [];
    sessions.forEach((s, idx) => {
      const isOff = isNonTrainingType(s.type);
      const isChecked = !!(checks[d]?.[String(idx)]);
      const mins = durationToMinutes(s.duration);
      if (!isOff) {
        plannedSessions += 1;
        plannedMinutes += mins;
        if (isChecked) {
          completedSessions += 1;
          completedMinutes += mins;
        }
      }
    });
  }

  return { plannedSessions, completedSessions, plannedMinutes, completedMinutes };
}

function computeCurrentWeek(plan) {
  const start = parseIsoDate(plan.startDate);
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const d = daysBetween(start, todayUtc);
  const w = Math.floor(d / 7) + 1;
  return clamp(w, 1, plan.weeks.length);
}

function buildWeekSelect(plan, currentWeek) {
  const sel = document.getElementById("weekSelect");
  sel.innerHTML = "";
  plan.weeks.forEach(w => {
    const opt = document.createElement("option");
    opt.value = String(w.week);
    opt.textContent = `Week ${w.week} – ${w.phase} (${w.hoursTarget})`;
    if (w.week === currentWeek) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderMeta(plan) {
  const el = document.getElementById("meta");
  el.textContent = `Start: ${plan.startDate} • Race: ${plan.raceDate}`;
}

function getWorkingPlan(plan) {
  const local = loadLocal();
  const p = deepClone(plan);
  if (local?.weekOverrides) {
    for (const [weekNum, override] of Object.entries(local.weekOverrides)) {
      const w = p.weeks.find(x => String(x.week) === String(weekNum));
      if (!w) continue;
      if (override.days) w.days = override.days;
      if (override.coachNote) w._coachNote = override.coachNote;
    }
  }
  p.weeks = p.weeks.map((wk) => normalizeWeek(wk, wk.week));
  return p;
}

function setWeekOverride(weekNum, days, coachNote) {
  const local = loadLocal() || {};
  local.weekOverrides = local.weekOverrides || {};
  local.weekOverrides[String(weekNum)] = { days, coachNote };
  saveLocal(local);
}

function resetOverrides() {
  localStorage.removeItem(STORAGE_KEY);
}

function renderWeeklyProgressCard(w, weekNum) {
  const grid = document.getElementById("weekGrid");
  if (!grid) return;

  const summaryBox = document.getElementById("weeklyProgress") || document.createElement("div");
  summaryBox.id = "weeklyProgress";
  summaryBox.className = "weekly-progress";

  if (grid.parentNode && summaryBox.parentNode !== grid.parentNode) {
    grid.parentNode.insertBefore(summaryBox, grid);
  }

  const { plannedSessions, completedSessions, plannedMinutes, completedMinutes } = computeWeeklyTotals(w, weekNum);

  summaryBox.innerHTML = `
  <div class="weekly-progress__title"><strong>Weekly progress</strong></div>

  <div class="weekly-progress__grid">
    <div><div class="k">Planned</div><div class="v">${plannedSessions} sessions • ${minutesToHHMM(plannedMinutes)}</div></div>
    <div><div class="k">Completed</div><div class="v">${completedSessions} sessions • ${minutesToHHMM(completedMinutes)}</div></div>
  </div>
  `;
}

function updateWeeklyProgress(weekNum) {
  if (!basePlanGlobal) return;
  const plan = getWorkingPlan(basePlanGlobal);
  const w = plan.weeks.find((x) => x.week === weekNum);
  if (!w) return;
  renderWeeklyProgressCard(w, weekNum);
}

function ensureRoutineNote(summary) {
  const routineNote = document.getElementById("routineNote") || document.createElement("div");
  routineNote.id = "routineNote";
  routineNote.className = "routine-note";
  routineNote.textContent = "Each day includes two planned sessions (AM and PM). Load is defined by the session description. If a session would compromise the next day, keep it easier.";
  if (summary.parentNode && routineNote.parentNode !== summary.parentNode) {
    summary.insertAdjacentElement("afterend", routineNote);
  }
}

function renderWeek(plan, weekNum) {
  const rawWeek = plan.weeks.find(x => x.week === weekNum);
  if (!rawWeek) return;
  const w = normalizeWeek(rawWeek, rawWeek.week);
  const summary = document.getElementById("weekSummary");
  const grid = document.getElementById("weekGrid");
  const coachNote = document.getElementById("coachNote");
  const missedList = document.getElementById("missedList");
  const weekChecks = getSessionChecks()[String(weekNum)] || {};

  summary.innerHTML = `
    <div><strong>Phase:</strong> ${w.phase}</div>
    <div><strong>Target:</strong> ${w.hoursTarget}</div>
    <div><strong>Notes:</strong> ${w.notes.map(n => `<div>• ${n}</div>`).join("")}</div>
  `;

  ensureRoutineNote(summary);

  coachNote.textContent = w._coachNote ? `Coach note: ${w._coachNote}` : "";

  renderWeeklyProgressCard(w, weekNum);

  grid.innerHTML = "";

  for (const d of DAYS) {
    const day = document.createElement("div");
    day.className = "day";
    day.innerHTML = `<h4>${d}</h4>`;
    const sessions = (w.days[d] || []).slice().sort((a, b) => slotIndex(a.slot) - slotIndex(b.slot));

    sessions.forEach((s, idx) => {
      const box = document.createElement("div");
      const isDone = !!(weekChecks[d] && weekChecks[d][String(idx)]);
      const isOff = s.type === "Off";
      box.className = `session${isDone ? " done" : ""}`;
      box.dataset.type = s.type;
      box.dataset.slot = s.slot;
      const doneToggle = isOff ? "" : `
        <label class="done-toggle">
          <input type="checkbox" data-week="${weekNum}" data-day="${d}" data-idx="${idx}" ${isDone ? "checked" : ""}>
          <span>Done</span>
        </label>`;
      const slotLabel = s.slot === "PM" ? "Session 2 · PM" : "Session 1 · AM";
      box.innerHTML = `
        <div class="top">
          <div class="session-title">
            <span class="role-badge">${slotLabel}</span>
            <strong>${s.type}</strong>
          </div>
          <div class="top-right">
            ${doneToggle}
          </div>
        </div>
        <div class="muted">${s.duration}</div>
        <p>${s.details || ""}</p>
      `;
      day.appendChild(box);
    });

    grid.appendChild(day);
  }

  missedList.innerHTML = `<div class="muted">Adaptations keep both sessions. No key-session checklist required.</div>`;

  if (!weekGridListenerAttached) {
    grid.addEventListener("change", (e) => {
      const target = e.target;
      if (!target || !(target instanceof HTMLInputElement)) return;
      if (!target.matches(".done-toggle input")) return;
      const week = Number(target.dataset.week);
      const dayName = target.dataset.day;
      const idx = Number(target.dataset.idx);
      setSessionCheck(week, dayName, idx, target.checked);
      const card = target.closest('.session');
      if (card) {
        card.classList.toggle('done', target.checked);
      }
      updateWeeklyProgressForSelectedWeek(basePlanGlobal);
    });
    weekGridListenerAttached = true;
  }
}

function updateWeeklyProgressForSelectedWeek(plan) {
  if (!plan) return;
  const sel = document.getElementById("weekSelect");
  if (!sel) return;
  const weekNum = Number(sel.value);
  const working = getWorkingPlan(plan);
  const w = working.weeks.find(x => x.week === weekNum);
  if (!w) return;
  renderWeeklyProgressCard(w, weekNum);
}

function simplifyDetails(details, mode = "easy") {
  const base = (details || "").trim().replace(/\s+/g, " ");
  if (!base) return mode === "rest" ? "Keep it gentle. Skip any intensity." : "Keep it easy aerobic only.";
  if (mode === "rest") return `Keep it gentle. Skip intensity. ${base}`;
  return `Keep it easy aerobic only. ${base}`;
}

function isLowerBodySoreness(sorenessAreas) {
  const flags = ["calf", "achilles", "shin", "knee", "hip", "foot", "plantar"];
  return sorenessAreas.some((s) => flags.includes(s));
}

function stripIntensityText(details, mode = "easy") {
  return simplifyDetails(details, mode);
}

function convertRunForInjury(session, dayName, slot) {
  const isShortPmRun = slot === "PM" && (dayName === "Tue" || dayName === "Sat");
  const type = isShortPmRun ? "Mobility" : "Bike";
  const duration = DEFAULT_DURATION[type] || session.duration || "-";
  const baseDetails = stripIntensityText(session.details, "easy");
  return {
    ...session,
    type,
    duration,
    details: `No running. Substitute easy aerobic only. ${baseDetails}`.trim()
  };
}

function applyRulesToWeek(week, state) {
  const w = deepClone(normalizeWeek(week, week.week));
  const sick = !!state.illness;
  const injured = !!state.injury;
  const heavy = (state.fatigue === "high") || (state.sleep === "poor");
  const sorenessAreas = (state.soreness || "")
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
  const lowerBody = isLowerBodySoreness(sorenessAreas);
  const protectRun = injured || lowerBody;

  const coachNote = [];
  const reducePct = sick ? 0.4 : (protectRun ? 0.35 : (heavy ? 0.25 : 0));

  if (sick) coachNote.push("Illness noted: shorten and keep everything gentle.");
  if (protectRun) coachNote.push("Run durability protection: swap runs and avoid intensity.");
  if (heavy && !sick && !protectRun) coachNote.push("Fatigue / sleep flag: reduce load but keep routine.");

  for (const d of DAYS) {
    w.days[d] = (w.days[d] || []).map((s) => {
      let session = { ...s };

      if (protectRun && session.type === "Run") {
        session = convertRunForInjury(session, d, session.slot);
      }

      if (!isNonTrainingType(session.type) && reducePct && session.duration !== "-") {
        const mins = durationToMinutes(session.duration);
        session.duration = mins ? minutesToRange(mins, reducePct) : session.duration;
      }

      if (sick) {
        session.details = stripIntensityText(session.details, "rest");
      } else if (protectRun && s.type === "Run") {
        session.details = session.details || stripIntensityText(s.details, "easy");
      } else if (heavy) {
        session.details = stripIntensityText(session.details, "easy");
      }

      if (session.type === "Off") {
        session.details = DEFAULT_DETAILS.Off;
      }

      return session;
    });
  }

  return { week: w, coachNote: coachNote.join(" ") };
}

async function loadPlan() {
  const pageUrl = new URL(window.location.href);
  const candidates = [
    new URL("data/plan.json", pageUrl).href,
    `${pageUrl.origin}${pageUrl.pathname.replace(/\/[^/]*$/, "")}/data/plan.json`,
    "data/plan.json"
  ];

  const errors = [];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }

  throw new Error(`Failed to fetch plan.json. Attempts: ${errors.join(" | ")}`);
}

async function main() {
  const basePlan = await loadPlan();
  basePlanGlobal = basePlan;
  renderMeta(basePlan);

  const working = getWorkingPlan(basePlan);
  let currentWeek = computeCurrentWeek(working);

  buildWeekSelect(working, currentWeek);
  renderWeek(working, currentWeek);

  document.getElementById("weekSelect").addEventListener("change", (e) => {
    const w = Number(e.target.value);
    renderWeek(getWorkingPlan(basePlan), w);
  });

  document.getElementById("jumpToCurrent").addEventListener("click", () => {
    const p = getWorkingPlan(basePlan);
    currentWeek = computeCurrentWeek(p);
    buildWeekSelect(p, currentWeek);
    renderWeek(p, currentWeek);
  });

  document.getElementById("adaptWeek").addEventListener("click", () => {
    const weekNum = Number(document.getElementById("weekSelect").value);
    const p = getWorkingPlan(basePlan);
    const w = p.weeks.find(x => x.week === weekNum);

    const state = {
      fatigue: document.getElementById("fatigue").value,
      sleep: document.getElementById("sleep").value,
      soreness: document.getElementById("soreness").value,
      illness: document.getElementById("illness").checked,
      injury: document.getElementById("injury").checked
    };

    const { week: adapted, coachNote } = applyRulesToWeek(w, state);
    setWeekOverride(weekNum, adapted.days, coachNote);

    const p2 = getWorkingPlan(basePlan);
    renderWeek(p2, weekNum);
  });

  document.getElementById("resetState").addEventListener("click", () => {
    resetOverrides();
    const p2 = getWorkingPlan(basePlan);
    const w = Number(document.getElementById("weekSelect").value);
    renderWeek(p2, w);
  });

  document.getElementById("exportState").addEventListener("click", () => {
    const local = loadLocal() || {};
    const blob = new Blob([JSON.stringify(local, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tri-plan-state.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("importState").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const obj = JSON.parse(text);
    saveLocal(obj);
    const p2 = getWorkingPlan(basePlan);
    const w = Number(document.getElementById("weekSelect").value);
    renderWeek(p2, w);
    e.target.value = "";
  });
}

main().catch(err => {
  console.error(err);
  alert("Failed to load plan. Check that /data/plan.json exists and GitHub Pages is serving it.");
});
