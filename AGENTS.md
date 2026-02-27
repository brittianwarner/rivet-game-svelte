# "Marble Soccer" — 1v1 Multiplayer Marble Soccer

A real-time 1v1 3D marble soccer game built with **Threlte** (Three.js for Svelte) and **Rivet Actors** via `@rivetkit/svelte`. Players control glowing marbles on a rectangular walled field, pushing a lighter ball into the opponent's goal.

**Showcases the `@rivetkit/svelte` package** — demonstrates `useActor`, `setupRivetKit`, Svelte context API, and reactive store pattern with Rivet actors.

**Server-authoritative delta-time physics.** All movement, collision, wall bouncing, goal detection, and dash mechanics run on the server at ~60 Hz with delta-time scaling. Clients send input (pointer target + dash) and receive physics snapshots at 20 Hz.

---

## Architecture

### Single-Process SvelteKit (Vercel + Rivet Cloud)

| Layer | Technology | Purpose |
| ---------------- | ------------------ | ---------------------------------------------- |
| Frontend | SvelteKit (SSR=off)| Threlte 3D frontend, lobby, game UI |
| API Route | SvelteKit `+server.ts` | `/api/rivet/[...all]` → `registry.handler()` |
| Actor Runtime | Rivet Cloud | Persistent actors, WebSocket connections |

### Four-Layer Architecture

```
┌─────────────────────────┐
│ GameStore               │ ← Single reactive $state truth
│ players, ball, scores,  │
│ phase, timeRemaining    │
└────────────┬────────────┘
             │
    ┌────────┼──────────────────┐
    │        │                  │
    ▼        ▼                  ▼
useGameRoom  Marble/Ball.svelte PointerInput.svelte
(composable) (visual only)      (mouse/touch → actor)
actor ↔ store lerp to server   raycast + dash input
events → store position        sendInput(target, dash)
```

### Data Flow

```
PointerInput.svelte
  ├── Pointer move → raycast onto ground plane (y=0)
  ├── Left-click: sends input while pressing (not on passive hover)
  ├── Right-click / two-finger tap: triggers dash
  ├── Throttled sendInput({ tx, tz, active, dash }) → actor (20 Hz)
  └── Visual target indicator on ground

gameRoom actor (Rivet Cloud, ~60 Hz delta-time tick loop)
  ├── Phase management (waiting/countdown/playing/goalScored/goldenGoal/finished)
  ├── Read connection inputs → apply forces toward target (scaled by dt)
  ├── Handle dash (force multiplier for DASH_DURATION, cooldown per connection)
  ├── Player-to-player collision (symmetric elastic push)
  ├── Ball-player collision (momentum-based, asymmetric mass — ball flies)
  ├── Wall collision (axis-aligned bounce with restitution, goal pocket geometry)
  ├── Goal detection (ball crosses goal line within goal opening)
  ├── Match timer countdown, golden goal on tie
  └── Broadcast physicsSnapshot at 20 Hz

useGameRoom composable
  ├── Single getJoinState() RPC on connect
  ├── Receives physicsSnapshot → store.applySnapshot() (players + ball)
  ├── goalScored/gameOver/phaseChanged → store mutations
  └── Deep $state mutation (no spread needed)

Marble.svelte / Ball.svelte
  └── Reads store positions → lerp via Three.js Group ref
```

---

## Project Info

| | |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Package | `marble-soccer` |
| Scripts | `dev`, `build`, `preview`, `check` |
| Adapter | `@sveltejs/adapter-vercel` |
| Depends on | `rivetkit`, `@rivetkit/svelte` (local), `@threlte/core`, `@threlte/extras`, `three`, `runed` |
| Demonstrates | Delta-time server physics, momentum-based ball collision, `useActor` + reactive store, dash mechanic, Svelte 5 deep reactivity |

---

## Directory Structure

```
rivet-game-svelte/
├── src/
│   ├── lib/
│   │   ├── actors/
│   │   │   ├── registry.ts
│   │   │   ├── lobby/
│   │   │   │   ├── lobby.actor.ts        # Room listing coordinator
│   │   │   │   └── index.ts
│   │   │   └── game-room/
│   │   │       ├── game-room.actor.ts    # Server physics, goals, phases
│   │   │       └── index.ts
│   │   ├── components/
│   │   │   ├── Scene.svelte              # Canvas + Camera + reads from store
│   │   │   ├── Field.svelte              # Rectangular pitch with walls + markings
│   │   │   ├── Goal.svelte               # Goal posts, crossbar, net
│   │   │   ├── Ball.svelte               # Soccer ball with trail + glow
│   │   │   ├── Marble.svelte             # Player marble (6-layer elemental core)
│   │   │   ├── PointerInput.svelte       # Mouse/touch → sendInput + dash
│   │   │   └── Environment.svelte        # Lighting setup
│   │   ├── game/
│   │   │   ├── types.ts                  # Shared types, constants, physics params
│   │   │   ├── game-store.svelte.ts      # GameStore — reactive $state class
│   │   │   ├── use-game-room.svelte.ts   # useGameRoom — actor↔store composable
│   │   │   ├── context.ts               # Svelte context helpers
│   │   │   ├── marble-geometry.ts        # Shared lazy-singleton geometries
│   │   │   └── ring-shader.ts           # Fresnel GLSL shaders for rings
│   │   └── rivetkit-svelte/
│   ├── routes/
│   │   ├── api/rivet/[...all]/+server.ts
│   │   ├── +layout.svelte
│   │   ├── +layout.ts
│   │   ├── +page.svelte                  # Lobby — create/join 1v1 matches
│   │   └── play/[roomId]/+page.svelte    # Game — field + HUD + score
│   ├── app.css
│   └── app.html
├── package.json
├── svelte.config.js
├── vite.config.ts
└── AGENTS.md
```

