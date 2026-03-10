# `@rivetkit/svelte`

Official Svelte 5 adapter for [RivetKit](https://rivet.gg) actors.

This package is developed locally inside this repo and is what the `Rivet Kart` app uses to connect Svelte components and stores to Rivet actors.

## Install

```bash
npm install @rivetkit/svelte rivetkit
```

## Quick Start

### 1. Set up RivetKit in your root layout

```svelte
<script lang="ts">
  import { setupRivetKit } from "@rivetkit/svelte";
  import type { registry } from "$lib/actors/registry";

  setupRivetKit<typeof registry>(`${window.location.origin}/api/rivet`);

  let { children } = $props();
</script>

{@render children()}
```

### 2. Read the typed context

```ts
import { getRivetContext } from "@rivetkit/svelte";
import type { registry } from "$lib/actors/registry";

const { useActor } = getRivetContext<typeof registry>();
```

### 3. Connect to an actor

Static actor key:

```ts
const lobby = useActor({ name: "lobby", key: ["main"] });
```

Reactive actor key:

```ts
const room = useActor(() => ({
  name: "raceRoom" as const,
  key: [roomId],
  params: { playerName, carVariant },
}));
```

### 4. Use actor actions and events directly

```ts
const rooms = await lobby.listRooms();
const result = await lobby.findOrCreateRoom("race");

room.onEvent("raceSnapshot", (snapshot) => {
  store.applySnapshot(snapshot);
});

await room.readyUp();
await room.voteRematch();
```

## Main APIs

### `setupRivetKit<Registry>(endpoint?, opts?)`

Creates a RivetKit instance and stores it in Svelte context. This is the standard SvelteKit entry point.

### `setupRivetKitWithClient<Registry>(client, opts?)`

Like `setupRivetKit`, but wraps an already-created client.

### `createRivetKit<Registry>(endpoint?, opts?)`

Creates a RivetKit instance without writing it to Svelte context.

### `createRivetKitWithClient<Registry>(client, opts?)`

Creates a RivetKit instance from an existing client without using context.

### `getRivetContext()`

Reads the typed RivetKit instance from Svelte context. Throws if no provider was set up.

### `hasRivetContext()`

Returns whether a RivetKit context exists.

### `useActor<ActorName>(opts)`

Connects to an actor with automatic lifecycle management.

- best for component scripts
- accepts a static config or a getter function
- keeps connection state reactive with Svelte 5 `$state`
- forwards actor methods directly on the returned object

### `createReactiveActor<ActorName>(opts)`

Creates a reactive actor handle with manual lifecycle.

- best for module-level helpers or view models
- call `mount()` and `dispose()` yourself
- returns the same kind of proxied action surface as `useActor`

## Returned Actor Shape

Both `useActor` and `createReactiveActor` expose reactive connection state plus proxied actor methods.

Common properties:

| Property | Purpose |
| --- | --- |
| `connection` | active actor connection or `null` |
| `handle` | actor handle or `null` |
| `connStatus` | connection lifecycle status |
| `error` | last connection error |
| `isConnected` | whether the actor is currently connected |
| `hash` | internal actor identity hash |
| `onEvent(name, handler)` | subscribe to actor broadcasts |

With `createReactiveActor`, you also get:

| Property | Purpose |
| --- | --- |
| `mount()` | start the connection and return an unmount function |
| `dispose()` | remove subscriptions and release the actor |

## `MaybeGetter` Support

`useActor` accepts either:

- a plain actor config object
- a getter function that returns the config

That lets Svelte track dependencies and reconnect automatically when inputs change:

```ts
const room = useActor(() => ({
  name: "raceRoom" as const,
  key: [roomId],
  params: { playerName, carVariant },
}));
```

## Proxy-Forwarded Methods

Actor actions are available directly on the returned object:

```ts
await lobby.createRoom("Quick Race", "race");
await room.getJoinState();
await room.sendInput({
  steering: 0.2,
  throttle: true,
  brake: false,
  drift: false,
  useItem: false,
});
```

You do not need to reach through `connection`.

## Example From This Repo

`Rivet Kart` uses `@rivetkit/svelte` in three main places:

1. `src/routes/+layout.svelte`
   Initializes the client with `setupRivetKit()`.
2. `src/routes/race/+page.svelte`
   Uses `lobby` to list rooms, create rooms, and quick match.
3. `src/lib/racing/use-race-room.svelte.ts`
   Connects to `raceRoom`, syncs state, and wires events into `RaceStore`.

## Testing

Test helpers live under `@rivetkit/svelte/testing`.

```ts
import { describe, expect } from "vitest";
import { testWithEffect } from "@rivetkit/svelte/testing";

describe("runes", () => {
  testWithEffect("can use $state", () => {
    let count = $state(0);
    expect(count).toBe(0);
  });
});
```

Exports:

- `testWithEffect(name, fn)`
- `effectRootScope(fn)`

## SSR Notes

- `useActor` is SSR-safe because its connection lifecycle runs inside `$effect`
- during SSR, actor state stays in its default idle values
- if you use `createReactiveActor` in a module or singleton, guard `mount()` behind a browser-only check

## Connection Sharing

Multiple `useActor` calls with the same actor name and key share the same underlying connection. The framework base layer handles caching and reference counting.

## License

Apache-2.0
