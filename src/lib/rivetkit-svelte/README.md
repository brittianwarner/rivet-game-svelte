# @rivetkit/svelte

Official Svelte 5 adapter for [RivetKit](https://rivet.gg) actors. Connect to stateful, real-time actors with reactive `$state`-backed composables.

Built on `@rivetkit/framework-base` — the same foundation as `@rivetkit/react`.

## Install

```bash
npm install @rivetkit/svelte rivetkit
```

## Quick Start

### 1. Set up in your layout

```svelte
<!-- +layout.svelte -->
<script lang="ts">
  import { setupRivetKit } from '@rivetkit/svelte';
  import type { AppRegistry } from './registry';

  setupRivetKit<AppRegistry>('http://localhost:3000');

  let { children } = $props();
</script>

{@render children()}
```

### 2. Use actors in components

```svelte
<!-- ChatRoom.svelte -->
<script lang="ts">
  import { getRivetContext } from '@rivetkit/svelte';
  import type { AppRegistry } from './registry';

  const { useActor } = getRivetContext<AppRegistry>();

  const chat = useActor({ name: 'chatRoom', key: ['room-123'] });

  let messages = $state<string[]>([]);

  chat.onEvent('newMessage', (msg) => {
    messages = [...messages, msg as string];
  });

  async function send(text: string) {
    await chat.sendMessage({ text });
  }
</script>

{#if chat.isConnected}
  <ul>
    {#each messages as msg}
      <li>{msg}</li>
    {/each}
  </ul>
{:else if chat.error}
  <p>Error: {chat.error.message}</p>
{:else}
  <p>Connecting...</p>
{/if}
```

## Two APIs: `useActor` vs `createReactiveActor`

| | `useActor` | `createReactiveActor` |
|---|---|---|
| Best for | Components | Singletons, ViewModels |
| Lifecycle | Automatic (`$effect`) | Manual (`mount()` / `dispose()`) |
| Where to call | Component `<script>` only | Anywhere (modules, classes) |
| Actor methods | Direct on the object (proxied) | Direct on the object (proxied) |
| Reactive args | `MaybeGetter` thunks | Static only |
| SSR safe | Automatic | Must guard with `browser` check |

## API

### `setupRivetKit<Registry>(endpoint?, opts?)`

Create a RivetKit instance and set it in Svelte context in one call. The recommended way to initialize.

```svelte
<!-- +layout.svelte -->
<script lang="ts">
  import { setupRivetKit } from '@rivetkit/svelte';
  const rivet = setupRivetKit<AppRegistry>('http://localhost:3000');
</script>
```

### `setupRivetKitWithClient<Registry>(client, opts?)`

Same as `setupRivetKit` but with a pre-existing client.

```svelte
<script lang="ts">
  import { createClient } from 'rivetkit/client';
  import { setupRivetKitWithClient } from '@rivetkit/svelte';
  const client = createClient<AppRegistry>('http://localhost:3000');
  const rivet = setupRivetKitWithClient<AppRegistry>(client);
</script>
```

### `createRivetKit<Registry>(endpoint?, opts?)`

Create a RivetKit instance without setting context. Useful when you don't need the context API (e.g. module-level singletons).

```typescript
import { createRivetKit } from '@rivetkit/svelte';

const rivet = createRivetKit<AppRegistry>('http://localhost:3000');
```

### `createRivetKitWithClient<Registry>(client, opts?)`

Create a RivetKit instance with a pre-existing client, without setting context.

```typescript
import { createClient } from 'rivetkit/client';
import { createRivetKitWithClient } from '@rivetkit/svelte';

const client = createClient<AppRegistry>('http://localhost:3000');
const rivet = createRivetKitWithClient<AppRegistry>(client);
```

### `useActor<ActorName>(opts)`

Connect to an actor and receive reactive state with auto-proxied methods. Must be called during component initialization.

Accepts a **static options object** or a **`MaybeGetter` thunk** for reactive arguments:

```typescript
const { useActor } = getRivetContext<AppRegistry>();

// Static options
const counter = useActor({ name: 'counter', key: ['main'] });

// Reactive thunk — re-subscribes automatically when roomId changes
const chat = useActor(() => ({
  name: 'chatRoom',
  key: [roomId],
}));

// Actor methods available directly on the object
await counter.increment({ amount: 1 });
await chat.sendMessage({ text: 'Hello!' });
```

Returns a reactive, proxied object:

| Property | Type | Description |
|---|---|---|
| `connection` | `ActorConn \| null` | Active WebSocket connection |
| `handle` | `ActorHandle \| null` | Actor handle for the connection |
| `connStatus` | `ActorConnStatus` | `"idle"` \| `"connecting"` \| `"connected"` \| `"reconnecting"` \| `"disconnected"` |
| `error` | `Error \| null` | Last connection error |
| `isConnected` | `boolean` | `true` when `connStatus === "connected"` |
| `hash` | `string` | Internal hash identifying this actor instance |
| `onEvent(name, handler)` | `function` | Subscribe to actor broadcasts |
| `[actorMethod]()` | Proxied | All actor actions forwarded automatically |

All properties are backed by Svelte 5 `$state` — they update reactively and trigger fine-grained DOM updates.

### `createReactiveActor<ActorName>(opts)`

Create a reactive actor handle with **auto-proxied methods**. Safe to call outside components.

```typescript
const { createReactiveActor } = getRivetContext<AppRegistry>();

const counter = createReactiveActor({ name: 'counter', key: ['main'] });

// Manual lifecycle
const unmount = counter.mount();

// Actor methods are available directly on the object
await counter.increment({ amount: 1 });
const state = await counter.getState();

// Events
const unsub = counter.onEvent('countChanged', (count) => {
  console.log('Count:', count);
});

// Cleanup
unsub();
counter.dispose();
```

Returns a proxied reactive object with all `useActor` properties plus:

| Property | Type | Description |
|---|---|---|
| `mount()` | `() => () => void` | Start connection, returns unmount fn |
| `dispose()` | `() => void` | Clean up subscriptions |
| `onEvent(name, handler)` | `(...) => () => void` | Subscribe, returns unsubscribe fn |
| `[actorMethod]()` | Proxied | All actor actions forwarded automatically |

### Building ViewModels

Compose `createReactiveActor` into your own Svelte 5 classes:

```typescript
// chat-view-model.svelte.ts
import { createRivetKit } from '@rivetkit/svelte';
import type { AppRegistry } from './registry';

const { createReactiveActor } = createRivetKit<AppRegistry>('http://localhost:3000');

export class ChatViewModel {
  actor = createReactiveActor<'chatRoom'>({ name: 'chatRoom', key: ['room-123'] });

  draftMessage = $state('');

  get isConnected() {
    return this.actor.isConnected;
  }

  async sendAndClear() {
    await this.actor.sendMessage({ text: this.draftMessage });
    this.draftMessage = '';
  }
}

export const chatViewModel = new ChatViewModel();
```

```svelte
<!-- ChatRoom.svelte -->
<script lang="ts">
  import { chatViewModel } from './chat-view-model.svelte';

  $effect(() => {
    const unmount = chatViewModel.actor.mount();
    return unmount;
  });
</script>

{#if chatViewModel.isConnected}
  <input bind:value={chatViewModel.draftMessage} />
  <button onclick={() => chatViewModel.sendAndClear()}>Send</button>
{:else}
  <p>Connecting...</p>
{/if}
```

### `onEvent(eventName, handler)`

Subscribe to named events broadcast by the actor. Subscriptions are automatically managed — they re-bind when the connection changes and clean up on unmount.

```typescript
const actor = useActor({ name: 'chatRoom', key: ['room-123'] });

actor.onEvent('messageReceived', (data) => {
  console.log('New message:', data);
});

actor.onEvent('userJoined', (user) => {
  console.log('User joined:', user);
});
```

### Context Helpers

| Function | Description |
|---|---|
| `setupRivetKit(endpoint?, opts?)` | Create + set context in one call (recommended) |
| `setupRivetKitWithClient(client, opts?)` | Wrap existing client + set context |
| `setRivetContext(rivet)` | Store instance in Svelte context (lower-level) |
| `getRivetContext()` | Retrieve instance from context. **Throws** if missing. |
| `hasRivetContext()` | Check if RivetKit context exists (for conditional usage) |

```svelte
<script lang="ts">
  import { hasRivetContext, getRivetContext } from '@rivetkit/svelte';

  // Conditionally connect to actors
  if (hasRivetContext()) {
    const { useActor } = getRivetContext<AppRegistry>();
    const actor = useActor({ name: 'counter', key: ['main'] });
  }
</script>
```

### Utility Types

The package exports ecosystem-standard types used by runed, melt-ui, and bits-ui:

```typescript
import { type MaybeGetter, type Getter, extract } from '@rivetkit/svelte';

// MaybeGetter<T> = T | (() => T)
// Getter<T> = () => T
// extract(maybeGetter) — resolves to the underlying value
```

## Reactive Arguments (MaybeGetter)

`useActor` accepts a `MaybeGetter<ActorOptions>` — either a static options object or a getter function. When using a getter, Svelte tracks reactive reads inside it. When a dependency changes, the actor automatically disconnects from the old instance and connects to the new one.

```svelte
<script lang="ts">
  let { roomId } = $props<{ roomId: string }>();

  const { useActor } = getRivetContext<AppRegistry>();

  // Automatically reconnects when roomId changes
  const chat = useActor(() => ({
    name: 'chatRoom',
    key: [roomId],
  }));
</script>
```

This pattern follows the `MaybeGetter` convention established by `runed`, `@tanstack/svelte-query`, and `convex-svelte`.

## Testing

Test helpers are available via the `@rivetkit/svelte/testing` subpath:

```typescript
import { describe, expect } from "vitest";
import { testWithEffect } from "@rivetkit/svelte/testing";
import { flushSync } from "svelte";

describe("my actor component", () => {
  testWithEffect("can use $state and $effect in tests", () => {
    let count = $state(0);
    expect(count).toBe(0);

    count = 1;
    flushSync();
    expect(count).toBe(1);
  });
});
```

| Export | Description |
|---|---|
| `testWithEffect(name, fn)` | Run a vitest test inside `$effect.root` |
| `effectRootScope(fn)` | Execute a function inside `$effect.root` (for `beforeEach`, etc.) |

## Connection Sharing

Multiple components using `useActor` with the same name + key share a single WebSocket connection. The framework-base handles ref counting — the connection stays open as long as at least one component is mounted, and cleans up when the last one unmounts.

```svelte
<!-- Both components share one connection to the same actor -->
<ChatMessages name="chatRoom" key={['room-123']} />
<ChatInput name="chatRoom" key={['room-123']} />
```

## SSR Safety

`$effect` only runs in the browser. During SSR, `useActor` returns default values (`null`/`"idle"`). No `typeof window` checks or browser guards needed.

For `createReactiveActor` used in module-level singletons, guard with SvelteKit's `browser`:

```typescript
import { browser } from '$app/environment';

if (browser) {
  const unmount = actor.mount();
}
```

## How It Works

```
Component
    ├─ useActor(opts | () => opts)
    │    ├─ extract(MaybeGetter) → resolve thunk
    │    ├─ $effect → framework-base.mount() / unmount()
    │    ├─ framework-base state → writes to $state
    │    ├─ onEvent() → $effect → connection.on() / cleanup
    │    └─ Proxy → forwards unknown props to actor connection
    │
    └─ createReactiveActor(opts)
         ├─ Closure-based $state (no private fields)
         ├─ Proxy → forwards unknown props to actor connection
         ├─ mount() / dispose() for manual lifecycle
         └─ onEvent() → tracks listeners, re-binds on reconnect
```

### Why `createReactiveActor` uses a factory, not a class

Svelte 5 compiles `$state` class fields into JavaScript private fields (`#field`). JS `Proxy` cannot intercept private field access — they are bound to the original object identity, not the proxy wrapper. This is a fundamental language-level incompatibility.

`createReactiveActor` uses closure-based `$state` instead (local signal variables inside a function), which compiles to plain `$.state()` calls with no private fields. The Proxy wraps a plain object with getters, so there is no conflict.

## Comparison with `@rivetkit/react`

| | React | Svelte |
|---|---|---|
| State bridge | React store hook | Manual `.subscribe()` into `$state` |
| Lifecycle | `useEffect(() => mount())` | `$effect(() => mount())` |
| Event subscription | `useEvent` (nested hook) | `onEvent()` (uses `$effect`) |
| Handler stability | `useRef` needed | Not needed (fresh closures) |
| SSR safety | Manual guards | Automatic (`$effect` is browser-only) |
| Context | Not included | `setupRivetKit` / `getRivetContext` / `hasRivetContext` |
| ViewModel pattern | Not included | `createReactiveActor` with Proxy |
| Reactive args | Not built-in | `MaybeGetter` thunks for `useActor` |
| Flat method access | Not built-in | Proxy on both APIs |
| Testing helpers | Not included | `@rivetkit/svelte/testing` subpath |
| Bundle overhead | React runtime | Zero (compiles away) |

## Requirements

- Svelte 5+
- RivetKit 2.1+

## License

Apache-2.0
