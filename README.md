# Rivet Kart

Real-time multiplayer kart racing built with [SvelteKit](https://kit.svelte.dev), [Threlte](https://threlte.xyz), and [Rivet Actors](https://rivet.gg) via the local `@rivetkit/svelte` package.

The current primary game in this repo is **Rivet Kart**: a server-authoritative 4-player racer with drifting, rocket starts, slipstream, boost pads, item boxes, spectators, ready-up flow, and rematches. The app home screen also still links to the older bump / marble-soccer prototype, but the racing stack is the main focus of the project.

## What This Repo Shows

- `setupRivetKit()` in the root SvelteKit layout
- Type-safe actor access with `getRivetContext<typeof registry>()`
- `useActor()` for reactive room connections
- A shared lobby actor used by multiple games
- A server-authoritative `raceRoom` actor ticking at about 60 Hz
- Svelte 5 `$state` stores fed by actor events and snapshots
- A local workspace package at `src/lib/rivetkit-svelte` that powers the app

## Rivet Kart Overview

Rivet Kart is a 4-player arcade racer on the procedurally generated **Neon Circuit** track.

- **Track**: closed-loop spline track with elevation, banking, boost zones, checkpoints, scenery, and an S-curve shortcut
- **Race format**: 3 laps, up to 4 racers, 5-minute cap
- **Driving tech**: drift charge tiers, drift boosts, snap steering, counter-steer bonus, hitstop, off-road slowdown, and respawns
- **Race starts**: rocket start timing with `perfect`, `good`, `ok`, and `stall` outcomes
- **Items**: green shell, red shell, blue shell, banana, mushroom, triple mushroom, star, and lightning
- **Catch-up systems**: rubber-banded item rolls and slipstream drafting
- **Room flow**: create room, quick match, ready up, race, finish screen, and rematch vote
- **Spectators**: players joining a full in-progress room can spectate instead of driving

## Architecture

| Layer | Technology | Purpose |
| --- | --- | --- |
| Frontend | SvelteKit + Threlte | Game routes, HUD, 3D scene, and input |
| Transport | `/api/rivet/[...all]` | Bridges browser requests to the Rivet registry |
| Actor layer | `rivetkit` | Lobby coordination and room simulation |
| Runtime | Rivet Cloud | Persistent actor execution and realtime connections |

### Main flow

1. `src/routes/+layout.svelte` calls `setupRivetKit<typeof registry>(\`${window.location.origin}/api/rivet\`)`.
2. Lobby pages connect to the singleton `lobby` actor.
3. Race pages connect to `raceRoom` with a reactive actor key based on `roomId`.
4. `raceRoom` runs authoritative simulation at about 60 Hz and broadcasts snapshots at 20 Hz.
5. `RaceStore` applies snapshots and events for HUD, scene interpolation, results, and room state.

## Routes

- `/` - game picker
- `/race` - Rivet Kart lobby
- `/race/play/[roomId]` - live kart race
- `/bump` - legacy bump / marble-soccer flow
- `/api/rivet/[...all]` - Rivet registry handler

## Project Structure

```text
src/
├── lib/
│   ├── actors/
│   │   ├── registry.ts
│   │   ├── lobby/lobby.actor.ts
│   │   ├── race-room/race-room.actor.ts
│   │   └── game-room/game-room.actor.ts
│   ├── racing/
│   │   ├── race-store.svelte.ts
│   │   ├── use-race-room.svelte.ts
│   │   ├── track.ts
│   │   ├── types.ts
│   │   └── components/
│   │       ├── RaceScene.svelte
│   │       ├── RaceInput.svelte
│   │       ├── Kart.svelte
│   │       ├── Track.svelte
│   │       ├── Projectile.svelte
│   │       ├── ItemBox.svelte
│   │       ├── BoostFlame.svelte
│   │       ├── DriftSparks.svelte
│   │       ├── ChaseCam.svelte
│   │       └── Minimap.svelte
│   └── rivetkit-svelte/
│       ├── README.md
│       └── AGENTS.md
└── routes/
    ├── +layout.svelte
    ├── +page.svelte
    ├── race/+page.svelte
    ├── race/play/[roomId]/+page.svelte
    ├── bump/+page.svelte
    └── api/rivet/[...all]/+server.ts
```

## Actors

### `lobby`

Singleton room directory keyed by `["main"]`.

- Lists rooms across game types
- Creates race or bump rooms
- Supports quick match with `findOrCreateRoom(game)`
- Broadcasts `roomCreated`, `roomUpdated`, and `roomRemoved`

### `raceRoom`

Per-room kart racing actor keyed by `[roomId]`.

- Owns kart state, items, hazards, item boxes, positions, rematch votes, and race stats
- Runs the race loop, countdown, lap tracking, and finish logic
- Handles ready states, spectator mode, and room lifecycle
- Broadcasts snapshots, race events, toast-worthy events, and finish data

## `@rivetkit/svelte` In This Repo

The local package lives in [`src/lib/rivetkit-svelte`](src/lib/rivetkit-svelte). The app uses it like this:

```svelte
<script lang="ts">
  import { setupRivetKit } from "@rivetkit/svelte";
  import type { registry } from "$lib/actors/registry";

  setupRivetKit<typeof registry>(`${window.location.origin}/api/rivet`);
</script>
```

```ts
const { useActor } = getRivetContext<typeof registry>();

const room = useActor(() => ({
  name: "raceRoom" as const,
  key: [roomId],
  params: { playerName, carVariant },
}));
```

See [`src/lib/rivetkit-svelte/README.md`](src/lib/rivetkit-svelte/README.md) for package API details.

## Local Development

1. Install dependencies:

```bash
npm install
```

1. Copy env vars:

```bash
cp .env.example .env
```

1. Set your Rivet credentials in `.env`:

```bash
RIVET_ENDPOINT=https://your-namespace:sk_xxxx@api.rivet.dev
RIVET_PUBLIC_ENDPOINT=https://your-namespace:pk_xxxx@api.rivet.dev
# optional
# ALLOWED_ORIGINS=https://your-app.vercel.app,https://custom-domain.com
```

1. Start the app:

```bash
npm run dev
```

The dev server runs on `http://localhost:5175`.

## Testing Multiplayer Locally

- Open `http://localhost:5175/race` in 2 to 4 browser tabs
- Create a room or use quick match
- Ready up in each tab to start the countdown
- Join a full in-progress room to verify spectator mode

## Deployment

This project is set up for **Vercel + Rivet Cloud**.

1. Connect the repo to Vercel
2. Set `RIVET_ENDPOINT`, `RIVET_PUBLIC_ENDPOINT`, and optional `ALLOWED_ORIGINS`
3. Deploy the SvelteKit app
4. The `/api/rivet/[...all]` route forwards requests to `registry.handler(request)`

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | SvelteKit, Svelte 5, Threlte, Three.js |
| Actor framework | `rivetkit`, local `@rivetkit/svelte` |
| Runtime | Rivet Cloud |
| Styling | Tailwind CSS v4 |
| Deployment | `@sveltejs/adapter-vercel` |

## License

Apache-2.0
