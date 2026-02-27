/**
 * @rivetkit/svelte — Svelte 5 runes integration for RivetKit actors.
 *
 * Thin adapter over `@rivetkit/framework-base` that bridges actor state
 * into Svelte 5 reactive primitives (`$state`, `$effect`).
 *
 * @module
 */

import {
	createRivetKit as createVanillaRivetKit,
	type ActorOptions,
	type AnyActorRegistry,
	type CreateRivetKitOptions,
} from "@rivetkit/framework-base";
import {
	type Client,
	createClient,
	type ExtractActorsFromRegistry,
	type ActorConn,
	type ActorHandle,
	type ActorConnStatus,
	type AnyActorDefinition,
} from "rivetkit/client";
import type { MaybeGetter } from "./internal/types.js";
import { extract } from "./internal/extract.js";

export type { ActorConnStatus } from "@rivetkit/framework-base";
export { createClient } from "rivetkit/client";
export type { ActorOptions, AnyActorRegistry } from "@rivetkit/framework-base";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Reactive actor state returned by {@link RivetKit.useActor | useActor}.
 *
 * All actor actions (e.g. `sendMessage`, `getState`) are available directly
 * on the object via Proxy forwarding to the underlying connection.
 *
 * Every property is backed by Svelte 5 `$state` — reads inside
 * `$derived` / `$effect` / template expressions are automatically tracked.
 *
 * @typeParam Registry - The actor registry type.
 * @typeParam ActorName - The specific actor name within the registry.
 */
export type ActorState<
	Registry extends AnyActorRegistry = AnyActorRegistry,
	ActorName extends keyof ExtractActorsFromRegistry<Registry> = keyof ExtractActorsFromRegistry<Registry>,
