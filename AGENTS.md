# "Bump" — Multiplayer Marble Sumo

An example real-time multiplayer 3D game built with **Threlte** (Three.js for Svelte) and **Rivet Actors** via `@rivetkit/svelte`. Players control glowing marbles on a circular floating arena using mouse/touch — push opponents off the edge to score.

**Showcases the `@rivetkit/svelte` package** — demonstrates `useActor`, `setupRivetKit`, Svelte context API, and reactive store pattern with Rivet actors.

**Server-authoritative delta-time physics.** All movement, collision, gravity, and fall detection run on the server at ~60 Hz with delta-time scaling (frame-rate independent). Clients send input (pointer target) only while pressing and receive physics snapshots at 20 Hz. No client-side physics engine.

---

## Architecture

### Single-Process SvelteKit (Vercel + Rivet Cloud)

| Layer | Technology | Purpose |
| ---------------- | ------------------ | ---------------------------------------------- |
| Frontend | SvelteKit (SSR=off)| Threlte 3D frontend, lobby, game UI |
| API Route | SvelteKit `+server.ts` | `/api/rivet/[...all]` → `registry.handler()` |
| Actor Runtime | Rivet Cloud | Persistent actors, WebSocket connections |

Client → Rivet Cloud (WebSocket) → Actor code (hosted by Rivet Cloud) → Events back to client.
SvelteKit API route serves metadata and handles Rivet Cloud communication.

### Four-Layer Architecture

```
┌─────────────────────────┐
│     GameStore            │  ← Single reactive $state truth
│  players, localPlayer,   │
│  remotePlayers, scores   │
└────────────┬────────────┘
             │
   ┌─────────┼──────────────────┐
   │         │                  │
   ▼         ▼                  ▼
useGameRoom  Marble.svelte    PointerInput.svelte
(composable) (visual only)    (mouse/touch → actor)
actor ↔ store  lerp to server   raycast to ground plane
events → store  position         sendInput(target)
```

### Data Flow

```
PointerInput.svelte
  ├── Pointer move → raycast onto ground plane (y=0) → visual indicator
  ├── Only sends input while pressing (not on passive hover)
  ├── Throttled sendInput({ tx, tz, active }) → actor (20 Hz)
  └── Visual target indicator on ground

gameRoom actor (Rivet Cloud, ~60 Hz delta-time tick loop)
  ├── Check tick-based respawns (no setTimeout)
  ├── Read connection inputs → apply forces toward target (scaled by dt)
  ├── Marble-to-marble collision with squared-distance early exit
  ├── Gravity + exponential drag + ground collision (all scaled by dt)
  ├── Fall detection (y < -5) → set respawnAt timestamp
  └── Broadcast physicsSnapshot at 20 Hz

useGameRoom composable
  ├── Single getJoinState() RPC on connect (state + playerId)
  ├── Receives physicsSnapshot → store.applySnapshot()
  ├── playerJoined/Left/Fell/Respawned → store mutations
  └── Deep $state mutation (no spread needed)

Marble.svelte
  └── Reads store.players[id].position → lerp via Three.js Group ref (no $state per axis)
```

---

## Project Info

|              |                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Package      | `bump-game`                                                                                                                            |
| Scripts      | `dev`, `build`, `preview`, `check`                                                                                                     |
| Adapter      | `@sveltejs/adapter-vercel` (deploys to Vercel)                                                                                         |
| Depends on   | `rivetkit`, `@rivetkit/svelte` (local), `@threlte/core`, `@threlte/extras`, `three`, `runed`                                           |
| Demonstrates | Delta-time server physics, `useActor` + reactive store, mouse/touch input, Svelte 5 deep reactivity, direct Three.js ref interpolation |

---

## Directory Structure