---

## Game Design

### Core Concept

1v1 marble soccer. Two player marbles push a lighter ball into the opponent's goal. First to 5 wins, or highest score after 3 minutes. Tied at time → golden goal (wider goals, next score wins).

### Field

- **Shape**: 20×12 rectangular (Z = length, X = width), sharp corners
- **Boundaries**: Solid walls (ball restitution 0.8, player restitution 0.5)
- **Goals**: 4.0 wide openings in end walls with 2.0 deep pockets
- **Visual**: Dark neon pitch, `#0A9EF5` field lines, team-color goal tints

### Ball Physics

- **Radius**: 0.3 (smaller than player marble 0.5)
- **Mass**: 0.3× player mass — flies when hit by a moving player
- **Collision**: Momentum-based impulse transfer. Ball gets large impulse, player barely affected.
- **Drag**: 0.035 (same as player) — ball decelerates at moderate rate
- **Max speed**: 0.65 (faster than player max 0.45)
- **Last-touched tracking**: Server tracks which player last hit the ball for goal attribution

### Dash Mechanic

- **Activation**: Right-click (desktop) or two-finger tap (mobile)
- **Effect**: 1.5× force multiplier for 120ms
- **Cooldown**: 3 seconds
- **Uses**: Power shots, defensive lunges, repositioning

### Scoring & Match Flow

| Phase | Description |
|-------|-------------|
| `waiting` | 0-1 players, waiting for opponent |
| `countdown` | Both connected, 3-second countdown, players frozen |
| `playing` | Active physics, timer counting down |
| `goalScored` | 1.4s celebration + freeze, then reset to kickoff |
| `goldenGoal` | Timer expired with tie, wider goals, next goal wins |
| `finished` | Winner declared, back to lobby |

### Kickoff Positions

- Player 1 (team coral): (0, 0.5, -7)
- Player 2 (team mint): (0, 0.5, +7)
- Ball: (0, 0.5, 0) center

### Team Colors

- Team 1: `#FF6B4A` (coral)
- Team 2: `#4DFFB8` (mint)

---

## Reactive State Architecture

### GameStore (`game-store.svelte.ts`)

```typescript
class GameStore {
  players = $state<Record<string, PlayerState>>({});
  localPlayerId = $state<string | null>(null);
  ball = $state<BallState>({ ... });
  scores = $state<[number, number]>([0, 0]);
  phase = $state<GamePhase>("waiting");
  timeRemaining = $state(180000);

  localPlayer = $derived(/* ... */);
  opponentPlayer = $derived(/* ... */);
  localTeam = $derived(/* ... */);

  applySnapshot(snapshot): void { /* deep $state mutation */ }
  applyGoalScored(data): void { /* update scores */ }
  applyPhaseChanged(phase, time): void { /* ... */ }
}
```

### useGameRoom (`use-game-room.svelte.ts`)

- Creates `useActor()` connection to `gameRoom`
- Wires actor events → store mutations
- Throttles input at 20 Hz, handles dash flag
- Returns `GameRoomControls` (sendInput, dash, leave, isConnected)

### Context (`context.ts`)

Two Svelte contexts:
- `GAME_STORE_KEY` → `GameStore` instance
- `GAME_ROOM_KEY` → `GameRoomControls` interface

---

## Actors

### lobby — Coordinator (key: `["main"]`)

Singleton maintaining list of active rooms.

**Actions:** `listRooms()`, `createRoom(name)`, `updateRoom(roomId, patch)`, `removeRoom(roomId)`

### gameRoom — Data Actor (key: `[roomId]`)

Per-room actor with server-authoritative soccer physics.

**State:** `{ id, name, players, ball, scores, phase, timeRemaining, phaseStartedAt, maxPlayers, createdAt }`

**Connection State:** `{ playerId, playerName, input, dashCooldownUntil, dashStartedAt }`

