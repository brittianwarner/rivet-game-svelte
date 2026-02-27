# Packages / rivetkit-svelte

**Parent:** [Root](../../AGENTS.md)

Official Svelte 5 adapter for RivetKit actors. Thin adapter over `@rivetkit/framework-base` — the Svelte counterpart of `@rivetkit/react`.

---

## Workspace

|             |                                                    |
| ----------- | -------------------------------------------------- |
| Package     | `@rivetkit/svelte`                                 |
| Scripts     | `build`, `check-types`                             |
| Depends on  | `@rivetkit/framework-base`, `rivetkit`, `esm-env`  |
| Peer deps   | `svelte` ^5.0.0                                    |
| Dev deps    | `vitest` (for `./testing` subpath)                 |
| Consumed by | `apps/web` (workspace dep: `"@rivetkit/svelte": "workspace:*"`), any SvelteKit app |

## Architecture

```
Component-scoped (useActor):
  Component → useActor(opts | () => opts)
                  → extract(MaybeGetter) resolves thunk
                  → framework-base.getOrCreateActor()
                        ↓
                   $effect subscribes → writes closure $state
                        ↓
                   Proxy { inner getters + forwarded actor methods }

Manual lifecycle (createReactiveActor):
  Module → createReactiveActor(opts) → framework-base.getOrCreateActor()
                                            ↓
                                       subscribe → writes closure $state
                                            ↓
                              Proxy { inner getters + forwarded actor methods }
```

## Structure

```
packages/rivetkit-svelte/
├── package.json
├── tsconfig.json
├── AGENTS.md                    # This file
├── README.md                    # Usage docs with examples
└── src/
    └── lib/
        ├── index.ts                  # Barrel exports (main entry)
        ├── rivetkit.svelte.ts        # createRivetKit, useActor, createReactiveActor
        ├── context.ts                # setup*, set/get/hasRivetContext
        ├── internal/
        │   ├── index.ts              # Internal barrel
        │   ├── types.ts              # Getter<T>, MaybeGetter<T>
        │   └── extract.ts            # extract(MaybeGetter) resolver
        └── testing/
            ├── index.ts              # Testing subpath barrel
            └── test-helpers.svelte.ts # testWithEffect, effectRootScope
```

## Subpath Exports

| Subpath | Entry | Purpose |
|---|---|---|
| `@rivetkit/svelte` | `./dist/index.js` | Core API (useActor, createReactiveActor, context, types) |
| `@rivetkit/svelte/testing` | `./dist/testing/index.js` | Test utilities (testWithEffect, effectRootScope) |

## Public API

### Factory Functions

- `createRivetKit<Registry>(endpoint?, opts?)` — Create instance with new client
- `createRivetKitWithClient<Registry>(client, opts?)` — Create instance with existing client

Both return `{ useActor, createReactiveActor }`.

### Setup Helpers (Context)

- `setupRivetKit<Registry>(endpoint?, opts?)` — Create + set context in one call (recommended)
- `setupRivetKitWithClient<Registry>(client, opts?)` — Wrap existing client + set context
- `setRivetContext(rivet)` — Store instance in Svelte context (lower-level)
- `getRivetContext()` — Retrieve instance from Svelte context. **Throws** with descriptive error if missing.
- `hasRivetContext()` — Check if RivetKit context exists (for conditional actor usage)

### Composables

- `useActor<ActorName>(opts: MaybeGetter<ActorOptions>)` — Connect to actor, returns reactive proxied state
  - Must be called during component initialization
  - Accepts static options or a `MaybeGetter` thunk for reactive args (re-subscribes on change)
  - Returns `{ connection, handle, connStatus, error, isConnected, hash, onEvent }` + proxied actor methods
  - All properties are `$state`-backed getters
  - `onEvent(name, handler)` subscribes to actor broadcasts via `$effect`
  - Unknown property access forwards to the live actor connection via Proxy

- `createReactiveActor<ActorName>(opts)` — Create a reactive actor handle
  - Safe to call anywhere (modules, classes, component scripts)
  - Returns a Proxy that forwards method calls to the actor connection
  - Manual lifecycle via `mount()` / `dispose()`
  - `onEvent(name, handler)` returns an unsubscribe function
  - All actor actions available directly on the returned object

### Types

