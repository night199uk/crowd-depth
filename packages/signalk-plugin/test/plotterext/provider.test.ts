import { beforeEach, expect, test, vi } from "vitest";
import type { ServerAPI } from "@signalk/server-api";

interface ProviderLike {
  type: string;
  methods: {
    listResources(): Promise<Record<string, unknown>>;
    getResource(id: string): Promise<unknown>;
    setResource(): Promise<unknown>;
    deleteResource(): Promise<unknown>;
  };
}

function fakeApp() {
  const providers: ProviderLike[] = [];
  const mounts: string[] = [];
  const app = {
    registerResourceProvider: (p: unknown) => providers.push(p as ProviderLike),
    use: (path: string) => mounts.push(path),
    debug: () => {},
  } as unknown as ServerAPI;
  return { app, providers, mounts };
}

beforeEach(() => vi.resetModules());

test("registers the provider on every start and mounts the assets once", async () => {
  const { registerPlotterExtension } =
    await import("../../src/plotterext/provider.js");
  const { ASSET_BASE, PLUGIN_ID } =
    await import("../../src/plotterext/manifest.js");
  const { app, providers, mounts } = fakeApp();
  let running = true;

  registerPlotterExtension(app, () => running);
  // A restart: the server dropped the provider on stop, so it registers again.
  registerPlotterExtension(app, () => running);

  expect(providers).toHaveLength(2);
  expect(mounts.filter((p) => p === ASSET_BASE)).toHaveLength(1);

  const provider = providers[0];
  expect(provider.type).toBe("plotterExtensions");
  expect(await provider.methods.listResources()).toHaveProperty(PLUGIN_ID);
  expect(await provider.methods.getResource(PLUGIN_ID)).toMatchObject({
    apiVersion: "1",
  });

  await expect(provider.methods.setResource()).rejects.toThrow(/read-only/);
  await expect(provider.methods.deleteResource()).rejects.toThrow(/read-only/);

  // While the plugin is stopped the extension leaves the collection.
  running = false;
  expect(await provider.methods.listResources()).toEqual({});
  await expect(provider.methods.getResource(PLUGIN_ID)).rejects.toThrow();
});

test("serves the built pages without Express and passes other paths on", async () => {
  const { registerPlotterExtension } =
    await import("../../src/plotterext/provider.js");
  const handlers: ((
    req: { path: string },
    res: unknown,
    next: () => void,
  ) => void)[] = [];
  const app = {
    debug: () => {},
    registerResourceProvider: () => {},
    use: (_path: string, handler: (typeof handlers)[number]) =>
      handlers.push(handler),
  };
  registerPlotterExtension(app as never, () => true);
  const serve = handlers[0];

  const request = (path: string) => {
    const sent: string[] = [];
    let passed = false;
    const res = {
      type: () => res,
      sendFile: (file: string) => sent.push(file),
    };
    serve({ path }, res, () => (passed = true));
    return { sent, passed };
  };

  // The pages exist once `scripts/build-web.mjs` has run, as it does in CI.
  expect(request("/renderer.html").sent[0]).toMatch(
    /public[\\/]renderer\.html$/,
  );
  expect(request("/js/render-worker.js").sent[0]).toMatch(/render-worker\.js$/);
  expect(request("/../package.json").passed).toBe(true);
  expect(request("/bathymetry/meta").passed).toBe(true);
});
