const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const STORAGE_KEY = "triPlanState_v1";
let weekGridListenerAttached = false;
let basePlanGlobal = null;

const ROLE_PRIMARY = "primary";
const ROLE_SUPPORT = "support";

function parseIsoDate(s) {
  const [y,m,d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m-1, d));
}

function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000*60*60*24));
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

function inferRoleFromLegacy(session, hasPrimary) {
  if (session.role === ROLE_PRIMARY || session.role === ROLE_SUPPORT) {
    return session.role;
  }
  if (!hasPrimary && session.priority === "high" && !session.optional && session.type !== "Off") {
    return ROLE_PRIMARY;
  }
  if (!hasPrimary && session.priority === "medium" && !session.optional && session.type !== "Off") {
    return ROLE_PRIMARY;
  }
  return ROLE_SUPPORT;
}

function normalizeDaySessions(sessions = []) {
  let primaryFound = false;
  return sessions.map((s) => {
    const role = inferRoleFromLegacy(s, primaryFound);
    if (role === ROLE_PRIMARY) primaryFound = true;
    return { ...s, role };
  }).map((s, idx, arr) => {
    if (s.type === "Off") {
      return { ...s, role: ROLE_SUPPORT };
    }
    if (s.role === ROLE_PRIMARY) return s;
    if (!arr.some((x) => x.role === ROLE_PRIMARY && x.type !== "Off")) {
      return { ...s, role: idx === 0 ? ROLE_PRIMARY : ROLE_SUPPORT };
    }
    return { ...s, role: ROLE_SUPPORT };
  });
}

function normalizeWeekRoles(week) {
  const w = deepClone(week);
  for (const d of DAYS) {
    w.days[d] = normalizeDaySessions(w.days[d] || []);
  }
  return w;
}

function softenSupportSession(session) {
  const easyLabel = session.type === "Swim" ? "Easy float / drills" : "Mobility / easy aerobic";
  const fallbackType = session.type === "Swim" ? "Swim" : "Mobility";
  const baseDuration = session.type === "Swim" ? "20–30m" : "15–25m";
  return {
    ...session,
    type: fallbackType,
    role: ROLE_SUPPORT,
    priority: "low",
    optional: session.optional ?? false,
    duration: baseDuration,
    details: `${easyLabel}. Keep it restorative only.`
  };
}

function softenPrimarySession(session, reduction = 0.25) {
  if (session.type === "Off") return { ...session, role: ROLE_SUPPORT };
  const mins = durationToMinutes(session.duration);
  const newDur = mins ? minutesToRange(mins, reduction) : session.duration;
  return {
    ...session,
    role: ROLE_PRIMARY,
    priority: session.priority === "high" ? "medium" : session.priority,
    duration: newDur,
    details: `Keep it easy/steady; no intensity. ${session.details || ""}`.trim()
  };
}

function durationToMinutes(s) {
  if (!s || s === "-") return 0;
  // supports "90–105m", "2:00–2:20", "45m"
  const parts = String(s).split("–").map(p => p.trim());
  const parseOne = (t) => {
    if (t.includes(":")) {
      const [hh, mm] = t.split(":").map(Number);
      return hh*60 + mm;
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
  // pct reduces minutes (e.g. 0.3 => -30%)
  const m = Math.max(0, Math.round(mins * (1 - pct)));
  if (m >= 120) {
    const hh = Math.floor(m/60), mm = m%60;
    return `${hh}:${String(mm).padStart(2,"0")}`;
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
  let keyPlanned = 0;
  let keyDone = 0;

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

      const isKey = s.priority === "high" && !s.optional && s.type !== "Off";
      if (isKey) {
        keyPlanned += 1;
        if (isChecked) keyDone += 1;
      }
    });
  }

  return { plannedSessions, completedSessions, plannedMinutes, completedMinutes, keyPlanned, keyDone };
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
  el.textContent = `Start: ${plan.startDate} • Race: ${plan.raceDate} • Rules-first adaptive plan`;
}