- `ActorState<Registry, ActorName>` — Return type of `useActor` (reactive + proxied)
- `ReactiveActorHandle<Registry, ActorName>` — Return type of `createReactiveActor`
- `RivetKit<Registry>` — The main instance type
- `Getter<T>` — A function returning `T` (ecosystem-standard, runed convention)
- `MaybeGetter<T>` — `T | Getter<T>` (ecosystem-standard, matches runed/melt-ui/bits-ui)

### Utilities

- `extract(maybeGetter)` — Resolve a `MaybeGetter<T>` to its value. Exported for consumers building their own reactive patterns. Part of the runed ecosystem convention.

### Testing (subpath: `@rivetkit/svelte/testing`)

- `testWithEffect(name, fn)` — Run a vitest test inside `$effect.root` so `$state`/`$effect` work
- `effectRootScope(fn)` — Execute a function inside `$effect.root` (for `beforeEach`, etc.)

### Re-exports

- `createClient` from `rivetkit/client`
- `ActorConnStatus` type from `@rivetkit/framework-base`
- `ActorOptions`, `AnyActorRegistry` types

## Key Design Decisions

### MaybeGetter<T> + extract() for reactive inputs

Following the convention established by runed, melt-ui, and bits-ui, `useActor` accepts `MaybeGetter<ActorOptions>` instead of a custom union type. The `extract()` function resolves the value. This makes the API instantly familiar to the Svelte 5 ecosystem.

### Fail-fast context with descriptive errors

`getRivetContext()` throws `Context "RivetKit" not found. Did you call setupRivetKit() or setRivetContext() in a parent layout?` instead of silently returning `undefined`. `hasRivetContext()` enables conditional actor usage in components that might render outside the provider.

### Both APIs proxy actor methods

Both `useActor` and `createReactiveActor` return a Proxy that forwards unknown property access to the live actor connection. This means `actor.sendMessage()` works directly instead of `actor.connection.sendMessage()`. A shared `proxyWithConnection()` helper avoids duplication.

### Thunks for reactive arguments

`useActor` accepts a getter function (`() => opts`). When called inside `$effect`, Svelte 5 tracks reactive reads inside the thunk. When a dependency changes, the effect re-runs, unmounts the old actor, and mounts the new one.

### Why closure-based $state for createReactiveActor (not a class)

Svelte 5 compiles `$state` class fields into JavaScript **private fields** (`#field`).
JS `Proxy` **cannot** intercept private field access — private fields are bound to the
original object identity, not the proxy wrapper. This is a fundamental language limitation.

`createReactiveActor` uses closure-based `$state` (local signal variables inside a
function), which compiles to plain `$.state()` calls with **no private fields**. The
Proxy wraps a plain object with getters, avoiding the conflict entirely.

Users who need a class can **compose** the reactive actor as a field:

```typescript
class ChatViewModel {
  actor = createReactiveActor({ name: 'chat', key: ['room-1'] });
  draftMessage = $state(''); // $state is fine here — no Proxy on this class
}
```

### Why setupRivetKit

Most SvelteKit apps need `createRivetKit()` + `setRivetContext()` together in the root layout. `setupRivetKit()` merges these into a single call — matching the convenience patterns in `@tanstack/svelte-query` and `convex-svelte`.

### Why esm-env

`esm-env` is the ecosystem-standard package for SSR detection in Svelte, used internally by SvelteKit. It provides a tree-shakeable `BROWSER` constant that's more reliable than `typeof window` checks.

### Testing subpath separation

Test utilities (`testWithEffect`, `effectRootScope`) live under `@rivetkit/svelte/testing` to keep them out of the production bundle. The `testWithEffect` pattern follows runed's approach: wrapping vitest `test()` in `$effect.root` so runes work in tests.

### Why manual subscription

Svelte 5's `$state` + `$effect` provide a clean bridge to framework-base's internal state. The subscription code is ~15 lines with no extra dependencies.

### Why .svelte.ts files

Svelte 5 runes (`$state`, `$effect`) are compile-time macros that require the Svelte compiler. Source files using runes must have the `.svelte.ts` extension. Plain TypeScript files (`context.ts`, `internal/types.ts`, `internal/extract.ts`) don't use runes.

### Why getters on the return object

Returning `$state` variables directly would lose reactivity when destructured. Getters ensure the returned object always reflects current state regardless of how consumers access it.

### SSR safety

`$effect` only executes in the browser. During SSR, `useActor` returns default values (`null` / `"idle"`). For `createReactiveActor`, guard `mount()` with `browser` from `$app/environment`.

### Connection sharing

Framework-base handles connection caching and ref counting. Multiple `useActor` calls with the same name + key share one WebSocket connection. Connections clean up when the last consumer unmounts.