```
rivet-game-svelte/
├── src/
│   ├── lib/
│   │   ├── actors/                       # Server-side actor definitions
│   │   │   ├── registry.ts               # Central actor registry (setup from rivetkit)
│   │   │   ├── lobby/
│   │   │   │   ├── lobby.actor.ts        # Coordinator — room listing
│   │   │   │   └── index.ts
│   │   │   └── game-room/
│   │   │       ├── game-room.actor.ts    # Data actor — server physics tick loop
│   │   │       └── index.ts
│   │   ├── components/                   # Threlte 3D components (visual only)
│   │   │   ├── Scene.svelte              # Canvas + Camera + reads from store context
│   │   │   ├── Arena.svelte              # Circular platform (visual, no physics)
│   │   │   ├── Marble.svelte             # Shared marble visual (local + remote)
│   │   │   ├── PointerInput.svelte       # Mouse/touch → raycast → sendInput
│   │   │   └── Environment.svelte        # Lighting setup
│   │   ├── game/
│   │   │   ├── types.ts                  # Shared types, constants, physics + visual params
│   │   │   ├── game-store.svelte.ts      # GameStore — reactive $state class
│   │   │   ├── use-game-room.svelte.ts   # useGameRoom — actor↔store composable
│   │   │   ├── context.ts               # Svelte context helpers (store + controls)
│   │   │   ├── marble-geometry.ts        # Shared lazy-singleton geometries for marbles
│   │   │   └── ring-shader.ts           # Fresnel GLSL shaders for orbiting rings
│   │   └── rivetkit-svelte/              # @rivetkit/svelte package (local copy)
│   │       ├── src/lib/                  # Package source code
│   │       ├── dist/                     # Pre-built package output
│   │       └── package.json
│   ├── routes/
│   │   ├── api/rivet/[...all]/
│   │   │   └── +server.ts              # Catch-all → registry.handler()
│   │   ├── +layout.svelte               # setupRivetKit("/api/rivet") + global styles
│   │   ├── +layout.ts                   # ssr = false
│   │   ├── +page.svelte                 # Lobby — room list, create/join
│   │   └── play/[roomId]/
│   │       └── +page.svelte             # Game — thin shell (store + scene + HUD)
│   ├── app.css                          # Dark theme CSS variables + Tailwind
│   ├── app.d.ts
│   └── app.html
├── .env.example                         # Rivet Cloud env vars documentation
├── package.json
├── svelte.config.js                     # adapter-vercel
├── vite.config.ts
├── tsconfig.json
└── AGENTS.md                            # This file
```

---

## Reactive State Architecture

### GameStore (`game-store.svelte.ts`)

Single `$state` class — the only source of truth for game state on the client.

```typescript
class GameStore {
  players = $state<Record<string, PlayerState>>({});
  localPlayerId = $state<string | null>(null);
  status = $state<"waiting" | "playing" | "finished">("waiting");

  localPlayer = $derived(/* ... */); // auto-tracks localPlayerId + players
  remotePlayers = $derived(/* ... */); // all players except local
  sortedPlayers = $derived(/* ... */); // sorted by score

  // Single-RPC initialization (replaces getState + getMyPlayer)
  initFromJoinState(result: JoinStateResult): void {
    /* sets all fields */
  }

  // Mutators called by useGameRoom from actor events
  applySnapshot(snapshot: PhysicsSnapshot): void {
    /* deep $state mutation */
  }
  addPlayer(player: PlayerState): void {
    /* ... */
  }
  // ...
}
```

Deep property mutation (`store.players[id].position.x = val`) works with Svelte 5's `$state` proxy — no spread or reassignment needed.

### useGameRoom (`use-game-room.svelte.ts`)

Composable that bridges the actor connection to the store:

- Creates `useActor()` connection to `gameRoom`
- Wires actor events → store mutations
- Throttles input sending at 20 Hz via `useThrottle` from Runed
- Returns `GameRoomControls` (sendInput, respawn, leave, isConnected)

### Context (`context.ts`)

Two Svelte contexts provided by the page:

- `GAME_STORE_KEY` → `GameStore` instance
- `GAME_ROOM_KEY` → `GameRoomControls` interface

Components call `getGameStore()` and `getGameRoomControls()` to access them.

---

## Actors

Actors are defined using `actor()` and `event()` from `rivetkit`, registered via `setup()`.

### lobby — Coordinator (key: `["main"]`)

Singleton actor maintaining a list of active game rooms.

**State:** `{ rooms: RoomSummary[] }`

**Actions:**

- `listRooms()` — Returns all rooms
- `createRoom(name)` — Creates room, returns roomId
- `updateRoom(roomId, patch)` — Sync player count
- `removeRoom(roomId)` — Remove room from listing

### gameRoom — Data Actor (key: `[roomId]`)

Per-room actor with **server-authoritative physics**.

**State:** `{ id, name, players: Record<string, PlayerState>, maxPlayers, status, createdAt }`

**Connection State:** `{ playerId, playerName, input: PlayerInput }`

**Run Loop (~60 Hz, delta-time):**

1. Compute dt = elapsed / 16ms (1.0 = perfect 60 Hz, capped at ~50ms)
2. Check tick-based respawns (respawnAt timestamp, no setTimeout)
3. Read inputs from all connections, apply forces scaled by dt
4. Marble-to-marble collision with squared-distance early exit, push scaled by dt
   - Record `lastHitBy` / `lastHitAt` on both colliding players for knockoff attribution
5. Integrate velocity → position with exponential drag and gravity, all scaled by dt
6. Ground collision (keep on arena if within radius)
7. Fall detection → set respawnAt = now + RESPAWN_DELAY
   - If `lastHitBy` exists and `now - lastHitAt < HIT_ATTRIBUTION_WINDOW` (3s), credit attacker with knockoff
   - Victim: `falls += 1`, `score -= 1`. Attacker: `knockoffs += 1`, `score += 1`
