# Template Automation (Brannock Web)

Web migration of the Brannock desktop application — a Podimetrics internal tool for generating foot templates from patient thermal scan data.

## Prerequisites

- Node.js >= 18
- pnpm 10+

## Getting started

```bash
pnpm install
pnpm dev
```

The dev server runs at `http://localhost:5173`. On localhost the app uses mock data — no backend required.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start Vite dev server (port 5173) |
| `pnpm build` | TypeScript check + production build to `dist/` |
| `pnpm preview` | Preview the production build locally |
| `pnpm lint` | Run ESLint |
| `pnpm lint:fix` | Run ESLint with auto-fix |

## Tech stack

| Layer | Technology |
|---|---|
| Framework | React 19 |
| Language | TypeScript ~5.7 (strict) |
| Build | Vite 6.2 |
| Routing | TanStack Router (file-based) |
| Data fetching | TanStack Query 5 |
| HTTP client | Axios (wrapped in `podiAxios`) |
| Styling | Tailwind CSS 4 |
| UI primitives | Radix UI |
| Forms | React Hook Form + Zod |

## Project structure

```
src/
├── routes/             # File-based TanStack Router pages
│   ├── __root.tsx      # Root layout (nav, outlet, toasts)
│   ├── index.tsx       # / (redirects to /brannock or /login)
│   ├── login.tsx       # /login
│   └── brannock.tsx    # /brannock (main template workflow)
├── components/
│   └── forms/          # Form components (LoginForm)
├── schemas/
│   └── brannock.ts     # Zod schemas for all Brannock data types
├── services/
│   ├── auth.ts         # Login, auth header, logout redirect
│   └── brannock.ts     # API calls: patients, scans, thermograms, build, save
├── hooks/
│   └── useAuth.tsx     # Auth context provider + hook
├── mocks/
│   └── brannock.ts     # Mock data for LOCAL development
├── utils/
│   ├── api.ts          # podiAxios HTTP wrapper
│   ├── constants.ts    # ENV detection, storage keys
│   └── classes.ts      # cn() Tailwind class merge utility
├── main.tsx            # App entry point
└── index.css           # Tailwind imports + CSS variables
```

## Environment detection

| Env | Hostname | API base URL |
|---|---|---|
| `LOCAL` | `localhost` | `http://localhost:3000/api/v1` |
| `DEV` | `*.dev.podimetrics.com` | `https://app.dev.podimetrics.com/api/v1` |
| `UAT` | `template-automation.uat.podimetrics.com` | `https://app.uat.podimetrics.com/api/v1` |
| `PROD` | `template-automation.podimetrics.com` | `https://app.podimetrics.com/api/v1` |

In LOCAL mode, all service functions return mock data directly — no running backend needed.

## Backend API dependencies (TODO)

These endpoints do not exist yet and need to be created by the backend team:

- `GET /api/v1/templates/metadata` — patient scan-count metadata for filtering
- `POST /api/v1/templates/build` — run template computation (auto or manual mode)
- `POST /api/v1/templates` — save template + trigger scan reprocessing
