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

**Server log**:
Every server's persistent diagnostic log (`~/.mcp-teams/server.log`): metadata about its role, the extension and Teams state, failed calls and crashes, never message content. Not the native host's `hub.log`.
_Avoid_: debug log, trace

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

**Bad version**:
An installed version the launcher sets aside because it failed to start, or because it was rolled back from.
_Avoid_: broken version, blacklisted version

**Stale server**:
A running server whose entry would now start a different version or build than the one it runs.
_Avoid_: old server, outdated server

**Handover**:
One hub giving its place to a newer one without failing the calls it has in flight.
_Avoid_: takeover, failover, step-down

### The extension

**Extension version line**:
The extension's own versions (1.0.0 on, tagged `ext-vX.Y.Z`), which move only when the extension changes; the server never compares them with its own (ADR 0003).
_Avoid_: matching versions, versionsMatch

**Extension feature**:
A protocol behaviour the extension declares in its hello (`cancelSend`, `sizeCheck`) and the server checks before relying on it; an extension that declares none is taken to have those its version had.
_Avoid_: capability flag, minimum version

**Sideloaded copy**:
The extension loaded unpacked from a folder: a clone's `extension/`, or the copy setup installs and the server keeps in sync. Its manifest is the repo's, with the `key` that fixes its id and the hosts `api_traffic` listens on.
_Avoid_: developer build, unpacked build

**Web store copy**:
The extension installed from the Chrome Web Store or Edge Add-ons, which updates from there, not from the folder mcp-teams keeps. Its manifest is the one `scripts/package-extension.mjs` writes: no `key`, and only the five Teams and SharePoint hosts, so `api_traffic` isn't available in it.
_Avoid_: store copy (the **Store** is the launcher's folder of versions)

**Profile**:
The value a copy of the extension names its browser profile by: a hash of the Teams user it has seen there, keyed with the pairing token, so both copies in one browser profile name the same one. It stands for the browser profile only as far as its Teams account goes; it isn't the browser's own profile id. Not the per-copy `instance`, which differs between two copies in one browser profile.
_Avoid_: profile id, account hash

### Teams accounts

**Unsure account**:
The state of the signed-in account when it isn't certain which account Teams shows: the previous account showed again within 30 s of a switch (its request ignored, or switching back). It lasts until that switch's 30 s are over; meanwhile sends are refused and reads go on, with a note.
_Avoid_: ambiguous account, account conflict