8. Broadcast `physicsSnapshot` at 20 Hz (includes score, knockoffs, falls per player)

**Actions:**

- `getJoinState()` — Returns full state + local playerId in one RPC
- `sendInput(input)` — Store mouse/touch target for next tick
- `respawn()` — Manual respawn request

**Events:**

- `playerJoined` — New player added
- `playerLeft` — Player disconnected
- `physicsSnapshot` — Full physics state (positions + velocities)
- `playerFell` — Player fell off edge
- `playerRespawned` — Player respawned

---

## Components

### Scene.svelte

- `<Canvas>` + `<T.PerspectiveCamera>` with `<OrbitControls>`
- Reads from `GameStore` context — zero props
- Renders `<Arena>`, `<Marble>` (local + remote), `<PointerInput>`, `<Environment>`

### Arena.svelte

- Visual-only circular platform (no physics — server handles collision)
- Glowing edge ring + grid lines

### Marble.svelte — "Elemental Core" Design

6-layer procedural marble with velocity-reactive animation. Shared between local and remote players.

**Layers:**

| #   | Layer          | Material / Technique                              | Local vs Remote              |
| --- | -------------- | ------------------------------------------------- | ---------------------------- |
| 1   | Inner Core     | MeshBasicMaterial (self-lit, pulsing)             | Same                         |
| 2   | Frosted Shell  | MeshPhysicalMaterial (clearcoat, no transmission) | Same                         |
| 3   | Orbiting Rings | TorusGeometry + Fresnel ShaderMaterial            | **3 rings local / 1 remote** |
| 4   | Particles      | Points + figure-8 lemniscate orbit                | 8 local / 4 remote           |
| 5   | Glow Aura      | FakeGlowMaterial (@threlte/extras)                | Tighter falloff for local    |
| 6   | Outline        | Outlines (@threlte/extras)                        | **Local only**               |

**Props:** `{ color, target, isLocal?, name?, knockoffs? }` — `knockoffs` drives marble size scaling via `groupRef.scale`.

**Animation (single `useTask`):** Position lerp → knockoff scale → velocity estimation → speed normalization → core pulse (frequency scales with speed) → ring rotation (speed-reactive) → particle orbit (radius expands with speed) → collision VFX (flash + scale spike on sudden deceleration).

**Supporting files:**

- `marble-geometry.ts` — Lazy singleton shared geometries (core, shell, ring, glow). All 8 marbles reuse same buffers.
- `ring-shader.ts` — Fresnel GLSL vertex/fragment shaders for neon tube ring effect.
- `types.ts` — Visual constants (CORE_RADIUS_RATIO, RING_RADIUS_RATIO, GLOW_RADIUS_RATIO, pulse/speed/collision params).

**Performance:** ~12 draw calls per marble. Shared geometry, no post-processing bloom, additive blending for glow. 60fps target with 8 marbles.

### PointerInput.svelte

- Listens for pointer events (unified mouse/touch/pen) on the Threlte canvas
- Raycasts pointer onto ground plane (y=0) using reusable Three.js objects (no per-frame allocations)
- Only sends input to actor while actively pressing (passive hover is visual only — no network traffic)
- Renders visual target indicator (ring + dot)

### Environment.svelte

- Ambient light, directional shadow light, rim light, point lights
- Programmatic PMREMGenerator environment map (dark blue-purple gradient) for PBR clearcoat/transmission reflections
- No external HDR files — generated once on mount, disposed on unmount

---

## Scoring & Knockoff System

- **Score** = `knockoffs - falls` (can go negative)
- **Knockoffs** = times this player knocked someone else off the arena
- **Falls** = times this player fell off the arena
- **Attribution**: Server tracks `lastHitBy` per player during collisions. If victim falls within `HIT_ATTRIBUTION_WINDOW` (3s), attacker gets +1 knockoff
- **Marble size scaling**: Each knockoff grows the marble by `KNOCKOFF_SCALE_GROWTH` (8%), capped at `MAX_MARBLE_SCALE` (2.0x)
- **Death overlay**: Shows "Bumped by {name}!" if attributed, or "Fell off!" if self-fall

## Spawn System

- **Random spawns**: New players and respawns use rejection sampling within the arena circle (radius 7.5, leaving buffer from edge)
- **Min distance**: Spawns maintain minimum distance from existing players to avoid overlap
- **Legacy `SPAWN_POSITIONS`**: No longer used (kept in types.ts as reference)

## Game Constants

