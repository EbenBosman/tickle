import Fastify, { type FastifyInstance } from "fastify";

/**
 * Build a Fastify instance with a single route registered against an
 * in-memory SQLite. Caller is responsible for calling
 * `process.env.TICKLE_DB_PATH = ":memory:"` and `vi.resetModules()` in
 * beforeEach so that every dynamic import below starts fresh.
 *
 * The helper imports the route module dynamically so the in-memory DB
 * created for this test is the one the route sees.
 */
export async function buildAppWithRoute(
  routePath: string,
): Promise<FastifyInstance> {
  const mod = (await import(routePath)) as Record<string, unknown>;
  // Each route file exports exactly one register function — pick the
  // first function-typed export to keep callers from having to know the
  // exact name.
  const register = Object.values(mod).find(
    (v): v is (app: FastifyInstance) => Promise<void> | void => typeof v === "function",
  );
  if (!register) throw new Error(`No register function exported from ${routePath}`);
  const app = Fastify();
  await app.register(register);
  return app;
}
