// What the bridge does at its transport's edges: listening when the port is held, joining
// something on the port that is not an mcp-teams hub, and freeing the port on close. Written
// before the transport seam (#123 PR 1) to show the WebSocket transport behind it keeps these.
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ExtensionBridge } from "../../src/bridge.js";
import { FAST } from "../helpers/bridgeHarness.js";
import { until } from "../helpers/timing.js";

const bridges: ExtensionBridge[] = [];
const servers: { close(cb: () => void): void }[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

function bridge(port: number): ExtensionBridge {
  const b = new ExtensionBridge(port, "secret", "0.1.0", FAST);
  bridges.push(b);
  return b;
}

/** A program on a free port that drops every connection at once (not a WebSocket server). */
async function rawHolder(): Promise<{ server: Server; port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as { port: number }).port, sockets };
}

describe("the bridge's transport edges", () => {
  it("names a program on the port that isn't mcp-teams, and becomes the hub on that port once it is gone", async () => {
    const { server, port } = await rawHolder();
    const b = bridge(port);
    await b.start();
    expect(b.role).toBe("none");
    expect(b.listenError).toBe(
      `Port ${port} is held by an mcp-teams of 0.2.0 or older (restart the other AI sessions, in Claude Code with /mcp) or by another program.`,
    );
    await new Promise<void>((r) => server.close(() => r()));
    await until(() => b.role === "hub", 5_000, "the bridge to take the freed port");
    expect(b.port).toBe(port);
    expect(b.listenError).toBeUndefined();
  });

  it("names a WebSocket program that challenges and then closes as another program on the port", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(wss);
    await new Promise((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "challenge", nonce: "n" }));
      ws.once("message", () => ws.close(1000));
    });
    const b = bridge(port);
    await b.start();
    expect(b.role).toBe("none");
    expect(b.listenError).toBe(`Port ${port} is in use by another program.`);
  });

  it("frees its port on close, so the next server becomes the hub there at once", async () => {
    const first = bridge(0);
    await first.start();
    expect(first.role).toBe("hub");
    const port = first.port;
    await first.close();
    const next = bridge(port);
    await next.start();
    expect(next.role).toBe("hub");
    expect(next.port).toBe(port);
  });

  it("a peer joins the hub on its port, and takes the port when the hub closes", async () => {
    const hub = bridge(0);
    await hub.start();
    const peer = bridge(hub.port);
    await peer.start();
    expect(peer.role).toBe("peer");
    expect(peer.hubVersion).toBe("0.1.0");
    await hub.close();
    await until(() => peer.role === "hub", 5_000, "the peer to take over the port");
    expect(peer.port).toBe(hub.port);
  });
});
