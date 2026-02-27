import { registry } from "$lib/actors/registry";
import type { RequestHandler } from "./$types";

const handle: RequestHandler = async ({ request }) => {
	return registry.handler(request);
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
export const OPTIONS = handle;
export const fallback = handle;
