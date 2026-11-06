# mcp-teams

Lets AI sessions read and post in Microsoft Teams (web) through a browser extension, which every session reaches through one shared hub.

## Language

### The bridge

**Session**:
One AI client's connection to its own mcp-teams server (one Claude Code window, one Claude Desktop app).
_Avoid_: window, client, instance

**Hub**:
The one process the browser extension talks to; every session's calls reach Teams through it.
_Avoid_: bridge server, master

**Peer**:
A session's server that is not the hub and forwards its calls through the hub.
_Avoid_: client, follower

**Native host**:
A hub the browser itself starts for the extension (native messaging), so no session owns it.
_Avoid_: daemon, background hub

**TCP hub**:
A hub held by one session's server on the local port; the fallback when no native host can run.
_Avoid_: in-session hub, legacy hub

**Serving host**:
The native host that is the hub; there is at most one.
_Avoid_: primary host, main host

**Relaying host**:
A native host started for a second browser (or a reconnect) that passes its extension's messages to the serving host.
_Avoid_: secondary host, proxy

**Launcher**:
What the AI apps and the browser start instead of a fixed copy of mcp-teams; it runs the version the store names as current.
_Avoid_: wrapper, bootstrapper

**Store**:
The folder of installed mcp-teams versions side by side, one of which is current.
_Avoid_: cache, install dir

**Handover**:
One hub giving its place to a newer one without failing the calls it has in flight.
_Avoid_: takeover, failover, step-down