function getWorkingPlan(plan) {
  const local = loadLocal();
  const p = deepClone(plan);
  if (!local) {
    p.weeks = p.weeks.map(normalizeWeekRoles);
    return p;
  }
  // local stores per-week overridden days + notes
  if (local.weekOverrides) {
    for (const [weekNum, override] of Object.entries(local.weekOverrides)) {
      const w = p.weeks.find(x => String(x.week) === String(weekNum));
      if (!w) continue;
      if (override.days) w.days = override.days;
      if (override.coachNote) w._coachNote = override.coachNote;
    }
  }
  p.weeks = p.weeks.map(normalizeWeekRoles);
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

function renderWeeklyProgress(w, weekNum) {
  const grid = document.getElementById("weekGrid");
  if (!grid) return;

  const summaryBox = document.getElementById("weeklyProgress") || document.createElement("div");
  summaryBox.id = "weeklyProgress";
  summaryBox.className = "weekly-progress";

  if (grid.parentNode && summaryBox.parentNode !== grid.parentNode) {
    grid.parentNode.insertBefore(summaryBox, grid);
  }

  const local = loadLocal() || {};
  const checks = (local.sessionChecks && local.sessionChecks[String(weekNum)]) || {};

  let plannedSessions = 0;
  let completedSessions = 0;
  let plannedMinutes = 0;
  let doneMinutes = 0;
  let keyPlanned = 0;
  let keyDone = 0;

  DAYS.forEach((d) => {
    const sessions = w.days[d] || [];
    sessions.forEach((s, idx) => {
      if (s.type === "Off") return;
      plannedSessions += 1;
      const dur = durationToMinutes(s.duration);
      plannedMinutes += dur;
      const isDone = checks?.[d]?.[String(idx)] === true;
      if (isDone) {
        completedSessions += 1;
        doneMinutes += dur;
      }
      const isKey = s.priority === "high" && !s.optional;
      if (isKey) {
        keyPlanned += 1;
        if (isDone) keyDone += 1;
      }
    });
  });

  const barPct = plannedMinutes ? Math.min(100, Math.round((doneMinutes / plannedMinutes) * 100)) : 0;
  const fatigue = document.getElementById("fatigue")?.value;
  const sleep = document.getElementById("sleep")?.value;
  const cautionNote = (fatigue === "high" || sleep === "poor")
    ? `<div class="weekly-progress__note muted">Focus this week: reduce load, protect key sessions.</div>`
    : "";

  summaryBox.innerHTML = `
    <div class="weekly-progress__title"><strong>Weekly progress</strong></div>
    <div class="weekly-progress__grid">
      <div><div class="k">Planned</div><div class="v">${plannedSessions} sessions • ${minutesToHHMM(plannedMinutes)}</div></div>
      <div><div class="k">Completed</div><div class="v">${completedSessions} sessions • ${minutesToHHMM(doneMinutes)}</div></div>
      <div><div class="k">Key sessions</div><div class="v">${keyDone} / ${keyPlanned} done</div></div>
    </div>
    <div class="weekly-progress__bar" aria-hidden="true">
      <div class="weekly-progress__barFill" style="width:${barPct}%"></div>
    </div>
    <div class="weekly-progress__note muted">
      Aim: consistency. Don’t stack sessions to “make up” missed work.
    </div>
    ${cautionNote}
  `;
}

function updateWeeklyProgress(weekNum) {
  if (!basePlanGlobal) return;
  const plan = getWorkingPlan(basePlanGlobal);
  const w = plan.weeks.find((x) => x.week === weekNum);
  if (!w) return;
  renderWeeklyProgress(w, weekNum);
}

function renderWeek(plan, weekNum) {
  const rawWeek = plan.weeks.find(x => x.week === weekNum);
  if (!rawWeek) return;
  const w = normalizeWeekRoles(rawWeek);
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

  const routineNote = document.getElementById("routineNote") || document.createElement("div");
  routineNote.id = "routineNote";
  routineNote.className = "routine-note";
  routineNote.textContent = "Two sessions per day are intentional. Support sessions aid recovery and mental routine, not fitness load.";
  if (summary.parentNode && routineNote.parentNode !== summary.parentNode) {
    summary.insertAdjacentElement("afterend", routineNote);
  }

  coachNote.textContent = w._coachNote ? `Coach note: ${w._coachNote}` : "";

  renderWeeklyProgress(w, weekNum);

  grid.innerHTML = "";

  for (const d of DAYS) {
    const day = document.createElement("div");
    day.className = "day";
    day.innerHTML = `<h4>${d}</h4>`;
    const sessions = w.days[d] || [];
    let totalSessions = 0;
    let doneSessions = 0;
    sessions.forEach((s, idx) => {
      const box = document.createElement("div");
      const isDone = !!(weekChecks[d] && weekChecks[d][String(idx)]);
      const isOff = s.type === "Off";
      const roleClass = s.role === ROLE_SUPPORT ? "support" : "primary";
      const roleLabel = roleClass === "support" ? "Support" : "Primary";
      box.className = `session ${roleClass}${isDone ? " done" : ""}`;
      box.dataset.type = s.type;
      box.dataset.role = roleClass;
      const pr = s.optional ? "opt" : (s.priority === "high" ? "high" : "");
      const tagText = s.optional ? "Optional" : (s.priority || "medium");
      const doneToggle = isOff ? "" : `
        <label class="done-toggle">
          <input type="checkbox" data-week="${weekNum}" data-day="${d}" data-idx="${idx}" ${isDone ? "checked" : ""}>
          <span>Done</span>
        </label>`;
      box.innerHTML = `
        <div class="top">
          <div class="session-title">
            <span class="role-badge ${roleClass}">${roleLabel}</span>
            <strong>${s.type}</strong>
          </div>
          <div class="top-right">
            <span class="tag ${pr}">${tagText}</span>
            ${doneToggle}
          </div>
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

  // Build missed key-session checklist
  missedList.innerHTML = "";
  const keySessions = [];
  for (const d of DAYS) {
    (w.days[d] || []).forEach((s, i) => {
      if (s.optional) return;
      if (s.priority === "high") {
        keySessions.push({ day: d, idx: i, label: `${d}: ${s.type} (${s.duration})` });
      }
    });
  }
  if (keySessions.length === 0) {
    missedList.innerHTML = `<div class="muted">No key sessions flagged this week.</div>`;
  } else {
    keySessions.forEach((k, j) => {
      const id = `miss_${j}`;
      const row = document.createElement("label");
      row.className = "checkbox";
      row.innerHTML = `<input type="checkbox" id="${id}" data-day="${k.day}" data-idx="${k.idx}"> ${k.label}`;
      missedList.appendChild(row);
    });
  }

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
      const dayEl = target.closest('.day');
      if (dayEl) {
        const progressEl = dayEl.querySelector('.day-progress');
        if (progressEl) {
          const cards = [...dayEl.querySelectorAll('.session')].filter(c => c.dataset.type !== "Off");
          const doneCount = cards.filter(c => c.classList.contains('done')).length;
          progressEl.textContent = `Done: ${doneCount} / ${cards.length}`;
        }
      }
      updateWeeklyProgressForSelectedWeek(basePlanGlobal);
    });
    weekGridListenerAttached = true;
  }
}

function renderWeeklyProgress(weekObj, weekNum) {
  const summary = document.getElementById("weekSummary");
  if (!summary) return;

  let wp = document.getElementById("weeklyProgress");
  if (!wp) {
    wp = document.createElement("div");
    wp.id = "weeklyProgress";
    wp.className = "weekly-progress";
    summary.insertAdjacentElement("afterend", wp);
  }

  const { plannedSessions, completedSessions, plannedMinutes, completedMinutes, keyPlanned, keyDone } = computeWeeklyTotals(weekObj, weekNum);
  const barPct = plannedMinutes > 0 ? Math.min(100, Math.round((completedMinutes / plannedMinutes) * 100)) : 0;

  wp.innerHTML = `
  <div class="weekly-progress__grid">
    <div><div class="k">Planned</div><div class="v">${plannedSessions} sessions • ${minutesToHHMM(plannedMinutes)}</div></div>
    <div><div class="k">Completed</div><div class="v">${completedSessions} sessions • ${minutesToHHMM(completedMinutes)}</div></div>
    <div><div class="k">Key sessions</div><div class="v">${keyDone} / ${keyPlanned}</div></div>
  </div>
  <div class="weekly-progress__bar" aria-hidden="true">
    <div class="weekly-progress__barFill" style="width:${barPct}%"></div>
  </div>
`;
}

function updateWeeklyProgressForSelectedWeek(plan) {
  if (!plan) return;
  const sel = document.getElementById("weekSelect");
  if (!sel) return;
  const weekNum = Number(sel.value);
  const working = getWorkingPlan(plan);
  const w = working.weeks.find(x => x.week === weekNum);
  if (!w) return;
  renderWeeklyProgress(w, weekNum);
}

function applyRulesToWeek(week, state, missedKey) {
  const w = deepClone(normalizeWeekRoles(week));
  const soreness = (state.soreness || "")
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);

  const heavy = (state.fatigue === "high") || (state.sleep === "poor");
  const sick = !!state.illness;
  const injured = !!state.injury;

  let coachNote = [];

  // Rule 1: illness/injury => remove intensity; keep easy movement if possible
  if (sick) {
    coachNote.push("Sick flag: remove intensity. Keep only easy swim/bike if symptoms are mild and improving; otherwise rest.");
    for (const d of DAYS) {
      w.days[d] = (w.days[d] || []).map(s => {
        if (s.type === "Off") return { ...s, role: ROLE_SUPPORT };
        if (s.role === ROLE_SUPPORT) {
          const softened = softenSupportSession(s);
          return { ...softened, optional: s.optional ?? false, details: `SICK MODE SUPPORT: mobility / float only.` };
        }
        return {
          ...softenPrimarySession(s, 0.35),
          optional: true,
          priority: "low",
          details: `SICK MODE: easy only. ${s.details || ""}`.trim()
        };
      });
    }
    return { week: w, coachNote: coachNote.join(" ") };
  }

  if (injured) {
    coachNote.push("Injury warning: protect the run. Substitute run with swim/elliptical and keep bike easy.");
    for (const d of DAYS) {
      w.days[d] = (w.days[d] || []).map(s => {
        if (s.type === "Run") {
          return { ...s, type: "Elliptical / Walk", role: s.role, priority: "low", optional: true, details: `INJURY MODE: replace running. ${s.details || ""}` };
        }
        if (s.type === "Bike") {
          return { ...s, role: s.role, priority: "low", optional: true, details: `INJURY MODE: easy spin only. ${s.details || ""}` };
        }
        if (s.role === ROLE_SUPPORT) {
          return softenSupportSession(s);
        }
        return { ...s, role: s.role };
      });
    }
  }

  // Rule 2: high fatigue or poor sleep => reduce volume 20–30% and strip “work”
  if (heavy) {
    coachNote.push("Fatigue/sleep flag: reduce durations ~25% and keep intensity controlled.");
    for (const d of DAYS) {
      w.days[d] = (w.days[d] || []).map(s => {
        if (s.type === "Off") return s;
        if (s.role === ROLE_SUPPORT) {
          return softenSupportSession(s);
        }
        const mins = durationToMinutes(s.duration);
        const newDur = mins ? minutesToRange(mins, 0.25) : s.duration;
        const softened = { ...s, duration: newDur, role: s.role };
        softened.details = `FATIGUE ADAPT: keep it easy/steady, no pushing. ${s.details || ""}`.trim();
        if (s.priority === "high") softened.priority = "medium";
        return softened;
      });
    }
  }

  // Rule 3: missed key sessions => don’t cram; preserve long bike and run frequency
  if (missedKey.length > 0) {
    coachNote.push("Missed key session(s): do not stack. Preserve long bike; keep runs easy and consistent.");
    // Mark missed key sessions as optional (dropped) instead of shuffling blindly
    missedKey.forEach(({ day, idx }) => {
      const ses = w.days[day]?.[idx];
      if (ses) {
        w.days[day][idx] = { ...ses, role: ses.role, optional: true, details: `MISSED: dropped to avoid stacking. ${ses.details || ""}`.trim() };
      }
    });
  }

  // Rule 4: soreness-specific swaps
  if (soreness.some(s => ["calf","achilles","shin","knee","hip"].includes(s))) {
    coachNote.push("Lower-body soreness: cap running and keep it flat/easy. Swap one run for swim/elliptical if needed.");
    let runCount = 0;
    for (const d of DAYS) {
      w.days[d] = (w.days[d] || []).map(s => {
        if (s.type !== "Run") return s;
        runCount++;
        if (runCount >= 2) {
          return { ...s, type: "Elliptical", role: s.role, optional: true, priority: "low", details: `SORENESS SWAP: replace run if niggle persists. ${s.details || ""}` };
        }
        return { ...s, role: s.role, details: `SORENESS: keep flat and easy. ${s.details || ""}`.trim() };
      });
    }
  }

  return { week: w, coachNote: coachNote.join(" ") };
}

async function loadPlan() {
  const res = await fetch("./data/plan.json");
  if (!res.ok) {
    throw new Error(`Failed to fetch plan.json: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function main() {
  const res = await fetch("./data/plan.json");
  if (!res.ok) {
    throw new Error(`Failed to fetch plan.json: ${res.status} ${res.statusText}`);
  }
  const basePlan = await res.json();
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

    const missedKey = [...document.querySelectorAll("#missedList input[type=checkbox]")]
      .filter(cb => cb.checked)
      .map(cb => ({ day: cb.dataset.day, idx: Number(cb.dataset.idx) }));

    const { week: adapted, coachNote } = applyRulesToWeek(w, state, missedKey);
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
