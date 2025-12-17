# Adaptive Triathlon Training Plan (Static)

This repository is a no-dependency static site that renders a triathlon training plan and lets you apply safety-first adaptations in the browser. It is designed to live on GitHub Pages with everything running client-side (HTML/CSS/vanilla JS and a static `data/plan.json`).

## Repository structure
```
/ (root)
├── index.html
├── css/
│   └── style.css
├── js/
│   └── app.js
├── data/
│   └── plan.json
├── .nojekyll
└── README.md
```

## Running locally
Open `index.html` in a browser. Because all data is fetched from `data/plan.json`, you do not need a server.

## Features at a glance
- **Adaptive toggles:** flag illness, injury, fatigue, or soreness to automatically soften every workout.
- **Client-side persistence:** adaptations live in `localStorage` so refreshing the page keeps your choices.
- **Data-driven schedule:** the weekly plan loads entirely from `data/plan.json`, making edits lightweight and reviewable.

## Usage
1. Clone or download this repository.
2. Open `index.html` in your browser, or run a simple static server (e.g., `python -m http.server 8000`) and visit `http://localhost:8000`.
3. Use the left-side controls to set the start date, export/import adaptations, and toggle safety adaptations for your current state.
4. Browse the weekly cards to see the adjusted sessions and guidance.

## Publishing with GitHub Pages (no terminal needed)
1. Push these files to your GitHub repository.
2. In the GitHub web UI, go to **Settings → Pages**.
3. Under **Build and deployment**, select **Deploy from a branch**.
4. Choose the default branch (e.g., `main`) and the root folder (`/`).
5. Click **Save**. GitHub Pages will build and publish. Your site will be available at `https://<your-username>.github.io/<repo-name>/`.

## Updating the training plan
The schedule lives in `data/plan.json` and uses this shape:

- `title`: Plan name
- `startDate`: ISO date string for week 1 start (used to jump to current week)
- `raceDate`: ISO date string for the target event
- `weeks`: Array of week objects
  - `week`: Week number (1-based)
  - `phase`: Descriptive phase (e.g., "Reconditioning")
  - `hoursTarget`: Planned hours for the week
  - `notes`: Array of bullet strings to display under the week header
  - `days`: Object with keys `Mon` through `Sun`, each containing an array of sessions
    - Each session includes `slot` (`AM`|`PM`), `type`, `duration` (string), and `details` (string).

To add more weeks:
1. Open `data/plan.json` in the GitHub web editor.
2. Copy an existing week object within the `weeks` array and adjust the values.
3. Keep day keys consistent (`Mon`..`Sun`) and ensure valid JSON formatting.
4. Commit the change. The site will automatically use the new data on next load.

## Adaptation logic (browser-side)
- Illness flag: shortens both sessions each day and rewrites details to stay easy/steady.
- Injury flag: trims duration and removes interval language while keeping AM/PM slots intact.
- High fatigue or poor sleep: reduces durations ~25% and keeps guidance neutral and steady.
- Soreness entry: softens every session to smooth, even pacing.
- Adaptations persist in `localStorage`; you can export/import the JSON state via the buttons in the UI.

## Notes
- No external libraries or build steps are required.
- `.nojekyll` is included so GitHub Pages serves the `data` directory without processing.
