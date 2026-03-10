# `@rivetkit/svelte`

Official Svelte 5 adapter for RivetKit actors, developed locally inside this repo and used by the `Rivet Kart` app.

---

## Workspace

| Field | Value |
| --- | --- |
| Package | `@rivetkit/svelte` |
| Location | `src/lib/rivetkit-svelte` |
| Scripts | `build`, `check-types` |
| Depends on | `@rivetkit/framework-base`, `rivetkit`, `esm-env` |
| Peer dependency | `svelte` `^5.0.0` |
| Test tooling | `vitest` via `@rivetkit/svelte/testing` |
| Used by | the root SvelteKit app in this repo |

---

## Package Purpose

This package provides the Svelte-side integration layer for Rivet actors:

- create or inject a RivetKit client
- store it in Svelte context
- connect to actors with reactive lifecycle management
- expose actor actions directly through Proxy forwarding
- offer test helpers for rune-based code

In this repo it powers:

- `src/routes/+layout.svelte` via `setupRivetKit()`
- lobby connections in `src/routes/race/+page.svelte`
- room connections in `src/lib/racing/use-race-room.svelte.ts`

---

## Source Layout

```text
src/lib/rivetkit-svelte/
├── package.json
├── README.md
├── AGENTS.md
└── src/lib/
    ├── index.ts
    ├── context.ts
    ├── rivetkit.svelte.ts
    ├── internal/
    │   ├── index.ts
    │   ├── extract.ts
    │   └── types.ts
    └── testing/
        ├── index.ts
        └── test-helpers.svelte.ts
```

---

## Public API

### Factory functions

- `createRivetKit<Registry>(endpoint?, opts?)`
- `createRivetKitWithClient<Registry>(client, opts?)`

Both return an object exposing:

- `useActor`
- `createReactiveActor`

### Context helpers

- `setupRivetKit<Registry>(endpoint?, opts?)`
- `setupRivetKitWithClient<Registry>(client, opts?)`
- `setRivetContext(rivet)`
- `getRivetContext()`
- `hasRivetContext()`

### Actor composables

- `useActor<ActorName>(opts: MaybeGetter<ActorOptions>)`
- `createReactiveActor<ActorName>(opts)`

### Utilities and types

- `extract(maybeGetter)`
- `Getter<T>`
- `MaybeGetter<T>`
- `ActorState`
- `ReactiveActorHandle`
- `RivetKit`

### Testing subpath

- `@rivetkit/svelte/testing`
- `testWithEffect(name, fn)`
- `effectRootScope(fn)`

---

## How It Works

### `useActor`

Best for component scripts.

- accepts a static actor config or a reactive getter
- mounts automatically inside `$effect`
- keeps connection state in Svelte 5 `$state`
- re-subscribes when getter dependencies change
- exposes actor methods directly on the returned object

### `createReactiveActor`

Best for modules, classes, or view-model style composition.

- safe to create outside components
- manual lifecycle via `mount()` and `dispose()`
- event handlers return unsubscribe functions
- also forwards actor methods directly through a Proxy

---

## Key Design Decisions

### `MaybeGetter` support

`useActor` accepts either:

- a plain config object
- a getter function returning the config

That allows patterns like:

```ts
const room = useActor(() => ({
  name: "raceRoom" as const,
  key: [roomId],
  params: { playerName, carVariant },
}));
```

### Proxy-forwarded actor methods

Both APIs forward unknown properties to the live actor connection, so consumers can call:

```ts
await room.getJoinState();
await room.readyUp();
await room.voteRematch();
```

instead of reaching through `room.connection`.

### Closure-based `$state` for reactive actors

`createReactiveActor` uses closure state rather than `$state` class fields because Svelte 5 compiles class fields to JavaScript private fields, which do not mix cleanly with `Proxy`.

### SSR behavior

`useActor` is safe in SvelteKit because `$effect` only runs in the browser. During SSR, reactive actor state stays in its idle defaults.

---

## Integration In This Repo

### Root layout

`src/routes/+layout.svelte`

```svelte
<script lang="ts">
  import { setupRivetKit } from "@rivetkit/svelte";
  import type { registry } from "$lib/actors/registry";

  setupRivetKit<typeof registry>(`${window.location.origin}/api/rivet`);
</script>
```

### Lobby actor usage

`src/routes/race/+page.svelte`

- gets `useActor` from `getRivetContext<typeof registry>()`
- connects to `lobby`
- calls `listRooms()`, `createRoom()`, and `findOrCreateRoom()`
- reacts to `roomCreated`, `roomUpdated`, and `roomRemoved`

### Race room usage

`src/lib/racing/use-race-room.svelte.ts`

- connects to `raceRoom`
- syncs with `getJoinState()`
- listens to snapshots and room events
- exposes `sendInput()`, `useItem()`, `readyUp()`, `voteRematch()`, and `leave()`

---

## Patterns

### Standard app setup

```svelte
<script lang="ts">
  import { setupRivetKit } from "@rivetkit/svelte";
  import type { registry } from "$lib/actors/registry";

  setupRivetKit<typeof registry>(`${window.location.origin}/api/rivet`);
</script>
```

### Context lookup

```ts
const { useActor } = getRivetContext<typeof registry>();
const lobby = useActor({ name: "lobby", key: ["main"] });
```

### Reactive actor key

```ts
const room = useActor(() => ({
  name: "raceRoom" as const,
  key: [roomId],
  params: { playerName, carVariant },
}));
```

### View-model composition

```ts
class RaceRoomViewModel {
  actor = createReactiveActor<"raceRoom">({
    name: "raceRoom",
    key: ["room-123"],
    params: { playerName: "Racer", carVariant: 0 },
  });
}
```

---

## Testing Guidance

Use `@rivetkit/svelte/testing` when testing rune-based logic that relies on `$effect.root`.

Key areas to cover:

- state subscription updates
- reconnection and event re-binding
- Proxy method forwarding
- `MaybeGetter` re-subscription behavior
- missing-context errors from `getRivetContext()`

---

## Related Files

- `src/lib/rivetkit-svelte/README.md`
- `AGENTS.md`
- `src/lib/actors/registry.ts`
- `src/lib/racing/use-race-room.svelte.ts`
