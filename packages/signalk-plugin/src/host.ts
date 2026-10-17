import { ServerAPI } from "@signalk/server-api";

/**
 * The base URL this server is reachable at, for the plugin's own calls to the
 * server's HTTP APIs (history, tides). `SIGNALK_HOST` overrides it for setups
 * that reach the server on a different address than it binds to.
 */
export function serverHost(app: ServerAPI): string {
  // @ts-expect-error: app.config is not a public API
  const port = Number(process.env.PORT) || app.config?.settings?.port || 3000;
  return process.env.SIGNALK_HOST ?? `http://localhost:${port}/`;
}
