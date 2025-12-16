(() => {
  const weekSelect = document.getElementById('week-select');
  const weekGrid = document.getElementById('week-grid');
  const weekInfo = document.getElementById('week-info');
  const missedContainer = document.getElementById('missed-sessions');
  const jumpWeekBtn = document.getElementById('jump-week');
  const exportBtn = document.getElementById('export-state');
  const importBtn = document.getElementById('import-state');
  const importFile = document.getElementById('import-file');
  const form = document.getElementById('adapt-form');

  const stateKey = 'triAdaptations';
  let plan = null;
  let selectedWeekNumber = 1;
  let adaptations = loadStoredState();

  function loadStoredState() {
    const raw = localStorage.getItem(stateKey);
    if (!raw) return { selectedWeek: 1, weeks: {} };
    try {
      const parsed = JSON.parse(raw);
      return {
        selectedWeek: parsed.selectedWeek || 1,
        weeks: parsed.weeks || {}
      };
    } catch (e) {
      console.warn('Resetting stored state', e);
      return { selectedWeek: 1, weeks: {} };
    }
  }

  function saveState() {
    localStorage.setItem(
      stateKey,
      JSON.stringify({ selectedWeek: selectedWeekNumber, weeks: adaptations.weeks })
    );
  }

  function fetchPlan() {
    return fetch('data/plan.json')
      .then((res) => res.json())
      .then((data) => {
        plan = data;
        selectedWeekNumber = adaptations.selectedWeek || 1;
        renderWeekOptions();
        jumpToStoredWeek();
      })
      .catch((err) => {
        weekInfo.innerHTML = `<div class="alert">Failed to load plan: ${err}</div>`;
      });
  }

  function renderWeekOptions() {
    weekSelect.innerHTML = '';
    plan.weeks.forEach((week) => {
      const opt = document.createElement('option');
      opt.value = week.week;
      opt.textContent = `Week ${week.week} — ${week.phase}`;
      if (week.week === selectedWeekNumber) opt.selected = true;
      weekSelect.appendChild(opt);
    });
  }

  function getWeekByNumber(num) {
    return plan.weeks.find((w) => w.week === num);
  }

  function renderWeek() {
    const week = getWeekByNumber(selectedWeekNumber);
    if (!week) return;
    const appliedWeek = getAppliedWeek(week);

    weekInfo.innerHTML = `
      <h2>Week ${appliedWeek.week}: ${appliedWeek.phase}</h2>
      <div class="meta">
        <span>Hours target: <strong>${appliedWeek.hoursTarget}</strong></span>
        <span>Plan start: ${plan.startDate}</span>
        <span>Race: ${plan.raceDate}</span>
      </div>
      <ul class="notes">
        ${appliedWeek.notes.map((n) => `<li>${n}</li>`).join('')}
      </ul>
      <div class="alert">Adaptations persist locally. Export before clearing browser data.</div>
    `;

    renderMissedList(week);
    renderWeekGrid(appliedWeek);
  }

  function renderWeekGrid(week) {
    weekGrid.innerHTML = '';
    const daysOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    daysOrder.forEach((day) => {
      const dayCard = document.createElement('div');
      dayCard.className = 'day-card';
      const sessions = week.days[day] || [];
      dayCard.innerHTML = `<h3>${day}</h3>`;
      if (!sessions.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Rest / no sessions';
        dayCard.appendChild(empty);
      }
      sessions.forEach((session) => {
        const clone = document.getElementById('session-template').content.cloneNode(true);
        clone.querySelector('.session-type').innerHTML = `${capitalize(session.type)} <span class="badge ${session.priority}">${session.priority}</span> ${session.optional ? '<span class="badge optional">optional</span>' : ''}`;
        clone.querySelector('.session-details').textContent = `${session.duration ? session.duration + ' min — ' : ''}${session.details}`;
        dayCard.appendChild(clone);
      });
      weekGrid.appendChild(dayCard);
    });
  }

  function renderMissedList(week) {
    missedContainer.innerHTML = '';
    const missed = getKeySessions(week);
    if (!missed.length) {
      missedContainer.textContent = 'No high-priority sessions this week.';
      return;
    }
    missed.forEach((item, idx) => {
      const id = `missed-${idx}`;
      const label = document.createElement('label');
      label.setAttribute('for', id);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = id;
      checkbox.value = `${item.day}|${item.index}`;
      label.appendChild(checkbox);
      label.append(` ${item.day} — ${capitalize(item.session.type)} (${item.session.duration} min)`);
      missedContainer.appendChild(label);
    });
  }

  function getKeySessions(week) {
    const result = [];
    Object.entries(week.days).forEach(([day, sessions]) => {
      sessions.forEach((s, idx) => {
        if (s.priority === 'high' && !s.optional) {
          result.push({ day, session: s, index: idx });
        }
      });
    });
    return result;
  }

  function getAppliedWeek(baseWeek) {
    const stored = adaptations.weeks[baseWeek.week];
    if (!stored) return baseWeek;
    return { ...baseWeek, days: stored.days };
  }

  function parseFormInputs() {
    const formData = new FormData(form);
    const soreness = (formData.get('soreness') || '').toString().toLowerCase();
    const inputs = {
      fatigue: formData.get('fatigue'),
      sleep: formData.get('sleep'),
      soreness: soreness
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      illness: document.getElementById('illness').checked,
      injury: document.getElementById('injury').checked,
      missed: Array.from(missedContainer.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.value)
    };
    return inputs;
  }

  function adaptWeek(event) {
    event.preventDefault();
    const week = getWeekByNumber(selectedWeekNumber);
    if (!week) return;
    const inputs = parseFormInputs();
    const adapted = applyRules(week, inputs);
    adaptations.weeks[selectedWeekNumber] = { days: adapted.days, inputs };
    saveState();
    renderWeek();
  }

  function applyRules(week, inputs) {
    const newWeek = { ...week, days: cloneDays(week.days) };

    if (inputs.missed.length) {
      inputs.missed.forEach((token) => {
        const [day, idx] = token.split('|');
        if (newWeek.days[day]) {
          newWeek.days[day].splice(Number(idx), 1);
        }
      });
    }

    if (inputs.illness) {
      Object.values(newWeek.days).forEach((sessions) => {
        sessions.forEach((s) => {
          s.details = `${s.details} (keep easy while ill)`;
          s.duration = Math.round(s.duration * 0.7);
          s.optional = true;
        });
      });
    }

    if (inputs.injury) {
      Object.values(newWeek.days).forEach((sessions) => {
        sessions.forEach((s) => {
          if (s.type === 'run') {
            s.type = 'elliptical/walk';
            s.details = 'Replace run with elliptical or brisk walk, focus on symmetry';
          }
          if (s.type === 'bike') {
            s.details = `${s.details} (easy spin, seated)`;
            s.priority = 'moderate';
          }
        });
      });
    }

    if (inputs.fatigue === 'high' || inputs.sleep === 'poor') {
      Object.values(newWeek.days).forEach((sessions) => {
        sessions.forEach((s) => {
          s.duration = Math.round(s.duration * 0.75);
          s.details = `${s.details} (keep Z1-Z2 effort)`;
          if (s.priority === 'high') s.priority = 'moderate';
        });
      });
    }

    if (hasLowerBodySoreness(inputs.soreness)) {
      let swapped = false;
      Object.values(newWeek.days).forEach((sessions) => {
        sessions.forEach((s) => {
          if (s.type === 'run') {
            s.duration = Math.min(s.duration, 45);
            if (!swapped) {
              s.type = 'elliptical/walk';
              s.details = 'Swap run for low-impact aerobic to protect lower body';
              swapped = true;
            }
          }
        });
      });
    }

    return newWeek;
  }

  function cloneDays(days) {
    const copy = {};
    Object.entries(days).forEach(([day, sessions]) => {
      copy[day] = sessions.map((s) => ({ ...s }));
    });
    return copy;
  }

  function hasLowerBodySoreness(parts) {
    const keywords = ['quad', 'calf', 'ham', 'glute', 'hip', 'knee', 'ankle', 'leg', 'foot'];
    return parts.some((part) => keywords.some((k) => part.includes(k)));
  }

  function jumpToCurrentWeek() {
    const today = new Date();
    const start = new Date(plan.startDate);
    const diff = Math.floor((today - start) / (1000 * 60 * 60 * 24));
    const weekNumber = Math.min(plan.weeks.length, Math.max(1, Math.floor(diff / 7) + 1));
    selectedWeekNumber = weekNumber;
    weekSelect.value = weekNumber;
    adaptations.selectedWeek = weekNumber;
    saveState();
    renderWeek();
  }

  function jumpToStoredWeek() {
    if (adaptations.selectedWeek) {
      selectedWeekNumber = adaptations.selectedWeek;
      weekSelect.value = selectedWeekNumber;
    }
    renderWeek();
  }

  function handleWeekChange(event) {
    selectedWeekNumber = Number(event.target.value);
    adaptations.selectedWeek = selectedWeekNumber;
    saveState();
    renderWeek();
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function exportState() {
    const data = localStorage.getItem(stateKey) || '{}';
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tri-adaptations.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function importState() {
    const file = importFile.files[0];
    if (!file) {
      alert('Choose a JSON file first.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        adaptations = {
          selectedWeek: parsed.selectedWeek || 1,
          weeks: parsed.weeks || {}
        };
        selectedWeekNumber = adaptations.selectedWeek;
        renderWeekOptions();
        weekSelect.value = selectedWeekNumber;
        saveState();
        renderWeek();
      } catch (error) {
        alert('Invalid JSON file.');
      }
    };
    reader.readAsText(file);
  }

  weekSelect.addEventListener('change', handleWeekChange);
  jumpWeekBtn.addEventListener('click', jumpToCurrentWeek);
  form.addEventListener('submit', adaptWeek);
  exportBtn.addEventListener('click', exportState);
  importBtn.addEventListener('click', importState);

  fetchPlan();
})();
