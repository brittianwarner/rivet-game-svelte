# Bump — Multiplayer Marble Sumo

A real-time multiplayer 3D game built with [Threlte](https://threlte.xyz) (Three.js for Svelte) and [Rivet Actors](https://rivet.gg) via **`@rivetkit/svelte`**. Players control glowing marbles on a circular floating arena — push opponents off the edge to score.

**Live demo:** [rivet-game.vercel.app](https://rivet-game.vercel.app)

## What This Demonstrates

This game is a reference implementation showcasing **`@rivetkit/svelte`** — the Svelte 5 adapter for RivetKit actors. It demonstrates:

- **`setupRivetKit`** — one-call initialization in a SvelteKit layout
- **`useActor`** — reactive, component-scoped actor connections with auto lifecycle
- **`getRivetContext`** — type-safe context propagation through the component tree
- **`onEvent`** — subscribing to real-time actor broadcasts
- **Proxy-forwarded actions** — calling actor methods directly (`room.sendInput()`, `lobby.createRoom()`)
- **Reactive `MaybeGetter` args** — `useActor(() => ({ name: "gameRoom", key: [roomId] }))` re-subscribes when `roomId` changes
- **Server-authoritative physics** — 60 Hz delta-time tick loop running inside a Rivet Actor, clients receive 20 Hz snapshots

## `@rivetkit/svelte` — How It's Used

The package lives in [`src/lib/rivetkit-svelte/`](src/lib/rivetkit-svelte/) with full source and pre-built dist. See its [README](src/lib/rivetkit-svelte/README.md) for complete API docs.

### 1. Setup in root layout

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { setupRivetKit } from "@rivetkit/svelte";
  import type { registry } from "$lib/actors/registry";

  setupRivetKit<typeof registry>(`${window.location.origin}/api/rivet`);
</script>
```

`setupRivetKit` creates a RivetKit client and stores it in Svelte context. The `registry` type flows through to give `useActor` full type safety over actor names and keys.

### 2. Connect to actors in pages

```svelte
<!-- src/routes/+page.svelte (Lobby) -->
<script lang="ts">
  import { getRivetContext } from "@rivetkit/svelte";
  import type { registry } from "$lib/actors/registry";

  const { useActor } = getRivetContext<typeof registry>();
  const lobby = useActor({ name: "lobby", key: ["main"] });

  // Actor methods are available directly via Proxy
  const rooms = await lobby.listRooms();
  const result = await lobby.createRoom("My Arena");

  // Subscribe to real-time events
  lobby.onEvent("roomCreated", () => loadRooms());
</script>

{#if lobby.isConnected}
  <!-- UI here -->
{:else}
  <p>{lobby.connStatus}</p>
{/if}
```

### 3. Compose into reactive composables

```typescript
// src/lib/game/use-game-room.svelte.ts
import { getRivetContext } from "@rivetkit/svelte";

export function useGameRoom(opts) {
  const { useActor } = getRivetContext<typeof registry>();

  // Reactive args — re-subscribes when roomId changes
  const room = useActor(() => ({
    name: "gameRoom" as const,
    key: [opts.roomId],
    params: { playerName: opts.playerName },
  }));

  // Wire actor events to a reactive store
  room.onEvent("physicsSnapshot", (data) => store.applySnapshot(data));
  room.onEvent("playerJoined", (data) => store.addPlayer(data.player));

  // Call actor actions directly
  const result = await room.getJoinState();
  room.sendInput({ tx: 0, tz: 0, active: true });
}
```

### 4. Define actors with `rivetkit`

```typescript
// src/lib/actors/registry.ts
import { setup } from "rivetkit";
import { lobby } from "./lobby/index.js";
import { gameRoom } from "./game-room/index.js";

export const registry = setup({
  use: { lobby, gameRoom },
});
```

```typescript
// src/lib/actors/game-room/game-room.actor.ts
import { actor, event } from "rivetkit";

export const gameRoom = actor({
  createState: (c) => ({
    players: {},
    status: "waiting",
  }),
  createConnState: (c, params: { playerName: string }) => ({
    playerId: generateId(),
    playerName: params.playerName,
    input: { tx: 0, tz: 0, active: false },
  }),
  events: {
    physicsSnapshot: event<PhysicsSnapshot>(),
    playerJoined: event<{ player: PlayerState }>(),
    playerFell: event<{ playerId: string }>(),
  },
  run: async (c) => {
    // 60 Hz server-authoritative physics loop
    while (!c.aborted) {
      physicsTick(c, dt, now);
      if (shouldBroadcast) c.broadcast("physicsSnapshot", snapshot);
      await new Promise((r) => setTimeout(r, 16));
    }
  },
  actions: {
    getJoinState: (c) => ({ state: c.state, playerId: c.conn.state.playerId }),
    sendInput: (c, input) => { c.conn.state.input = input; },
    respawn: (c) => { /* respawn logic */ },
  },
});
```

### 5. SvelteKit API route bridges to Rivet Cloud

```typescript
// src/routes/api/rivet/[...all]/+server.ts
import { registry } from "$lib/actors/registry";

const handle = async ({ request }) => registry.handler(request);

export const GET = handle;
export const POST = handle;
// ... all HTTP methods
```

## `@rivetkit/svelte` API at a Glance

| Function | Purpose |
|---|---|
| `setupRivetKit(endpoint)` | Create client + set Svelte context (root layout) |
| `getRivetContext()` | Retrieve typed RivetKit from context (any component) |
| `useActor(opts)` | Connect to actor with auto lifecycle (`$effect`-managed) |
| `createReactiveActor(opts)` | Manual lifecycle actor connection (for singletons/ViewModels) |
| `hasRivetContext()` | Check if context exists (conditional actor usage) |

**Key properties on the returned actor object:**

| Property | Description |
|---|---|
| `isConnected` | `true` when WebSocket is active |
| `connStatus` | `"idle"` \| `"connecting"` \| `"connected"` \| `"reconnecting"` \| `"disconnected"` |
| `error` | Last connection error, or `null` |
| `onEvent(name, handler)` | Subscribe to actor broadcasts (auto cleanup) |
| `[anyAction]()` | Actor actions forwarded via Proxy |

## Project Structure

```
rivet-game-svelte/
├── src/
│   ├── lib/
│   │   ├── actors/                    # Rivet actor definitions (server-side)
│   │   │   ├── registry.ts            # setup({ use: { lobby, gameRoom } })
│   │   │   ├── lobby/                 # Coordinator actor — room listing
│   │   │   └── game-room/             # Data actor — 60Hz physics tick loop
│   │   ├── components/                # Threlte 3D components (visual only)
│   │   │   ├── Scene.svelte           # Canvas + camera + reads from store
│   │   │   ├── Arena.svelte           # Circular platform
│   │   │   ├── Marble.svelte          # 6-layer procedural marble
│   │   │   ├── PointerInput.svelte    # Mouse/touch → raycast → sendInput
│   │   │   └── Environment.svelte     # Lights + env map
│   │   ├── game/                      # Game state + logic
│   │   │   ├── game-store.svelte.ts   # Reactive $state store
│   │   │   ├── use-game-room.svelte.ts # Actor↔store composable
│   │   │   ├── context.ts            # Svelte context for store + controls
│   │   │   └── types.ts              # Shared types + physics constants
│   │   └── rivetkit-svelte/           # @rivetkit/svelte package
│   │       ├── src/lib/               # Source (rivetkit.svelte.ts, context.ts)
│   │       ├── dist/                  # Pre-built output
│   │       └── README.md              # Full API documentation
│   └── routes/
│       ├── +layout.svelte             # setupRivetKit initialization
│       ├── +page.svelte               # Lobby (useActor → lobby)
│       ├── play/[roomId]/+page.svelte # Game (useGameRoom composable)
│       └── api/rivet/[...all]/        # Catch-all → registry.handler()
├── package.json
└── .env.example                       # Rivet Cloud credentials
```

## Running Locally

```bash
bun install
bun run dev
```

Dev server starts at http://localhost:5175. Open two browser tabs to test multiplayer.

Actors run via Rivet Cloud. Copy `.env.example` to `.env` and set your credentials:

```bash
RIVET_ENDPOINT=https://your-namespace:sk_xxxx@api.rivet.dev
RIVET_PUBLIC_ENDPOINT=https://your-namespace:pk_xxxx@api.rivet.dev
```

## Deployment (Vercel + Rivet Cloud)

1. Connect the repo to Vercel
2. Set `RIVET_ENDPOINT` and `RIVET_PUBLIC_ENDPOINT` environment variables
3. Vercel deploys SvelteKit via `adapter-vercel`
4. The `/api/rivet/[...all]` serverless function handles Rivet Cloud communication
5. Clients connect to Rivet Cloud directly for WebSocket

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | SvelteKit + Threlte (Three.js) |
| Actor Framework | `rivetkit` + `@rivetkit/svelte` |
| Actor Runtime | Rivet Cloud |
| Deployment | Vercel (SvelteKit adapter) |
| Styling | Tailwind CSS v4 |

## License

Apache-2.0
