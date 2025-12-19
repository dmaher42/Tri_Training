const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STORAGE_KEY = "triPlanState_v2";
const CALENDAR_VIEW_KEY = "triCalendarView";
let weekGridListenerAttached = false;
let basePlanGlobal = null;
let hasFlashClassCache = null;

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

function getPreferredCalendarView() {
  const raw = localStorage.getItem(CALENDAR_VIEW_KEY);
  return raw === "week" ? "week" : "month";
}

function setPreferredCalendarView(view) {
  const v = view === "week" ? "week" : "month";
  localStorage.setItem(CALENDAR_VIEW_KEY, v);
  return v;
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
  const raw = String(s).trim();
  const parts = raw.includes("–") ? raw.split("–") : raw.split("-");
  const cleanedParts = parts.map(p => p.trim()).filter(Boolean);
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
  if (cleanedParts.length === 1) return parseOne(cleanedParts[0]);
  return Math.round((parseOne(cleanedParts[0]) + parseOne(cleanedParts[1])) / 2);
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
  const extras = [];

  const assignToSlot = (s, slot) => {
    slotMap[slot] = {
      slot,
      type: s.type || PATTERN[dayName]?.[slot] || "Mobility",
      duration: s.duration || DEFAULT_DURATION[s.type] || DEFAULT_DURATION[slotMap[slot]?.type] || "-",
      details: s.details || DEFAULT_DETAILS[s.type] || DEFAULT_DETAILS[slotMap[slot]?.type] || ""
    };
  };

  sessions.forEach((s) => {
    const explicitSlot = s.slot === "AM" || s.slot === "PM" ? s.slot : null;

    if (explicitSlot && !slotMap[explicitSlot]) {
      assignToSlot(s, explicitSlot);
      return;
    }

    const fallback = !slotMap.AM ? "AM" : (!slotMap.PM ? "PM" : null);
    if (fallback) {
      assignToSlot(s, fallback);
    } else {
      extras.push(s);
    }
  });

  for (const slot of ["AM", "PM"]) {
    if (!slotMap[slot]) {
      slotMap[slot] = defaultSession(dayName, slot);
    }
  }

  if (extras.length) {
    console.warn(`[plan] Week ${weekNum ?? "?"} ${dayName}: ignoring extra sessions beyond AM/PM`, extras);
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
      // Race days count as planned sessions but do not add to weekly minute totals.
      const mins = s.type === "Race" ? 0 : durationToMinutes(s.duration);
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

function renderCalendarMonth(plan, weekNum) {
  const grid = document.getElementById("calendarView");
  const summary = document.getElementById("calendarSummary");
  if (!grid || !plan) return;

  const startDate = parseIsoDate(plan.startDate);
  const raceDate = parseIsoDate(plan.raceDate);
  const checks = getSessionChecks();

  const planByDate = new Map();
  const dayMs = 24 * 60 * 60 * 1000;
  for (let cursor = new Date(startDate); cursor.getTime() <= raceDate.getTime(); cursor = new Date(cursor.getTime() + dayMs)) {
    const dayIndex = daysBetween(startDate, cursor);
    const wNum = Math.floor(dayIndex / 7) + 1;
    const dayName = DAYS[dayIndex % 7];
    const week = plan.weeks.find((w) => w.week === wNum);
    const sessions = week?.days?.[dayName] || [];
    const key = cursor.toISOString().slice(0, 10);
    planByDate.set(key, { weekNum: wNum, dayName, sessions, checks: checks[String(wNum)]?.[dayName] || {} });
  }

  const monthStartAnchor = new Date(startDate.getTime() + (Math.max(1, weekNum) - 1) * 7 * dayMs);
  const displayYear = monthStartAnchor.getUTCFullYear();
  const displayMonth = monthStartAnchor.getUTCMonth();
  const firstOfMonth = new Date(Date.UTC(displayYear, displayMonth, 1));
  const daysInMonth = new Date(Date.UTC(displayYear, displayMonth + 1, 0)).getUTCDate();
  const firstDayOffset = (firstOfMonth.getUTCDay() + 6) % 7; // Monday = 0
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const todayKey = todayUtc.toISOString().slice(0, 10);

  grid.innerHTML = "";
  const frag = document.createDocumentFragment();

  DAYS.forEach((d) => {
    const head = document.createElement("div");
    head.className = "cal-head muted";
    head.textContent = d;
    frag.appendChild(head);
  });

  for (let i = 0; i < firstDayOffset; i++) {
    const pad = document.createElement("div");
    pad.className = "cal-day is-dim";
    pad.innerHTML = `<div class="cal-day__num">&nbsp;</div>`;
    frag.appendChild(pad);
  }

  let completedSessions = 0;
  let plannedSessions = 0;

  for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
    const dateObj = new Date(Date.UTC(displayYear, displayMonth, dayNum));
    const key = dateObj.toISOString().slice(0, 10);
    const dayInfo = planByDate.get(key);
    const cell = document.createElement("div");

    if (!dayInfo) {
      cell.className = "cal-day is-dim";
      cell.innerHTML = `<div class="cal-day__num">${dayNum}</div>`;
      frag.appendChild(cell);
      continue;
    }

    const isToday = key === todayKey;
    cell.className = `cal-day${isToday ? " is-today" : ""}`;
    cell.dataset.date = key;
    cell.dataset.week = String(dayInfo.weekNum);
    cell.dataset.day = dayInfo.dayName;

    const num = document.createElement("div");
    num.className = "cal-day__num";
    num.textContent = String(dayNum);
    cell.appendChild(num);

    const bars = document.createElement("div");
    bars.className = "cal-day__bars";

    ["AM", "PM"].forEach((slot, idx) => {
      const session = dayInfo.sessions[idx];
      const bar = document.createElement("span");
      bar.className = `cal-bar cal-bar--${slot.toLowerCase()}`;
      if (session) {
        const isOff = isNonTrainingType(session.type);
        const isDone = !isOff && !!dayInfo.checks[String(idx)];
        if (isOff) bar.classList.add("is-off");
        if (isDone) bar.classList.add("is-done");
        if (!isOff) {
          plannedSessions += 1;
          if (isDone) completedSessions += 1;
        }
      }
      bars.appendChild(bar);
    });

    cell.appendChild(bars);
    frag.appendChild(cell);
  }

  const totalCells = DAYS.length + firstDayOffset + daysInMonth;
  const remainder = totalCells % 7;
  if (remainder) {
    const pads = 7 - remainder;
    for (let i = 0; i < pads; i++) {
      const pad = document.createElement("div");
      pad.className = "cal-day is-dim";
      pad.innerHTML = `<div class="cal-day__num">&nbsp;</div>`;
      frag.appendChild(pad);
    }
  }

  grid.appendChild(frag);

  if (summary) {
    const monthName = firstOfMonth.toLocaleString(undefined, { month: "long", timeZone: "UTC" });
    summary.textContent = `${monthName} ${displayYear} • ${completedSessions} / ${plannedSessions} sessions completed`;
  }
}

function renderCalendarWeek(plan, weekNum) {
  const grid = document.getElementById("calendarView");
  const summary = document.getElementById("calendarSummary");
  if (!grid || !plan) return;

  const startDate = parseIsoDate(plan.startDate);
  const checks = getSessionChecks()[String(weekNum)] || {};
  const dayMs = 24 * 60 * 60 * 1000;
  const weekStart = new Date(startDate.getTime() + Math.max(0, (Math.max(1, weekNum) - 1) * 7 * dayMs));
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const todayKey = todayUtc.toISOString().slice(0, 10);

  const w = plan.weeks.find((x) => x.week === weekNum);

  grid.innerHTML = "";
  const frag = document.createDocumentFragment();

  DAYS.forEach((d) => {
    const head = document.createElement("div");
    head.className = "cal-head muted";
    head.textContent = d;
    frag.appendChild(head);
  });

  let plannedSessions = 0;
  let completedSessions = 0;

  DAYS.forEach((dayName, idx) => {
    const dateObj = new Date(weekStart.getTime() + idx * dayMs);
    const key = dateObj.toISOString().slice(0, 10);
    const cell = document.createElement("div");
    const sessions = w?.days?.[dayName] || [];
    const weekChecks = checks[dayName] || {};
    const isToday = key === todayKey;

    cell.className = `cal-day${isToday ? " is-today" : ""}`;
    cell.dataset.date = key;
    cell.dataset.week = String(weekNum);
    cell.dataset.day = dayName;

    const num = document.createElement("div");
    num.className = "cal-day__num";
    num.textContent = `${dayName} ${dateObj.getUTCDate()}`;
    cell.appendChild(num);

    const bars = document.createElement("div");
    bars.className = "cal-day__bars";

    ["AM", "PM"].forEach((slot, slotIdx) => {
      const session = sessions[slotIdx];
      const bar = document.createElement("span");
      bar.className = `cal-bar cal-bar--${slot.toLowerCase()}`;
      if (session) {
        const isOff = isNonTrainingType(session.type);
        const isDone = !isOff && !!weekChecks[String(slotIdx)];
        if (isOff) bar.classList.add("is-off");
        if (isDone) bar.classList.add("is-done");
        if (!isOff) {
          plannedSessions += 1;
          if (isDone) completedSessions += 1;
        }
      }
      bars.appendChild(bar);
    });

    cell.appendChild(bars);
    frag.appendChild(cell);
  });

  grid.appendChild(frag);

  if (summary) {
    const endDate = new Date(weekStart.getTime() + 6 * dayMs);
    summary.textContent = `Week ${weekNum} • ${weekStart.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)} • ${completedSessions} / ${plannedSessions} sessions completed`;
  }
}

function applyCalendarToggleState(view) {
  const weekBtn = document.getElementById("calWeekBtn");
  const monthBtn = document.getElementById("calMonthBtn");
  if (!weekBtn || !monthBtn) return;

  const isWeek = view === "week";
  weekBtn.classList.toggle("is-active", isWeek);
  monthBtn.classList.toggle("is-active", !isWeek);
  weekBtn.setAttribute("aria-pressed", String(isWeek));
  monthBtn.setAttribute("aria-pressed", String(!isWeek));
}

function getSelectedWeek(plan) {
  const sel = document.getElementById("weekSelect");
  const selected = Number(sel?.value);
  if (Number.isFinite(selected) && selected > 0) return selected;
  if (plan) return computeCurrentWeek(plan);
  return 1;
}

function renderCalendar(plan, weekNum) {
  const view = getPreferredCalendarView();
  applyCalendarToggleState(view);
  const targetWeek = weekNum || getSelectedWeek(plan);
  if (view === "week") {
    renderCalendarWeek(plan, targetWeek);
  } else {
    renderCalendarMonth(plan, targetWeek);
  }
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
  const completionPct = plannedSessions ? Math.round((completedSessions / plannedSessions) * 100) : 0;
  const barMarkup = plannedSessions ? `
    <div class="weekly-progress__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${completionPct}">
      <div class="weekly-progress__barFill" style="width: ${completionPct}%"></div>
    </div>
  ` : "";

  summaryBox.innerHTML = `
  <div class="weekly-progress__title"><strong>Weekly progress</strong></div>

  <div class="weekly-progress__grid">
    <div><div class="k">Planned</div><div class="v">${plannedSessions} sessions • ${minutesToHHMM(plannedMinutes)}</div></div>
    <div><div class="k">Completed</div><div class="v">${completedSessions} sessions • ${minutesToHHMM(completedMinutes)}</div></div>
    <div><div class="k">Completion</div><div class="v">${completionPct}%</div></div>
  </div>
  ${barMarkup}
  `;
}

function updateWeeklyProgress(weekNum) {
  if (!basePlanGlobal) return;
  const plan = getWorkingPlan(basePlanGlobal);
  const w = plan.weeks.find((x) => x.week === weekNum);
  if (!w) return;
  renderWeeklyProgressCard(w, weekNum);
}

function updateDayProgress(dayEl) {
  if (!dayEl) return;
  const sessions = Array.from(dayEl.querySelectorAll('.session:not([data-type="Off"])'));
  const total = sessions.length;
  const done = sessions.filter((s) => s.classList.contains('done')).length;
  const progressEl = dayEl.querySelector('.day__progress');
  if (progressEl) {
    progressEl.textContent = total ? `Done: ${done} / ${total}` : 'Done: 0 / 0';
  }
}

function flashDayElement(el) {
  if (!el) return;
  if (hasFlashClassCache === null) {
    try {
      hasFlashClassCache = Array.from(document.styleSheets || []).some((sheet) => {
        try {
          return Array.from(sheet.cssRules || []).some((rule) => rule.selectorText && rule.selectorText.includes('.is-flash'));
        } catch {
          return false;
        }
      });
    } catch {
      hasFlashClassCache = false;
    }
  }

  if (!hasFlashClassCache) return;

  el.classList.add("is-flash");
  setTimeout(() => el.classList.remove("is-flash"), 800);
}

function createSessionCard(s, weekNum, dayName, idx, isDone) {
  const box = document.createElement("div");
  const isOff = s.type === "Off";
  box.className = `session${isDone ? " done" : ""}`;
  box.dataset.type = s.type;
  box.dataset.slot = s.slot;
  const doneToggle = isOff ? "" : `
    <label class="done-toggle">
      <input type="checkbox" data-week="${weekNum}" data-day="${dayName}" data-idx="${idx}" ${isDone ? "checked" : ""}>
      <span>Done</span>
    </label>`;
  const slotLabel = s.slot === "PM" ? "Session 2 · PM" : "Session 1 · AM";
  const adaptedBadge = s._adapted ? `<span class="adapted-badge">Adapted</span>` : "";
  box.innerHTML = `
    <div class="top">
      <div class="session-title">
        <span class="slot-badge">${slotLabel}</span>
        <strong class="session-type">${s.type}</strong>
        ${adaptedBadge}
      </div>
      <div class="top-right">
        ${doneToggle}
      </div>
    </div>
    <div class="session-duration muted">${s.duration}</div>
    <p class="session-details">${s.details || ""}</p>
  `;
  return box;
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
  `;

  coachNote.textContent = w._coachNote ? `Coach note: ${w._coachNote}` : "";

  renderWeeklyProgressCard(w, weekNum);

  grid.innerHTML = "";

  for (const d of DAYS) {
    const day = document.createElement("div");
    day.className = "day";
    day.innerHTML = `
      <div class="day__header">
        <h4>${d}</h4>
        <div class="day__progress" aria-live="polite"></div>
      </div>`;
    const sessions = (w.days[d] || []).slice().sort((a, b) => slotIndex(a.slot) - slotIndex(b.slot));

    sessions.forEach((s, idx) => {
      const isDone = !!(weekChecks[d] && weekChecks[d][String(idx)]);
      const box = createSessionCard(s, weekNum, d, idx, isDone);
      day.appendChild(box);
    });

    updateDayProgress(day);

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
        updateDayProgress(card.closest('.day'));
      }
      updateWeeklyProgressForSelectedWeek(basePlanGlobal);
      renderCalendar(getWorkingPlan(basePlanGlobal), Number(document.getElementById("weekSelect")?.value || week));

      if (basePlanGlobal) {
        const p = getWorkingPlan(basePlanGlobal);
        const cw = computeCurrentWeek(p);
        const now = new Date();
        const dName = DAYS[(now.getDay() + 6) % 7];

        if (week === cw && dayName === dName) {
          renderToday(p, cw);
        }
      }
    });
    weekGridListenerAttached = true;
  }
}

function jumpToWeekDay(weekNum, dayName) {
  if (!weekNum || !dayName) return;
  const sel = document.getElementById("weekSelect");
  if (sel) sel.value = String(weekNum);

  const plan = basePlanGlobal ? getWorkingPlan(basePlanGlobal) : null;
  if (plan) {
    renderWeek(plan, weekNum);
    renderCalendar(plan, weekNum);
  }

  const grid = document.getElementById("weekGrid");
  if (!grid) return;
  const dayEl = Array.from(grid.querySelectorAll(".day")).find((d) => d.querySelector("h4")?.textContent === dayName);
  if (dayEl) {
    dayEl.scrollIntoView({ behavior: "smooth", block: "start" });
    flashDayElement(dayEl);
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

function convertRunForInjury(session, dayName, slot, reducePct) {
  const isBrickRun = slot === "PM" && (dayName === "Tue" || dayName === "Sat");
  const type = isBrickRun ? "Mobility" : "Bike";
  const substituteDetail = isBrickRun
    ? "Mobility/Elliptical. Keep cadence relaxed."
    : "Easy aerobic bike. No load.";
  const baseMins = durationToMinutes(session.duration) || durationToMinutes(DEFAULT_DURATION[type]);
  const duration = baseMins ? minutesToRange(baseMins, reducePct || 0.35) : (DEFAULT_DURATION[type] || session.duration || "-");
  const baseDetails = stripIntensityText(DEFAULT_DETAILS[type] || session.details, "easy");
  return {
    ...session,
    slot,
    type,
    duration,
    details: `No running. Substitute easy aerobic only. ${substituteDetail} ${baseDetails}`.trim(),
    _adapted: true,
    _alreadyReduced: true
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
      let adapted = false;

      if (protectRun && session.type === "Run") {
        session = convertRunForInjury(session, d, session.slot, reducePct);
        adapted = true;
      }

      if (!isNonTrainingType(session.type) && reducePct && session.duration !== "-" && !session._alreadyReduced) {
        const mins = session.type === "Race" ? 0 : durationToMinutes(session.duration);
        if (mins) {
          session.duration = minutesToRange(mins, reducePct);
          adapted = true;
        }
      }

      if (sick) {
        session.details = simplifyDetails(session.details, "rest");
        adapted = true;
      } else if (protectRun && s.type === "Run") {
        session.details = simplifyDetails(session.details, "easy");
        adapted = true;
      } else if (heavy) {
        const base = DEFAULT_DETAILS[session.type] || "";
        session.details = simplifyDetails(base || session.details, "easy");
        adapted = true;
      }

      if (session.type === "Off") {
        session.details = DEFAULT_DETAILS.Off;
      }

      if (adapted) session._adapted = true;
      return session;
    });
  }

  return { week: w, coachNote: coachNote.join(" ") };
}

function renderToday(plan, currentWeek) {
  const container = document.getElementById("todaySessions");
  if (!container) return;

  const now = new Date();
  const dayIndex = (now.getDay() + 6) % 7;
  const dayName = DAYS[dayIndex];

  const rawWeek = plan.weeks.find(x => x.week === currentWeek);
  if (!rawWeek) {
    container.innerHTML = `<div class="muted">No schedule for today.</div>`;
    return;
  }

  const w = normalizeWeek(rawWeek, rawWeek.week);
  const sessions = (w.days[dayName] || []).slice().sort((a, b) => slotIndex(a.slot) - slotIndex(b.slot));
  const weekChecks = getSessionChecks()[String(currentWeek)] || {};

  container.innerHTML = "";
  if (!sessions.length) {
    container.innerHTML = `<div class="muted">Rest day.</div>`;
    return;
  }

  sessions.forEach((s, idx) => {
    const isDone = !!(weekChecks[dayName] && weekChecks[dayName][String(idx)]);
    const box = createSessionCard(s, currentWeek, dayName, idx, isDone);
    container.appendChild(box);
  });

  if (!container.dataset.listenerAttached) {
    container.addEventListener("change", (e) => {
      const target = e.target;
      if (!target || !(target instanceof HTMLInputElement)) return;
      if (!target.matches(".done-toggle input")) return;

      const week = Number(target.dataset.week);
      const d = target.dataset.day;
      const idx = Number(target.dataset.idx);

      setSessionCheck(week, d, idx, target.checked);

      const card = target.closest('.session');
      if (card) {
        card.classList.toggle('done', target.checked);
      }

      updateWeeklyProgressForSelectedWeek(basePlanGlobal);

      const sel = document.getElementById("weekSelect");
      if (sel && Number(sel.value) === week) {
        renderWeek(getWorkingPlan(basePlanGlobal), week);
      }
      renderCalendar(getWorkingPlan(basePlanGlobal), Number(document.getElementById("weekSelect")?.value || week));
    });
    container.dataset.listenerAttached = "true";
  }
}

async function loadPlan() {
  const pageUrl = new URL(window.location.href);
  const candidates = [
    `${new URL("data/plan.json", pageUrl).href}?t=${Date.now()}`,
    `${pageUrl.origin}${pageUrl.pathname.replace(/\/[^/]*$/, "")}/data/plan.json?t=${Date.now()}`,
    `data/plan.json?t=${Date.now()}`
  ];

  const errors = [];
  const ts = Date.now();

  for (const url of candidates) {
    try {
      const res = await fetch(url.replace(/t=\d+$/, `t=${ts}`), { cache: "no-store" });
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

  const initialView = setPreferredCalendarView(getPreferredCalendarView());
  applyCalendarToggleState(initialView);

  buildWeekSelect(working, currentWeek);
  renderWeek(working, currentWeek);
  renderToday(working, currentWeek);
  renderCalendar(working, currentWeek);

  document.getElementById("weekSelect").addEventListener("change", (e) => {
    const w = Number(e.target.value);
    const p = getWorkingPlan(basePlan);
    renderWeek(p, w);
    renderCalendar(p, w);
  });

  const handleCalendarViewChange = (view) => {
    const p = getWorkingPlan(basePlan);
    const targetWeek = Number(document.getElementById("weekSelect")?.value || currentWeek);
    const v = setPreferredCalendarView(view);
    applyCalendarToggleState(v);
    renderCalendar(p, targetWeek);
  };

  const weekBtn = document.getElementById("calWeekBtn");
  const monthBtn = document.getElementById("calMonthBtn");
  if (weekBtn && monthBtn) {
    weekBtn.addEventListener("click", () => handleCalendarViewChange("week"));
    monthBtn.addEventListener("click", () => handleCalendarViewChange("month"));
  }

  const calendarView = document.getElementById("calendarView");
  if (calendarView) {
    calendarView.addEventListener("click", (e) => {
      const cell = e.target.closest?.(".cal-day");
      if (!cell || cell.classList.contains("is-dim")) return;
      const weekNum = Number(cell.dataset.week);
      const dayName = cell.dataset.day;
      if (!weekNum || !dayName) return;
      jumpToWeekDay(weekNum, dayName);
    });
  }

  document.getElementById("jumpToCurrent").addEventListener("click", () => {
    const p = getWorkingPlan(basePlan);
    currentWeek = computeCurrentWeek(p);
    buildWeekSelect(p, currentWeek);
    renderWeek(p, currentWeek);
    renderCalendar(p, currentWeek);
  });

  // Modal controls
  const modal = document.getElementById("adaptationModal");
  document.getElementById("openAdaptation").addEventListener("click", () => {
    modal.showModal();
  });
  document.getElementById("closeAdaptation").addEventListener("click", () => {
    modal.close();
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.close();
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
    renderCalendar(p2, weekNum);
  });

  document.getElementById("resetState").addEventListener("click", () => {
    resetOverrides();
    const p2 = getWorkingPlan(basePlan);
    const w = Number(document.getElementById("weekSelect").value);
    renderWeek(p2, w);
    renderCalendar(p2, w);
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
    renderCalendar(p2, w);
  });
}

main().catch(err => {
  console.error(err);
  alert("Failed to load plan. Check that /data/plan.json exists and GitHub Pages is serving it.");
});
