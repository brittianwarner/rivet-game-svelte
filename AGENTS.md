# "Rivet Kart" - 4-Player Multiplayer Kart Racing

This repo now centers on **Rivet Kart**, a realtime multiplayer kart racer built with **SvelteKit**, **Threlte**, and **Rivet Actors** via the local `@rivetkit/svelte` package.

The landing page still exposes the older bump / marble-soccer prototype, but the current primary experience, architecture, and active docs should be treated as the kart racer.

---

## Project Summary

- **Primary game**: `Rivet Kart`
- **Genre**: 4-player arcade kart racing
- **Track**: `Neon Circuit`, a procedural closed loop with elevation, banking, boost pads, item boxes, scenery, and a shortcut
- **Networking model**: server-authoritative actor simulation at about 60 Hz with 20 Hz snapshots
- **Current app shell**: multi-game launcher at `/`, race lobby at `/race`, race room at `/race/play/[roomId]`
- **Legacy game**: `/bump` still exists and uses the older `gameRoom` actor

---

## Architecture

### Runtime model

| Layer | Technology | Purpose |
| --- | --- | --- |
| Frontend | SvelteKit + Svelte 5 | Routes, HUD, lobby UI, local state |
| 3D | Threlte + Three.js | Kart scene, track, projectiles, minimap camera |
| Actor API | `rivetkit` | Actor definitions, connections, broadcasts, actions |
| Runtime | Rivet Cloud | Persistent stateful actor execution |
| Adapter | local `@rivetkit/svelte` | Svelte context, `useActor`, reactive actor lifecycle |

### High-level data flow

```text
+layout.svelte
  -> setupRivetKit<typeof registry>(/api/rivet)

/race
  -> lobby actor
  -> list/create/find race rooms
  -> navigate to /race/play/[roomId]

/race/play/[roomId]
  -> useRaceRoom()
  -> useActor({ name: "raceRoom", key: [roomId], params })
  -> getJoinState() on connect
  -> actor events + snapshots -> RaceStore
  -> RaceScene + HUD read RaceStore

raceRoom actor
  -> ready system
  -> countdown
  -> kart physics
  -> items / hazards / projectiles
  -> checkpoint + lap tracking
  -> position ranking
  -> finish + rematch flow
```

---

## Important Routes

```text
src/routes/
├── +layout.svelte                  # setupRivetKit()
├── +layout.ts                      # ssr = false
├── +page.svelte                    # game picker
├── race/+page.svelte               # kart lobby
├── race/play/[roomId]/+page.svelte # kart race page
├── bump/+page.svelte               # legacy bump lobby
├── bump/play/[roomId]/+page.svelte # legacy bump game
└── api/rivet/[...all]/+server.ts   # registry.handler(request)
```

### Current product expectation

When updating docs, UX copy, or architecture notes, prefer:

- `Rivet Kart`
- `/race`
- `raceRoom`
- the procedural track / racing stack

Only mention the bump / marble game as a secondary or legacy path unless the work is specifically about that route.

---

## Actor Registry

`src/lib/actors/registry.ts`

Registered actors:

- `lobby`
- `gameRoom` (legacy bump / soccer)
- `raceRoom` (primary)

The root layout initializes `@rivetkit/svelte` against the SvelteKit API route:

```ts
setupRivetKit<typeof registry>(`${window.location.origin}/api/rivet`);
```

---

## Core Kart Racing Files

```text
src/lib/
├── actors/
│   ├── lobby/lobby.actor.ts
│   ├── race-room/race-room.actor.ts
│   └── registry.ts
├── racing/
│   ├── context.ts
│   ├── race-store.svelte.ts
│   ├── track.ts
│   ├── types.ts
│   ├── use-race-room.svelte.ts
│   └── components/
│       ├── BoostFlame.svelte
│       ├── ChaseCam.svelte
│       ├── DriftSparks.svelte
│       ├── ItemBox.svelte
│       ├── Kart.svelte
│       ├── Minimap.svelte
│       ├── Projectile.svelte
│       ├── RaceInput.svelte
│       ├── RaceScene.svelte
│       └── Track.svelte
└── rivetkit-svelte/
```