> = {
	/** The active WebSocket connection, or `null` when not connected. */
	readonly connection: ActorConn<AnyActorDefinition> | null;
	/** The actor handle used to create the connection. */
	readonly handle: ActorHandle<AnyActorDefinition> | null;
	/** Current connection lifecycle status (`"idle"` | `"connecting"` | `"connected"` | `"reconnecting"` | `"disconnected"`). */
	readonly connStatus: ActorConnStatus;
	/** Last connection error, or `null`. */
	readonly error: Error | null;
	/** `true` when `connStatus === "connected"`. */
	readonly isConnected: boolean;
	/** Internal hash identifying this actor instance. */
	readonly hash: string;
	/**
	 * Subscribe to a named event broadcast by the actor.
	 *
	 * The subscription is automatically cleaned up when the component unmounts.
	 * Must be called during component initialization (alongside `useActor`).
	 *
	 * @param eventName - The event name to listen for.
	 * @param handler - Callback invoked when the event fires.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onEvent: (eventName: string, handler: (...args: any[]) => void) => void;
} & Omit<
	ActorConn<ExtractActorsFromRegistry<Registry>[ActorName]>,
	"on" | "dispose" | "connection" | "handle" | "connStatus" | "error" | "isConnected" | "hash"
>;

/**
 * Reactive actor handle returned by {@link RivetKit.createReactiveActor | createReactiveActor}.
 *
 * All actor actions are automatically available as methods via Proxy
 * forwarding to the underlying connection.
 *
 * @typeParam Registry - The actor registry type.
 * @typeParam ActorName - The specific actor name within the registry.
 */
export type ReactiveActorHandle<
	Registry extends AnyActorRegistry,
	ActorName extends keyof ExtractActorsFromRegistry<Registry>,
> = {
	/** The active WebSocket connection, or `null` when not connected. */
	readonly connection: ActorConn<AnyActorDefinition> | null;
	/** The actor handle used to create the connection. */
	readonly handle: ActorHandle<AnyActorDefinition> | null;
	/** Current connection lifecycle status. */
	readonly connStatus: ActorConnStatus;
	/** Last connection error, or `null`. */
	readonly error: Error | null;
	/** `true` when `connStatus === "connected"`. */
	readonly isConnected: boolean;
	/** Internal hash identifying this actor instance. */
	readonly hash: string;
	/**
	 * Start the connection lifecycle.
	 *
	 * Framework-base handles ref counting internally — multiple mounts
	 * to the same actor share one WebSocket.
	 *
	 * @returns An unmount function to decrement the ref count.
	 */
	mount(): () => void;
	/**
	 * Clean up all event subscriptions and the framework-base state subscription.
	 * Call this when the reactive actor is no longer needed.
	 */
	dispose(): void;
	/**
	 * Subscribe to an actor broadcast event.
	 *
	 * Automatically re-binds when the connection changes (e.g. after reconnect).
	 *
	 * @param eventName - The event name to listen for.
	 * @param handler - Callback invoked when the event fires.
	 * @returns An unsubscribe function.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onEvent(eventName: string, handler: (...args: any[]) => void): () => void;
} & Omit<
	ActorConn<ExtractActorsFromRegistry<Registry>[ActorName]>,
	"on" | "dispose" | "connection" | "handle" | "connStatus" | "error" | "isConnected" | "hash"
>;

// ---------------------------------------------------------------------------
// Proxy helper — wraps a getter-based inner object so unknown props
// forward to the live actor connection. Used by both useActor and
// createReactiveActor. Closure-based $state avoids the Proxy + private
// field incompatibility that exists with Svelte 5 class-field $state.
// ---------------------------------------------------------------------------

function proxyWithConnection<T extends object>(
	inner: T,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getConnection: () => ActorConn<any> | null,
): T {
	return new Proxy(inner, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			const conn = getConnection();
			if (conn && typeof prop === "string") {
				const val = conn[prop as keyof typeof conn];
				if (typeof val === "function") {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					return (...args: any[]) => (val as Function).apply(conn, args);
				}
			}
			return undefined;
		},
	});
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * The main RivetKit instance — returned by {@link createRivetKit} and
 * {@link createRivetKitWithClient}.
 *
 * Provides two APIs for connecting to actors:
 * - {@link RivetKit.useActor | useActor} — component-scoped, `$effect`-managed lifecycle.
 * - {@link RivetKit.createReactiveActor | createReactiveActor} — manual lifecycle for singletons and ViewModels.
 *
 * @typeParam Registry - The actor registry type.
 */
export interface RivetKit<Registry extends AnyActorRegistry> {
	/**
	 * Connect to an actor and receive reactive state with auto-proxied methods.
	 *
	 * Must be called during component initialization (inside `<script>`).
	 * Lifecycle is managed automatically via `$effect`.
	 *
	 * Accepts a static options object or a `MaybeGetter` thunk for reactive args:
	 *
	 * @example
	 * ```typescript
	 * // Static
	 * useActor({ name: 'counter', key: ['main'] })
	 * // Reactive — re-subscribes when roomId changes
	 * useActor(() => ({ name: 'chatRoom', key: [roomId] }))
	 * ```
	 *
	 * @param opts - Actor options or a getter returning actor options.
	 * @returns A reactive, proxied object with actor state and methods.
	 */
	useActor: <ActorName extends keyof ExtractActorsFromRegistry<Registry>>(
		opts: MaybeGetter<ActorOptions<Registry, ActorName>>,
	) => ActorState<Registry, ActorName>;

	/**
	 * Create a reactive actor handle with auto-proxied methods.
	 *
	 * Safe to call outside components (e.g. in a `.svelte.ts` module for
	 * singletons). Lifecycle is manual via `mount()` / `dispose()`.
	 * All actor actions are available directly on the returned object.
	 *
	 * @param opts - Actor options (name, key, params, etc.).
	 * @returns A reactive, proxied handle with actor state, methods, and lifecycle controls.
	 */
	createReactiveActor: <
		ActorName extends keyof ExtractActorsFromRegistry<Registry>,
	>(
		opts: ActorOptions<Registry, ActorName>,
	) => ReactiveActorHandle<Registry, ActorName>;
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create a RivetKit instance with a new client.
 *
 * @param clientInput - Endpoint URL or client config passed to `createClient()`.
 * @param opts - Optional hash function override.
 * @returns A {@link RivetKit} instance with `useActor` and `createReactiveActor`.
 *
 * @example
 * ```typescript
 * const rivet = createRivetKit<AppRegistry>('http://localhost:3000');
 * ```
 */
export function createRivetKit<Registry extends AnyActorRegistry>(
	clientInput?: Parameters<typeof createClient<Registry>>[0],
	opts?: CreateRivetKitOptions<Registry>,
): RivetKit<Registry> {
	return createRivetKitWithClient<Registry>(
		createClient<Registry>(clientInput),
		opts,
	);
}

/**
 * Create a RivetKit instance with a pre-existing client.
 *
 * @param client - An existing rivetkit `Client` instance.
 * @param opts - Optional hash function override.
 * @returns A {@link RivetKit} instance with `useActor` and `createReactiveActor`.
 *
 * @example
 * ```typescript
 * import { createClient } from 'rivetkit/client';
 * const client = createClient<AppRegistry>('http://localhost:3000');
 * const rivet = createRivetKitWithClient<AppRegistry>(client);
 * ```
 */
export function createRivetKitWithClient<Registry extends AnyActorRegistry>(
	client: Client<Registry>,
	opts: CreateRivetKitOptions<Registry> = {},
): RivetKit<Registry> {
	type Actors = ExtractActorsFromRegistry<Registry>;

	const { getOrCreateActor } = createVanillaRivetKit<Registry, Actors>(
		client,
		opts,
	);

	// -------------------------------------------------------------------
	// useActor — component-scoped, $effect-managed lifecycle
	//
	// Accepts static options or a MaybeGetter thunk for reactive args.
	// Returns a Proxy that forwards unknown props to the actor connection,
	// giving flat access to actor methods (e.g. actor.sendMessage()).
	// -------------------------------------------------------------------

	function useActor<ActorName extends keyof Actors>(
		optsOrGetter: MaybeGetter<ActorOptions<Registry, ActorName>>,
	): ActorState<Registry, ActorName> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let _connection = $state<ActorConn<any> | null>(null);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let _handle = $state<ActorHandle<any> | null>(null);
		let _connStatus = $state<ActorConnStatus>("idle" as ActorConnStatus);
		let _error = $state<Error | null>(null);
		let _hash = $state("");

		$effect(() => {
			const actorOpts = extract(optsOrGetter);
			const { mount, state: derived } = getOrCreateActor<ActorName>(actorOpts);
			const unmount = mount();

			const initial = derived.state;
			if (initial) {
				_connection = initial.connection;
				_handle = initial.handle;
				_connStatus = initial.connStatus;
				_error = initial.error;
				_hash = initial.hash ?? "";
			}

			const unsub = derived.subscribe(({ currentVal }) => {
				if (!currentVal) return;
				_connection = currentVal.connection;
				_handle = currentVal.handle;
				_connStatus = currentVal.connStatus;
				_error = currentVal.error;
				_hash = currentVal.hash ?? "";
			});

			return () => {
				unsub();
				unmount();
			};
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		function onEvent(eventName: string, handler: (...args: any[]) => void): void {
			$effect(() => {
				if (!_connection) return;
				return _connection.on(eventName, handler);
			});
		}

		const inner = {
			get connection() {
				return _connection;
			},
			get handle() {
				return _handle;
			},
			get connStatus() {
				return _connStatus;
			},
			get error() {
				return _error;
			},
			get isConnected() {
				return _connStatus === "connected";
			},
			get hash() {
				return _hash;
			},
			onEvent,
		};

		return proxyWithConnection(inner, () => _connection) as ActorState<Registry, ActorName>;
	}

	// -------------------------------------------------------------------
	// createReactiveActor — manual lifecycle, Proxy-forwarded methods
	// -------------------------------------------------------------------

	function createReactiveActor<ActorName extends keyof Actors>(
		actorOpts: ActorOptions<Registry, ActorName>,
	): ReactiveActorHandle<Registry, ActorName> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let _connection = $state<ActorConn<any> | null>(null);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let _handle = $state<ActorHandle<any> | null>(null);
		let _connStatus = $state<ActorConnStatus>("idle" as ActorConnStatus);
		let _error = $state<Error | null>(null);
		let _hash = $state("");

		const { mount, state: derived } = getOrCreateActor<ActorName>(actorOpts);

		const _eventListeners = new Set<{
			event: string;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			handler: (...args: any[]) => void;
			unsubscribe?: () => void;
		}>();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		function _applyState(val: any): void {
			if (!val) return;
			const prevConn = _connection;

			_connection = val.connection;
			_handle = val.handle;
			_connStatus = val.connStatus;
			_error = val.error;
			_hash = val.hash ?? "";

			if (prevConn !== _connection) {
				for (const listener of _eventListeners) {
					if (listener.unsubscribe) listener.unsubscribe();
					if (_connection) {
						listener.unsubscribe = _connection.on(
							listener.event,
							listener.handler,
						);
					}
				}
			}
		}

		_applyState(derived.state);
		const _unsub = derived.subscribe(({ currentVal }) => _applyState(currentVal));

		const inner = {
			get connection() {
				return _connection;
			},
			get handle() {
				return _handle;
			},
			get connStatus() {
				return _connStatus;
			},
			get error() {
				return _error;
			},
			get isConnected() {
				return _connStatus === "connected";
			},
			get hash() {
				return _hash;
			},

			mount() {
				return mount();
			},

			dispose() {
				_unsub();
				for (const listener of _eventListeners) {
					if (listener.unsubscribe) listener.unsubscribe();
				}
				_eventListeners.clear();
			},

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			onEvent(eventName: string, handler: (...args: any[]) => void): () => void {
				const listener: {
					event: string;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					handler: (...args: any[]) => void;
					unsubscribe?: () => void;
				} = { event: eventName, handler };

				if (_connection) {
					listener.unsubscribe = _connection.on(eventName, handler);
				}
				_eventListeners.add(listener);

				return () => {
					if (listener.unsubscribe) listener.unsubscribe();
					_eventListeners.delete(listener);
				};
			},
		};

		return proxyWithConnection(inner, () => _connection) as ReactiveActorHandle<Registry, ActorName>;
	}

	return { useActor, createReactiveActor };
}
