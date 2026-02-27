// Core API
export {
	createRivetKit,
	createRivetKitWithClient,
	createClient,
	type RivetKit,
	type ActorState,
	type ReactiveActorHandle,
	type ActorConnStatus,
	type ActorOptions,
	type AnyActorRegistry,
} from "./rivetkit.svelte.js";

// Context helpers
export {
	setRivetContext,
	getRivetContext,
	hasRivetContext,
	setupRivetKit,
	setupRivetKitWithClient,
} from "./context.js";

// Ecosystem-standard types (runed / melt-ui / bits-ui convention)
export type { Getter, MaybeGetter } from "./internal/types.js";
export { extract } from "./internal/extract.js";