## Patterns

### Standard SvelteKit pattern (recommended)

```svelte
<!-- +layout.svelte -->
<script lang="ts">
  import { setupRivetKit } from '@rivetkit/svelte';
  setupRivetKit<AppRegistry>('http://localhost:3000');
</script>

<!-- Component.svelte -->
<script lang="ts">
  import { getRivetContext } from '@rivetkit/svelte';
  const { useActor } = getRivetContext<AppRegistry>();
  const actor = useActor({ name: 'counter', key: ['main'] });

  await actor.increment({ amount: 1 });
</script>
```

### Conditional actor usage

```svelte
<script lang="ts">
  import { hasRivetContext, getRivetContext } from '@rivetkit/svelte';

  // Only use actors if a parent provided the context
  const rivet = hasRivetContext() ? getRivetContext<AppRegistry>() : null;
</script>
```

### Reactive arguments (MaybeGetter)

```svelte
<script lang="ts">
  let { roomId } = $props<{ roomId: string }>();
  const { useActor } = getRivetContext<AppRegistry>();

  // Re-subscribes when roomId changes
  const chat = useActor(() => ({ name: 'chatRoom', key: [roomId] }));
</script>
```

### ViewModel pattern (composition)

```typescript
// chat-view-model.svelte.ts
const { createReactiveActor } = createRivetKit<AppRegistry>('...');

export class ChatViewModel {
  actor = createReactiveActor<'chatRoom'>({ name: 'chatRoom', key: ['room-1'] });
  draftMessage = $state('');

  async sendAndClear() {
    await this.actor.sendMessage({ text: this.draftMessage });
    this.draftMessage = '';
  }
}

export const chatVM = new ChatViewModel();
```

### Testing

```typescript
// counter.test.svelte.ts
import { describe, expect } from "vitest";
import { testWithEffect } from "@rivetkit/svelte/testing";

describe("counter", () => {
  testWithEffect("tracks state reactively", () => {
    let count = $state(0);
    expect(count).toBe(0);
  });
});
```

## Integration with apps/web

| Integration point | Location | Usage |
|---|---|---|
| Layout setup | `(app)/+layout.svelte` | `setupRivetKit(data.actorEndpoint)` — endpoint from `+layout.server.ts` (`PUBLIC_RIVET_ENDPOINT` or `apiUrl/api/rivet`) |
| BaseActorViewModel | `$lib/view-models/actor/base-actor-view-model.svelte.ts` | Uses `createRivetKitWithClient(getActorClient(endpoint))` for a module-level RivetKit singleton |
| Reactive actor handle | Same file | `createReactiveActor` (via `_rivet.createReactiveActor()`) provides the reactive actor handle used by all actor ViewModels |

## Relationship to apps/web BaseActorViewModel

This package provides **framework-level** primitives. Layerr's `BaseActorViewModel` builds **application-level** concerns on top:

| Concern | @rivetkit/svelte | BaseActorViewModel |
|---|---|---|
| Connection lifecycle | `mount()`/`dispose()` or `$effect` | `acquire()`/`release()` with 5s grace period |
| State reactivity | Closure `$state` getters | `$state` class fields |
| Actor methods | Proxy-forwarded (both APIs) | Manual `callAction()` wrappers |
| Event subscription | `onEvent()` | `setupCustomEvents()` |
| Auth tokens | Not included (app concern) | JWT management + auto-refresh |
| Toast notifications | Not included (UI concern) | `toastSuccess()`, `toastError()`, etc. |

Over time, `apps/web` can migrate from `BaseActorViewModel` to composing `createReactiveActor` with app-specific logic.

## Testing Guide

Use `vitest` + `@rivetkit/svelte/testing` for tests. Key areas to cover:

- State bridge: mock `@rivetkit/framework-base` to verify `$state` writes
- SSR behavior: ensure no browser APIs during server render
- Event lifecycle: subscribe/unsubscribe on connection change
- Proxy forwarding: actor actions available, cleanup on disconnect
- Thunk re-subscription: `MaybeGetter` dependency changes
- Context errors: `getRivetContext()` throws when missing

## Related

[README.md](./README.md) | [Root AGENTS.md](../../AGENTS.md) | [Actors Package](../actors/AGENTS.md) | [Web App](../../apps/web/AGENTS.md) | [Framework Base](https://github.com/rivet-dev/rivet/tree/main/rivetkit-typescript/packages/framework-base)