**Run Loop (~60 Hz, delta-time):**
1. Phase management (countdown timers, goal celebration, match timer)
2. Read inputs, apply forces with optional dash multiplier
3. Player-player collision (elastic push, PUSH_FORCE 0.2)
4. Ball-player collision (momentum-based, mass ratio 0.3:1.0)
5. Drag + velocity integration
6. Wall collision (axis-aligned, goal pocket geometry)
7. Goal detection → phase transition
8. Broadcast snapshot at 20 Hz

**Events:** `playerJoined`, `playerLeft`, `physicsSnapshot`, `goalScored`, `gameOver`, `phaseChanged`

---

## Components

### Field.svelte
Rectangular platform (20×12), dark surface with neon markings (center line, center circle, goal boxes). Walls rendered as translucent boxes with team-color gradients near goals.

### Goal.svelte
Two goal structures with posts (emissive cylinders), crossbar, wireframe back net, and glowing goal line on floor. Team color indicates which team defends.

### Ball.svelte
White sphere (radius 0.3) with FakeGlowMaterial. Velocity-scaled emissive intensity. 8-frame trailing points colored by last-toucher's team color.

### Marble.svelte — "Elemental Core" Design
6-layer procedural marble (same as original): inner core, frosted shell, orbiting rings, particles, glow aura, outline (local only). Knockoff scaling removed for soccer.

### PointerInput.svelte
Raycasts pointer onto ground plane. Left-click sends movement input. Right-click / two-finger tap triggers dash.

### Scene.svelte
Canvas with fixed camera at (0, 22, 14). Renders Field, two Goals, Ball, two Marbles (local + opponent), and PointerInput.

---

## Game Constants

| Constant | Value | Purpose |
| ----------------------------- | ------ | ---------------------------------------------- |
| `FIELD_HALF_LENGTH` | 10 | Z-axis half (field is 20 long) |
| `FIELD_HALF_WIDTH` | 6 | X-axis half (field is 12 wide) |
| `GOAL_HALF_WIDTH` | 2.0 | Goal opening half-width |
| `GOAL_DEPTH` | 2.0 | Goal pocket depth behind wall |
| `BALL_RADIUS` | 0.3 | Soccer ball radius |
| `BALL_MASS` | 0.3 | Ball mass (player = 1.0) |
| `BALL_MAX_SPEED` | 0.65 | Ball max horizontal speed |
| `BALL_DRAG` | 0.035 | Ball drag per tick |
| `MARBLE_RADIUS` | 0.5 | Player marble radius |
| `MOVE_FORCE` | 0.04 | Per-tick force toward target |
| `MAX_SPEED` | 0.45 | Player horizontal speed cap |
| `DRAG` | 0.035 | Player linear friction |
| `PUSH_FORCE` | 0.2 | Player-player collision push |
| `DASH_FORCE_MULT` | 1.5 | Dash force multiplier |
| `DASH_DURATION` | 120ms | Dash active time |
| `DASH_COOLDOWN` | 3000ms | Dash recharge time |
| `GOALS_TO_WIN` | 5 | Score to win match |
| `MATCH_TIME_LIMIT` | 180000ms | 3-minute match timer |
| `GOLDEN_GOAL_HALF_WIDTH` | 2.5 | Wider goals in golden goal |
| `WALL_RESTITUTION_BALL` | 0.8 | Ball-wall bounce |
| `WALL_RESTITUTION_PLAYER` | 0.5 | Player-wall bounce |
| `SERVER_TICK_INTERVAL` | 16ms | ~60 Hz server physics |
| `SNAPSHOT_BROADCAST_INTERVAL` | 50ms | 20 Hz snapshot broadcast |
| `INPUT_SEND_INTERVAL` | 50ms | 20 Hz client input |

---

## Running Locally

```bash
npm install
npm run dev
```

Open two browser tabs to test 1v1 multiplayer.
Actors run via Rivet Cloud — set `RIVET_ENDPOINT` and `RIVET_PUBLIC_ENDPOINT` in `.env`.

---

## Key Design Decisions

- **Rectangular walled field** — Walls keep ball in play, create bank shots, zero downtime.
- **Momentum-based ball collision** — Ball mass 0.3× player means it flies on contact. No special "kick" button — running into the ball IS kicking it.
- **Velocity determines kick power** — Faster approach = harder shot. Creates power-vs-control tradeoff.
- **Dash as single new mechanic** — One ability, one cooldown. Enough for power shots and defensive lunges without complexity bloat.
- **Axis-aligned wall collision** — Four boundary checks per entity. Goal openings skip Z-wall check. Simple and fast.
- **Phase state machine** — Server manages game flow via phases. Clean transitions, no race conditions.
- **Fixed camera** — Both goals always visible. No camera follow avoids disorientation.
- **Ball trail colored by last toucher** — Instant visual attribution of possession.
- **Golden goal** — Tied matches get wider goals + next-goal-wins. Guarantees exciting finish.
- **No knockoff/fall system** — Replaced entirely by goal scoring. Clean soccer semantics.
