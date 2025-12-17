const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STORAGE_KEY = "triPlanState_v2";
let weekGridListenerAttached = false;
let basePlanGlobal = null;

function parseIsoDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function loadLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveLocal(obj) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}

function getSessionChecks() {
  return loadLocal()?.sessionChecks || {};
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

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

function normalizeDaySessions(sessions = []) {
  const slots = { AM: null, PM: null };
  sessions.forEach((s) => {
    if (!s.slot) return;
    const slotKey = s.slot.toUpperCase();
    if (slotKey === "AM" || slotKey === "PM") {
      if (!slots[slotKey]) slots[slotKey] = { ...s, slot: slotKey };
    }
  });

  const fill = (slot) =>
    slots[slot] || { slot, type: "Off", duration: "-", details: "Rest." };

  return [fill("AM"), fill("PM")];
}

function normalizeWeekSlots(week) {
  const w = deepClone(week);
  for (const d of DAYS) {
    w.days[d] = normalizeDaySessions(w.days[d] || []);
  }
  return w;
}

function durationToMinutes(s) {
  if (!s || s === "-") return 0;
  const parts = String(s).split("–").map((p) => p.trim());
  const parseOne = (t) => {
    if (t.includes(":")) {
      const [hh, mm] = t.split(":").map(Number);
      return hh * 60 + mm;
    }
    const m = t.match(/(\d+)\s*m/i);
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
    const hh = Math.floor(m / 60);
    const mm = m % 60;
    return `${hh}:${String(mm).padStart(2, "0")}`;
  }
  return `${m}m`;
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
      const isOff = s.type === "Off";
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
  plan.weeks.forEach((w) => {
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
  if (!local) {
    p.weeks = p.weeks.map(normalizeWeekSlots);
    return p;
  }
  if (local.weekOverrides) {
    for (const [weekNum, override] of Object.entries(local.weekOverrides)) {
      const w = p.weeks.find((x) => String(x.week) === String(weekNum));
      if (!w) continue;
      if (override.days) w.days = override.days;
      if (override.coachNote) w._coachNote = override.coachNote;
    }
  }
  p.weeks = p.weeks.map(normalizeWeekSlots);
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

  const { plannedSessions, completedSessions, plannedMinutes, completedMinutes } =
    computeWeeklyTotals(w, weekNum);

  const barPct = plannedMinutes ? Math.min(100, Math.round((completedMinutes / plannedMinutes) * 100)) : 0;
  const fatigue = document.getElementById("fatigue")?.value;
  const sleep = document.getElementById("sleep")?.value;
  const cautionNote = fatigue === "high" || sleep === "poor"
    ? `<div class="weekly-progress__note muted">Keep sessions shorter and steadier if fatigue lingers.</div>`
    : "";

  summaryBox.innerHTML = `
  <div class="weekly-progress__title"><strong>Weekly progress</strong></div>

  <div class="weekly-progress__grid">
    <div><div class="k">Planned</div><div class="v">${plannedSessions} sessions • ${minutesToHHMM(plannedMinutes)}</div></div>
    <div><div class="k">Completed</div><div class="v">${completedSessions} sessions • ${minutesToHHMM(completedMinutes)}</div></div>
  </div>

  <div class="weekly-progress__bar"><span class="weekly-progress__barFill" style="width:${barPct}%"></span></div>
  ${cautionNote}
`;
}

function renderWeek(plan, weekNum) {
  const rawWeek = plan.weeks.find((x) => x.week === weekNum);
  if (!rawWeek) return;
  const w = normalizeWeekSlots(rawWeek);
  const summary = document.getElementById("weekSummary");
  const grid = document.getElementById("weekGrid");
  const coachNote = document.getElementById("coachNote");
  const missedList = document.getElementById("missedList");
  const weekChecks = getSessionChecks()[String(weekNum)] || {};

  summary.innerHTML = `
    <div><strong>Phase:</strong> ${w.phase}</div>
    <div><strong>Target:</strong> ${w.hoursTarget}</div>
    <div><strong>Notes:</strong> ${w.notes.map((n) => `<div>• ${n}</div>`).join("")}</div>
  `;

  const routineNote = document.getElementById("routineNote") || document.createElement("div");
  routineNote.id = "routineNote";
  routineNote.className = "routine-note";
  routineNote.textContent = "Each day includes two sessions (AM and PM). Load is defined by the session description. If a session would compromise the next day, it should be kept easier.";
  if (summary.parentNode && routineNote.parentNode !== summary.parentNode) {
    summary.insertAdjacentElement("afterend", routineNote);
  }

  coachNote.textContent = w._coachNote ? `Coach note: ${w._coachNote}` : "";

  renderWeeklyProgressCard(w, weekNum);

  grid.innerHTML = "";

  for (const d of DAYS) {
    const day = document.createElement("div");
    day.className = "day";
    day.innerHTML = `<h4>${d}</h4>`;
    const sessions = normalizeDaySessions(w.days[d]);
    let totalSessions = 0;
    let doneSessions = 0;

    sessions.forEach((s, idx) => {
      const box = document.createElement("div");
      const isDone = !!(weekChecks[d] && weekChecks[d][String(idx)]);
      const isOff = s.type === "Off";
      box.className = `session${isDone ? " done" : ""}`;
      box.dataset.type = s.type;

      const doneToggle = isOff
        ? ""
        : `
        <label class="done-toggle">
          <input type="checkbox" data-week="${weekNum}" data-day="${d}" data-idx="${idx}" ${isDone ? "checked" : ""}>
          <span>Done</span>
        </label>`;

      box.innerHTML = `
        <div class="top">
          <div class="session-title">
            <span class="session-label">Session ${idx + 1} · ${s.slot}</span>
            <strong>${s.type}</strong>
          </div>
          ${doneToggle}
        </div>
        <div class="muted">${s.duration}</div>
        <p>${s.details || ""}</p>
      `;
      if (!isOff) {
        totalSessions += 1;
        if (isDone) doneSessions += 1;
      }
      day.appendChild(box);
    });

    const progress = document.createElement("div");
    progress.className = "day-progress muted";
    progress.textContent = `Done: ${doneSessions} / ${totalSessions}`;
    day.appendChild(progress);

    grid.appendChild(day);
  }

  missedList.innerHTML = `<div class="muted">Adaptations keep both sessions visible; no selection needed.</div>`;

  if (!weekGridListenerAttached) {
    grid.addEventListener("change", (e) => {
      const target = e.target;
      if (!target || !(target instanceof HTMLInputElement)) return;
      if (!target.matches(".done-toggle input")) return;
      const week = Number(target.dataset.week);
      const dayName = target.dataset.day;
      const idx = Number(target.dataset.idx);
      setSessionCheck(week, dayName, idx, target.checked);
      const card = target.closest(".session");
      if (card) {
        card.classList.toggle("done", target.checked);
      }
      const dayEl = target.closest(".day");
      if (dayEl) {
        const progressEl = dayEl.querySelector(".day-progress");
        if (progressEl) {
          const cards = [...dayEl.querySelectorAll(".session")].filter((c) => c.dataset.type !== "Off");
          const doneCount = cards.filter((c) => c.classList.contains("done")).length;
          progressEl.textContent = `Done: ${doneCount} / ${cards.length}`;
        }
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
  const w = working.weeks.find((x) => x.week === weekNum);
  if (!w) return;
  renderWeeklyProgressCard(w, weekNum);
}

function stripIntervals(details = "") {
  const simplified = details
    .replace(/\d+\s*[×x]\s*\d+[^.,;]*/gi, "steady segments")
    .replace(/WU[^.]*|CD[^.]*/gi, "")
    .trim();
  return simplified || details;
}

function adaptSession(session, reduction = 0.25, modeLabel = "") {
  if (session.type === "Off") return { ...session };
  const mins = durationToMinutes(session.duration);
  const newDur = mins ? minutesToRange(mins, reduction) : session.duration;
  const simplifiedDetail = stripIntervals(session.details || "");
  const preface = modeLabel ? `${modeLabel} ` : "";
  return {
    ...session,
    duration: newDur,
    details: `${preface}Easy / steady only. ${simplifiedDetail}`.trim(),
  };
}

function applyRulesToWeek(week, state) {
  const w = deepClone(normalizeWeekSlots(week));
  const fatigueFlag = state.fatigue === "high" || state.sleep === "poor";
  const sick = !!state.illness;
  const injured = !!state.injury;
  const coachNotes = [];

  if (sick) {
    coachNotes.push("Illness: all sessions shortened and kept easy.");
    for (const d of DAYS) {
      w.days[d] = normalizeDaySessions(w.days[d]).map((s) => adaptSession(s, 0.35, "Sick mode."));
    }
    return { week: w, coachNote: coachNotes.join(" ") };
  }

  if (injured) {
    coachNotes.push("Injury: steady only, no surges.");
    for (const d of DAYS) {
      w.days[d] = normalizeDaySessions(w.days[d]).map((s) => adaptSession(s, 0.3, "Protect the body."));
    }
  }

  if (fatigueFlag) {
    coachNotes.push("Fatigue/sleep: durations trimmed and intensity removed.");
    for (const d of DAYS) {
      w.days[d] = normalizeDaySessions(w.days[d]).map((s) => adaptSession(s, 0.25, "Keep it calm."));
    }
  }

  const soreParts = (state.soreness || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (soreParts.length > 0) {
    coachNotes.push("Soreness noted: favor smooth, even pacing.");
    for (const d of DAYS) {
      w.days[d] = normalizeDaySessions(w.days[d]).map((s) => adaptSession(s, 0.2, "Smooth and easy."));
    }
  }

  return { week: w, coachNote: coachNotes.join(" ") };
}

async function loadPlan() {
  const pageUrl = new URL(window.location.href);
  const candidates = [
    new URL("data/plan.json", pageUrl).href,
    `${pageUrl.origin}${pageUrl.pathname.replace(/\/[^/]*$/, "")}/data/plan.json`,
    "data/plan.json",
  ];

  const errors = [];

  for (const url of candidates) {
    try {
      const res = await fetch(url);
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
    const w = p.weeks.find((x) => x.week === weekNum);

    const state = {
      fatigue: document.getElementById("fatigue").value,
      sleep: document.getElementById("sleep").value,
      soreness: document.getElementById("soreness").value,
      illness: document.getElementById("illness").checked,
      injury: document.getElementById("injury").checked,
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

main().catch((err) => {
  console.error(err);
  alert("Failed to load plan. Check that /data/plan.json exists and GitHub Pages is serving it.");
});
