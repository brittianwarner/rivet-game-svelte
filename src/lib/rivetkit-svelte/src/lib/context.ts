/**
 * Svelte context helpers for sharing a RivetKit instance through the
 * component tree.
 *
 * Follows the type-safe context pattern established by runed and bits-ui.
 *
 * @module
 */

import { getContext, hasContext, setContext } from "svelte";
import type { AnyActorRegistry, CreateRivetKitOptions } from "@rivetkit/framework-base";
import { type RivetKit, createRivetKit, createRivetKitWithClient, createClient } from "./rivetkit.svelte.js";
import type { Client } from "rivetkit/client";

const RIVETKIT_CONTEXT_KEY = Symbol("rivetkit");

/**
 * Store a RivetKit instance in Svelte context.
 *
 * Must be called during component initialization (inside `<script>`).
 * Typically called once in a root layout component.
 *
 * @param rivet - The RivetKit instance from `createRivetKit()` or `createRivetKitWithClient()`.
 * @returns The same instance (for chaining convenience).
 */
export function setRivetContext<Registry extends AnyActorRegistry>(
	rivet: RivetKit<Registry>,
): RivetKit<Registry> {
	setContext(RIVETKIT_CONTEXT_KEY, rivet);
	return rivet;
}

/**
 * Retrieve the RivetKit instance from Svelte context.
 *
 * Must be called during component initialization (inside `<script>`).
 *
 * @throws {Error} If no RivetKit instance was set by a parent component.
 * @returns The RivetKit instance with typed `useActor` and `createReactiveActor`.
 */
export function getRivetContext<
	Registry extends AnyActorRegistry,
>(): RivetKit<Registry> {
	const ctx = getContext<RivetKit<Registry> | undefined>(RIVETKIT_CONTEXT_KEY);
	if (ctx === undefined) {
		throw new Error(
			'Context "RivetKit" not found. Did you call setupRivetKit() or setRivetContext() in a parent layout?',
		);
	}
	return ctx;
}

/**
 * Check whether a RivetKit instance exists in the current Svelte context.
 *
 * Useful for components that should conditionally connect to actors
 * only when RivetKit is available.
 *
 * Must be called during component initialization (inside `<script>`).
 *
 * @returns `true` if a parent component set a RivetKit context.
 */
export function hasRivetContext(): boolean {
	return hasContext(RIVETKIT_CONTEXT_KEY);
}

/**
 * One-call convenience: create a RivetKit instance and set it in Svelte context.
 *
 * Must be called during component initialization (inside `<script>`).
 * Combines `createRivetKit()` + `setRivetContext()` into a single call.
 *
 * @param clientInput - Endpoint URL or client config passed to `createClient()`.
 * @param opts - Optional hash function override.
 * @returns The RivetKit instance (also stored in context).
 *
 * @example
 * ```svelte
 * <!-- +layout.svelte -->
 * <script lang="ts">
 *   import { setupRivetKit } from '@rivetkit/svelte';
 *   setupRivetKit<AppRegistry>('http://localhost:3000');
 * </script>
 * ```
 */
export function setupRivetKit<Registry extends AnyActorRegistry>(
	clientInput?: Parameters<typeof createClient<Registry>>[0],
	opts?: CreateRivetKitOptions<Registry>,
): RivetKit<Registry> {
	const rivet = createRivetKit<Registry>(clientInput, opts);
	return setRivetContext(rivet);
}

/**
 * One-call convenience: wrap an existing client and set it in Svelte context.
 *
 * Must be called during component initialization (inside `<script>`).
 * Combines `createRivetKitWithClient()` + `setRivetContext()` into a single call.
 *
 * @param client - An existing rivetkit `Client` instance.
 * @param opts - Optional hash function override.
 * @returns The RivetKit instance (also stored in context).
 *
 * @example
 * ```svelte
 * <!-- +layout.svelte -->
 * <script lang="ts">
 *   import { createClient } from 'rivetkit/client';
 *   import { setupRivetKitWithClient } from '@rivetkit/svelte';
 *   const client = createClient<AppRegistry>('http://localhost:3000');
 *   setupRivetKitWithClient<AppRegistry>(client);
 * </script>
 * ```
 */
export function setupRivetKitWithClient<Registry extends AnyActorRegistry>(
	client: Client<Registry>,
	opts?: CreateRivetKitOptions<Registry>,
): RivetKit<Registry> {
	const rivet = createRivetKitWithClient<Registry>(client, opts);
	return setRivetContext(rivet);
}