### Responsibilities

- `race-room.actor.ts`
  - authoritative room state
  - ready states
  - countdown and race lifecycle
  - kart physics
  - drift / boost / slipstream / rocket start logic
  - items, hazards, and projectiles
  - lap tracking and finishing order
  - rematch votes and race stats

- `race-store.svelte.ts`
  - single client-side reactive store for the race page
  - snapshot application
  - HUD-facing derived values
  - toast, hit flash, shake, and roulette state

- `use-race-room.svelte.ts`
  - actor connection lifecycle
  - initial sync via `getJoinState()`
  - event wiring from actor to store
  - throttled `sendInput()`
  - room controls (`useItem`, `readyUp`, `voteRematch`, `leave`)

- `track.ts`
  - procedural `Neon Circuit` generation
  - control points, segment interpolation, banking, checkpoints, start grid
  - boost zones, item box rows, shortcut path, and scenery

---

## Rivet Kart Design

### Race rules

- Max players: `4`
- Lap count: `3`
- Time limit: `5 minutes`
- Countdown: `3000ms`
- Snapshot rate: `50ms`
- Server tick: `16ms`

### Race phases

| Phase | Meaning |
| --- | --- |
| `waiting` | room is open, players can ready up |
| `countdown` | pre-race 3 second countdown |
| `racing` | live simulation |
| `finished` | results screen, rematch voting |

### Race features

- drift charge tiers and drift release boosts
- rocket starts with timing windows
- slipstream / drafting boost
- boost pads
- item boxes with rubber-banded item rolls
- green, red, and blue shells
- bananas, mushrooms, triple mushrooms, star, lightning
- spectator mode for full in-progress rooms
- race stats and results screen
- rematch vote flow

### Track features

`Neon Circuit` is generated from spline control points and includes:

- elevation changes
- banked turns
- wide and narrow road sections
- four boost zones
- three item-box rows
- eight checkpoints
- a four-kart start grid
- an S-curve shortcut
- procedural scenery objects such as pylons, blocks, and a start arch

---

## Lobby Behavior

The `lobby` actor is shared across game types.

### Supported actions

- `listRooms()`
- `createRoom(name, game)`
- `registerRoom(roomId, name, game)`
- `updateRoom(roomId, patch)`
- `removeRoom(roomId)`
- `findOrCreateRoom(game)`

### Room semantics

- rooms carry `game: "bump" | "race"`
- race lobbies filter to `game === "race"`
- quick match reuses a waiting room before creating a new one
- stale empty rooms are swept automatically

---

## Player Controls

### Desktop

- `WASD` for steering / throttle / brake
- `Shift` to drift
- `E` to use item

### Mobile

- left touch area for steering
- right-side touch buttons for gas, brake, drift, and item use

---

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Dev server:

- `http://localhost:5175`

Required env vars:

- `RIVET_ENDPOINT`
- `RIVET_PUBLIC_ENDPOINT`

Optional env vars:

- `ALLOWED_ORIGINS`

Use 2 to 4 tabs for kart racing tests. Joining a full in-progress race should enter spectator mode.

---

## Documentation Guidance

When editing docs for this repo:

- describe the project as **Rivet Kart** first
- keep `gameRoom` and bump references clearly labeled as legacy / secondary
- prefer `npm` commands because that is what the root `package.json` exposes
- mention the local `@rivetkit/svelte` package when discussing actor integration
- keep route references aligned with `/race` and `/race/play/[roomId]`

---

## Local Package

The repo includes a local package at `src/lib/rivetkit-svelte`.

Use its docs for:

- package API details
- `setupRivetKit`, `getRivetContext`, and `useActor`
- testing helpers under `@rivetkit/svelte/testing`

Files:

- `src/lib/rivetkit-svelte/README.md`
- `src/lib/rivetkit-svelte/AGENTS.md`
