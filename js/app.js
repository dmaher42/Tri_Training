const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const STORAGE_KEY = "triPlanState_v1";

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

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

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

function minutesToRange(mins, pct = 0) {
  // pct reduces minutes (e.g. 0.3 => -30%)
  const m = Math.max(0, Math.round(mins * (1 - pct)));
  if (m >= 120) {
    const hh = Math.floor(m/60), mm = m%60;
    return `${hh}:${String(mm).padStart(2,"0")}`;
  }
  return `${m}m`;
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
  if (!local) return deepClone(plan);
  // local stores per-week overridden days + notes
  const p = deepClone(plan);
  if (local.weekOverrides) {
    for (const [weekNum, override] of Object.entries(local.weekOverrides)) {
      const w = p.weeks.find(x => String(x.week) === String(weekNum));
      if (!w) continue;
      if (override.days) w.days = override.days;
      if (override.coachNote) w._coachNote = override.coachNote;
    }
  }
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

function renderWeek(plan, weekNum) {
  const w = plan.weeks.find(x => x.week === weekNum);
  const summary = document.getElementById("weekSummary");
  const grid = document.getElementById("weekGrid");
  const coachNote = document.getElementById("coachNote");
  const missedList = document.getElementById("missedList");

  let strengthCount = 0;

  summary.innerHTML = `
    <div><strong>Phase:</strong> ${w.phase}</div>
    <div><strong>Target:</strong> ${w.hoursTarget}</div>
    <div><strong>Notes:</strong> ${w.notes.map(n => `<div>• ${n}</div>`).join("")}</div>
  `;

  coachNote.textContent = w._coachNote ? `Coach note: ${w._coachNote}` : "";

  grid.innerHTML = "";

  // Strength recommendation pre-pass
  const strengthScores = {};
  const candidates = [];
  DAYS.forEach((d, idx) => {
    const sessions = w.days[d] || [];
    let score = 0;
    const hasBike = sessions.some(s => s.type === "Bike");
    const hasRun = sessions.some(s => s.type === "Run");
    const hasSwim = sessions.some(s => s.type === "Swim");
    const hasOff = sessions.some(s => s.type === "Off");

    if (sessions.some(s => s.type === "Bike" && (s.priority === "high" || durationToMinutes(s.duration) >= 120))) {
      score -= 3;
    }

    if (sessions.some(s => s.type === "Run" && s.priority === "high")) {
      score -= 2;
    }

    if (hasSwim && !hasBike && !hasRun) {
      score += 3;
    }

    if (hasOff) {
      score += 2;
    }

    if (sessions.length >= 2) {
      score -= 1;
    }

    if (sessions.length > 0 && sessions.every(s => s.optional)) {
      score += 1;
    }

    strengthScores[d] = score;
    candidates.push({ day: d, score, idx });
  });

  const goodDays = candidates.filter(c => c.score >= 2);
  const recommendCount = goodDays.length >= 2 ? 3 : 2;
  const recommendedStrengthDays = new Set(
    [...candidates]
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .slice(0, recommendCount)
      .map(c => c.day)
  );

  for (const d of DAYS) {
    const day = document.createElement("div");
    day.className = "day";
    day.innerHTML = `<h4>${d}</h4>`;
    const sessions = w.days[d] || [];
    sessions.forEach((s, idx) => {
      const box = document.createElement("div");
      box.className = "session";
      const pr = s.optional ? "opt" : (s.priority === "high" ? "high" : "");
      const tagText = s.optional ? "Optional" : (s.priority || "medium");
      box.innerHTML = `
        <div class="top">
          <strong>${s.type}</strong>
          <span class="tag ${pr}">${tagText}</span>
        </div>
        <div class="muted">${s.duration}</div>
        <p>${s.details || ""}</p>
      `;
      day.appendChild(box);
    });

    // Optional support session block (non-load-bearing, complementary)
    const existingTypes = new Set(
      sessions.map(s => s.type)
    );

    const options = [];

    if (!existingTypes.has("Swim")) {
      options.push("Easy swim 20–40 min");
    }

    if (!existingTypes.has("Bike")) {
      options.push("Easy spin 30–45 min (high cadence)");
    }

    // Always allowed
    options.push("Mobility reset 10–15 min");

    const strengthScore = strengthScores[d] ?? 0;
    let strengthLabel = "Strength foundation 15–25 min (recommended)";

    if (recommendedStrengthDays.has(d)) {
      strengthLabel = "✅ Strength foundation 15–25 min (best day)";
    } else if (strengthScore <= -2) {
      strengthLabel = "⚠️ Strength (not ideal today — keep it very light or skip)";
    }

    if (strengthCount === 2) {
      strengthLabel = "Strength foundation 15–25 min (optional – limit reached)";
    }

    if (strengthCount >= 3) {
      strengthLabel = "Strength foundation (skip today – already 3× this week)";
    }

    options.push(strengthLabel);
    strengthCount++;

    const support = document.createElement("div");
    support.className = "support";

    support.innerHTML = `
      <div class="top">
        <strong>Optional Support Session</strong>
        <span class="tag opt">Non-load</span>
      </div>
      <p class="muted">Choose ONE (keep it easy):</p>
      <ul>
        ${options.map(o => `<li>${o}</li>`).join("")}
      </ul>
      <p class="muted">Purpose: sleep, recovery, routine. Never add fatigue.</p>
    `;
    day.appendChild(support);

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
}

function applyRulesToWeek(week, state, missedKey) {
  const w = deepClone(week);
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
        if (s.type === "Off") return s;
        return {
          ...s,
          priority: "low",
          optional: true,
          details: `SICK MODE: easy only. ${s.details || ""}`.trim(),
          duration: s.type === "Swim" ? "20–30m" : "30–45m"
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
          return { ...s, type: "Elliptical / Walk", priority: "low", optional: true, details: `INJURY MODE: replace running. ${s.details || ""}` };
        }
        if (s.type === "Bike") {
          return { ...s, priority: "low", optional: true, details: `INJURY MODE: easy spin only. ${s.details || ""}` };
        }
        return s;
      });
    }
  }

  // Rule 2: high fatigue or poor sleep => reduce volume 20–30% and strip “work”
  if (heavy) {
    coachNote.push("Fatigue/sleep flag: reduce durations ~25% and keep intensity controlled.");
    for (const d of DAYS) {
      w.days[d] = (w.days[d] || []).map(s => {
        if (s.type === "Off") return s;
        const mins = durationToMinutes(s.duration);
        const newDur = mins ? minutesToRange(mins, 0.25) : s.duration;
        const softened = { ...s, duration: newDur };
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
        w.days[day][idx] = { ...ses, optional: true, details: `MISSED: dropped to avoid stacking. ${ses.details || ""}`.trim() };
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
          return { ...s, type: "Elliptical", optional: true, priority: "low", details: `SORENESS SWAP: replace run if niggle persists. ${s.details || ""}` };
        }
        return { ...s, details: `SORENESS: keep flat and easy. ${s.details || ""}`.trim() };
      });
    }
  }

  return { week: w, coachNote: coachNote.join(" ") };
}

async function main() {
  const res = await fetch("./data/plan.json");
  if (!res.ok) {
    throw new Error(`Failed to fetch plan.json: ${res.status} ${res.statusText}`);
  }
  const basePlan = await res.json();
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
