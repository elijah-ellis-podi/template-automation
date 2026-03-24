# Setup Guide

## Prerequisites

- Node.js >= 18
- pnpm 10+
- Python 3.9+ (3.12 recommended)
- An Anthropic API key (for Claude Vision model)

---

## 1. Frontend (React app)

```bash
cd template-automation
pnpm install
pnpm dev
```

The dev server starts at `http://localhost:5173`.

### Authenticating against the dev environment

On localhost the app defaults to LOCAL mode with mock data. To use real data from `tmplt.dev.podimetrics.com`:

1. Open `https://tmplt.dev.podimetrics.com` in your browser and log in with the test credentials.
2. Open browser DevTools (F12) > Application > Local Storage > `tmplt.dev.podimetrics.com`.
3. Copy the value of the `__podi` key.
4. On your `http://localhost:5173` tab, open the browser console and run:

```js
localStorage.setItem('__podi', '<paste the token here>')
```

5. Refresh the page. The Auto Keypoint Demo tab will now fetch real patient/scan data from the dev API.

---

## 2. Keypoint detection server (Python)

```bash
cd template-automation/keypoint_automation

python3 -m venv .venv
source .venv/bin/activate

pip install -r requirements.txt
pip install fastapi uvicorn

export ANTHROPIC_API_KEY=sk-ant-...your-key-here...

uvicorn server:app --port 8787 --reload
```

The server starts at `http://localhost:8787`. The `--reload` flag watches for file changes and auto-restarts — no manual restart needed when editing Python code.

Verify it's running:

```bash
curl http://localhost:8787/health
```

Expected response:
```json
{"status": "ok", "anthropic_key_set": true, "models": ["geometric", "claude", "ensemble"]}
```

### Running without Claude (geometric only)

If you don't have an Anthropic API key, the server still starts. The geometric model works without it. Claude requests will return an error message per-model, but won't crash the server.

---

## 3. Using the Auto Keypoint Demo

1. Start both the frontend (`pnpm dev`) and the Python server (`uvicorn server:app --port 8787 --reload`).
2. Navigate to the **Auto Keypoint Demo** tab.
3. Enter a patient ID. Good test patients on `tmplt.dev.podimetrics.com`:
   - `fa4a56521d93238218b29d027b4d32c6` — TT-0002, 15 scans
   - `3c0cb0a1fcaf2414056dc28062bf4445` — JD-022952, 6 scans
4. Click **Load Patient**, select a scan, then click **Run All Models**.
5. Claude Vision takes 5–15 seconds. Geometric is instant.

---

## Ports summary

| Service | Port | URL |
|---|---|---|
| Vite dev server (frontend) | 5173 | `http://localhost:5173` |
| Keypoint detection server (Python) | 8787 | `http://localhost:8787` |
| PADS API (dev env) | 443 | `https://tmplt.dev.podimetrics.com/api/v1` |
