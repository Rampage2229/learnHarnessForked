/** Boot liveness probe (performance round): the Electron shell's
 *  waitUntilUp used to poll GET / — a full home SSR — before the window
 *  could open. This endpoint answers in microseconds; any response
 *  (even a middleware 403) proves the server is up. */
export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ ok: true });
}
