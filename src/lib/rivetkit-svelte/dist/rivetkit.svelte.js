/**
 * @rivetkit/svelte — Svelte 5 runes integration for RivetKit actors.
 *
 * Thin adapter over `@rivetkit/framework-base` that bridges actor state
 * into Svelte 5 reactive primitives (`$state`, `$effect`).
 *
 * @module
 */
import { createRivetKit as createVanillaRivetKit, } from "@rivetkit/framework-base";
import { createClient, } from "rivetkit/client";
import { extract } from "./internal/extract.js";
export { createClient } from "rivetkit/client";
// ---------------------------------------------------------------------------
// Proxy helper — wraps a getter-based inner object so unknown props
// forward to the live actor connection. Used by both useActor and
// createReactiveActor. Closure-based $state avoids the Proxy + private
// field incompatibility that exists with Svelte 5 class-field $state.
// ---------------------------------------------------------------------------
function proxyWithConnection(inner, 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
getConnection) {
    return new Proxy(inner, {
        get(target, prop, receiver) {
            if (Reflect.has(target, prop)) {
                return Reflect.get(target, prop, receiver);
            }
            const conn = getConnection();
            if (conn && typeof prop === "string") {
                const val = conn[prop];
                if (typeof val === "function") {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return (...args) => val.apply(conn, args);
                }
            }
            return undefined;
        },
    });
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
export function createRivetKit(clientInput, opts) {
    return createRivetKitWithClient(createClient(clientInput), opts);
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
export function createRivetKitWithClient(client, opts = {}) {
    const { getOrCreateActor } = createVanillaRivetKit(client, opts);
    // -------------------------------------------------------------------
    // useActor — component-scoped, $effect-managed lifecycle
    //
    // Accepts static options or a MaybeGetter thunk for reactive args.
    // Returns a Proxy that forwards unknown props to the actor connection,
    // giving flat access to actor methods (e.g. actor.sendMessage()).
    // -------------------------------------------------------------------
    function useActor(optsOrGetter) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let _connection = $state(null);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let _handle = $state(null);
        let _connStatus = $state("idle");
        let _error = $state(null);
        let _hash = $state("");
        $effect(() => {
            const actorOpts = extract(optsOrGetter);
            const { mount, state: derived } = getOrCreateActor(actorOpts);
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
                if (!currentVal)
                    return;
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
        function onEvent(eventName, handler) {
            $effect(() => {
                if (!_connection)
                    return;
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
        return proxyWithConnection(inner, () => _connection);
    }
    // -------------------------------------------------------------------
    // createReactiveActor — manual lifecycle, Proxy-forwarded methods
    // -------------------------------------------------------------------
    function createReactiveActor(actorOpts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let _connection = $state(null);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let _handle = $state(null);
        let _connStatus = $state("idle");
        let _error = $state(null);
        let _hash = $state("");
        const { mount, state: derived } = getOrCreateActor(actorOpts);
        const _eventListeners = new Set();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function _applyState(val) {
            if (!val)
                return;
            const prevConn = _connection;
            _connection = val.connection;
            _handle = val.handle;
            _connStatus = val.connStatus;
            _error = val.error;
            _hash = val.hash ?? "";
            if (prevConn !== _connection) {
                for (const listener of _eventListeners) {
                    if (listener.unsubscribe)
                        listener.unsubscribe();
                    if (_connection) {
                        listener.unsubscribe = _connection.on(listener.event, listener.handler);
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
                    if (listener.unsubscribe)
                        listener.unsubscribe();
                }
                _eventListeners.clear();
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onEvent(eventName, handler) {
                const listener = { event: eventName, handler };
                if (_connection) {
                    listener.unsubscribe = _connection.on(eventName, handler);
                }
                _eventListeners.add(listener);
                return () => {
                    if (listener.unsubscribe)
                        listener.unsubscribe();
                    _eventListeners.delete(listener);
                };
            },
        };
        return proxyWithConnection(inner, () => _connection);
    }
    return { useActor, createReactiveActor };
}
