/**
 * Svelte 5 rune-aware test helpers.
 *
 * Svelte 5 runes (`$state`, `$effect`) require a reactive root context
 * to execute. These helpers create that context inside vitest (or any
 * test runner), following the pattern established by runed.
 *
 * @module
 */
/**
 * Run a test inside a Svelte 5 `$effect.root` so that `$state`,
 * `$derived`, and `$effect` work correctly.
 *
 * @param name - Test name (passed to vitest `test()`).
 * @param fn - Test body. May be async. `$state` and `$effect` are available inside.
 *
 * @example
 * ```typescript
 * import { describe, expect } from "vitest";
 * import { testWithEffect } from "@rivetkit/svelte/testing";
 * import { flushSync } from "svelte";
 *
 * describe("useActor", () => {
 *   testWithEffect("returns idle status initially", () => {
 *     let status = $state("idle");
 *     expect(status).toBe("idle");
 *   });
 * });
 * ```
 */
export declare function testWithEffect(name: string, fn: () => void | Promise<void>): void;
/**
 * Execute a function inside a Svelte 5 `$effect.root`.
 *
 * Useful when you need `$effect.root` without the vitest `test()` wrapper
 * (e.g. inside `beforeEach` or custom setup functions).
 *
 * @param fn - Function to execute. May be async.
 * @returns `void` or a `Promise<void>` that resolves when the function completes.
 */
export declare function effectRootScope(fn: () => void | Promise<void>): void | Promise<void>;
//# sourceMappingURL=test-helpers.svelte.d.ts.map