| Constant                      | Value  | Purpose                                        |
| ----------------------------- | ------ | ---------------------------------------------- |
| `ARENA_RADIUS`                | 10     | Arena platform radius                          |
| `FALL_THRESHOLD`              | -5     | Y position for fall detection                  |
| `INPUT_SEND_INTERVAL`         | 50ms   | Client input send rate (20 Hz)                 |
| `SERVER_TICK_INTERVAL`        | 16ms   | Server physics tick rate (~60 Hz)              |
| `SNAPSHOT_BROADCAST_INTERVAL` | 50ms   | Server snapshot broadcast rate (20 Hz)         |
| `MOVE_FORCE`                  | 0.04   | Per-tick force toward target                   |
| `MAX_SPEED`                   | 0.45   | Horizontal speed cap                           |
| `DRAG`                        | 0.035  | Linear friction per tick                       |
| `GRAVITY`                     | -0.02  | Downward force per tick                        |
| `PUSH_FORCE`                  | 0.25   | Marble collision push force                    |
| `MARBLE_RADIUS`               | 0.5    | Marble collision radius                        |
| `INPUT_DEAD_ZONE`             | 0.5    | Min distance to target before force applies    |
| `RESPAWN_DELAY`               | 2000ms | Auto-respawn timer after falling               |
| `HIT_ATTRIBUTION_WINDOW`      | 3000ms | Time window for knockoff attribution after hit |
| `KNOCKOFF_SCALE_GROWTH`       | 0.08   | Marble scale growth per knockoff (8%)          |
| `MAX_MARBLE_SCALE`            | 2.0    | Maximum marble scale multiplier                |

---

## Running Locally

```bash
npm install
npm run dev
```

Starts a single SvelteKit dev server on http://localhost:5175.
Actors run via Rivet Cloud — set `RIVET_ENDPOINT` and `RIVET_PUBLIC_ENDPOINT` in a `.env` file (see `.env.example`).

Open two browser tabs to http://localhost:5175 to test multiplayer.

## Deployment (Vercel + Rivet Cloud)

1. Connect the GitHub repo to Vercel
2. Set environment variables on Vercel:
   - `RIVET_ENDPOINT` = `https://namespace:sk_****@api.rivet.dev`
   - `RIVET_PUBLIC_ENDPOINT` = `https://namespace:pk_****@api.rivet.dev`
3. Vercel deploys SvelteKit via `adapter-vercel`
4. The `/api/rivet/[...all]` serverless function handles Rivet Cloud communication
5. Clients connect to Rivet Cloud directly for WebSocket (via metadata endpoint)

---

## Key Design Decisions

- **Delta-time server physics** — Forces, drag, gravity all scale with actual elapsed time. Frame-rate independent.
- **Tick-based respawn** — No `setTimeout`. Respawn timestamp checked each tick. Safe if actor is destroyed.
- **Single-RPC join** — `getJoinState()` returns state + playerId in one call (was two sequential RPCs).
- **Squared-distance collision** — Early exit with `distSq` avoids `Math.sqrt` for non-collisions.
- **Direct Three.js interpolation** — Marble position lerp writes to Group ref, bypassing Svelte reactivity.
- **Passive hover, active input** — PointerInput only sends network traffic while pressing. Hover is visual-only.
- **Color dedup** — Color assignment tracks used colors via Set, not index-based (handles mid-game leaves).
- **Shared Vec3 helpers** — `plainVec3`, `vec3Zero`, `clampSpeed` in `types.ts`, shared between server and client.
- **Direct rivetkit imports** — `actor()`, `event()`, `setup()` imported directly from `rivetkit`.
- **No debug log spam** — All `console.log` calls removed from hot paths (tick loop, snapshots, input).
- **Reactive store pattern** — `GameStore` ($state class) + `useGameRoom` (composable) + Svelte context. Zero prop drilling.
- **Deep $state reactivity** — `store.players[id].position.x = val` triggers updates automatically. No spread.
- **Selective broadcasting** — Named events only, no automatic state broadcast for efficiency.
- **Standalone** — Self-contained SvelteKit app. Only depends on `rivetkit`, `@rivetkit/svelte`, Threlte, and Three.js.
- **Elemental Core marble** — 6-layer procedural design. Ring count (3 vs 1) differentiates local from remote. FakeGlowMaterial over UnrealBloomPass for performance. Marble grows with knockoffs.
- **Warm player colors** — PLAYER_COLORS uses warm/vibrant tones (coral, amber, lime, magenta, etc.) that contrast the blue arena.
- **Shared geometry singletons** — All marbles reuse the same SphereGeometry/TorusGeometry/IcosahedronGeometry buffers.
- **Programmatic env map** — PMREMGenerator creates a minimal gradient cube map for PBR reflections. No external HDR files.
