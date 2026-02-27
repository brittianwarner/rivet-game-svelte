/**
 * Resolve a {@link MaybeGetter} to its underlying value.
 *
 * If `value` is a function, it is invoked and its return value is used.
 * If the resolved value is `undefined`, the optional `defaultValue` is
 * returned instead.
 *
 * @param value - A value or a getter function returning the value.
 * @param defaultValue - Fallback if the resolved value is `undefined`.
 * @returns The resolved value, or the default.
 */
import type { MaybeGetter } from "./types.js";
export declare function extract<T>(value: MaybeGetter<T>): T;
export declare function extract<T>(value: MaybeGetter<T | undefined>, defaultValue: T): T;
//# sourceMappingURL=extract.d.ts.map