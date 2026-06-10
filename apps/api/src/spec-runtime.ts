/**
 * Backwards-compatible entrypoint for the specification runtime routes.
 *
 * Topic routers are being extracted under `src/routes`; callers should continue
 * importing this facade while that refactor preserves the public API surface.
 */
export { registerSpecRuntimeRoutes } from './routes/runtime-core';
