# Excalibur Agent Hub — Local network access

The server binds to loopback by default. LAN mode is optional and takes effect after a restart; it is not an Internet hosting or account system. Paired devices receive full operator access, including all projects. HTTP traffic is not encrypted: use a trusted private network only, never shared hotel/café Wi-Fi. This change does not enable LAN mode or change any running installation.

When LAN mode starts, a cryptographically random six-digit invitation is generated. Open Settings from an authenticated browser at `localhost` or `127.0.0.1` on the server computer to see the code and QR. The code expires after ten minutes. Reopening Settings after expiry generates a fresh code; a server restart also invalidates the previous invitation. Existing paired browser sessions use the existing Hub cookie/token model and are not revoked by invitation expiry. Restarting alone does not revoke those sessions; revocation of the persistent Hub token remains an operator action outside this change.

A new phone sees a pairing screen, with no conversation history or automatic session cookie. Enter the code or scan the QR. The QR carries the code in a URL **fragment**, which is removed immediately by the pairing page and sent only in a same-origin POST body. Query parameters never pair a device. An already paired remote browser cannot read or generate invitations from `/api/config`.

The localhost exemption requires both an actual loopback socket and a loopback Host destination. Proxy headers and test headers never establish local access. This also prevents a loopback request using a LAN Host header from minting a cookie. Valid agent API tokens continue to work normally. Host allow-list checks remain in place.

Pairing requests require LAN mode and an exact matching Origin, and accept at most 256 bytes. A fixed one-minute attempt window allows five attempts per peer and twenty across the server, counting successful attempts too; both limits reset after that window. Throttling state is bounded by the global limit. A valid pairing response sets the existing HttpOnly, SameSite=Strict cookie. The model trusts the person who can see the host computer's Settings or invitation; it does not implement separate remote user roles.

The UI verifies the configured operator before enabling sends, uploads or other browser writes. A missing, failed or malformed `/api/config` response clears the client identity, blocks writes and shows a localized retry warning instead of guessing a name. A successful retry uses the returned operator and preserves the draft.

Settings explains that a pairing code requires saving LAN access and restarting the server. Toggling the switch alone never advertises a code or QR. Hidden LAN containers have explicit CSS visibility rules so flex layout cannot reveal inactive addresses or blank codes. After saving, the pending restart instruction remains visible; only a running LAN server with a host-local invitation displays pairing details.

The advertised IPv4 addresses omit common VPN, tunnel and peer-to-peer interface names (including macOS utun and awdl); the list is intended for the same Wi-Fi or Ethernet network as the phone. No tunnel/network configuration is changed. Local IP addresses are read at startup. Restart after changing networks. Newly installed instances default to the neutral operator name `Operator`. Existing installations without an explicit operator setting retain the first active human already registered in their database. An explicit `HUB_HUMAN` or `config.json` operator takes precedence. No running data or settings are migrated by this patch.

## Verification

Run `node --test test/*.test.mjs`. The pairing probes use disposable synthetic databases and real sockets to an active LAN interface, including a remote socket with a forged localhost Host header. They cover anonymous reads/writes/SSE/files, query-code rejection, wrong and correct codes, cross-origin rejection, expired codes, rate limits, and authenticated use. No live Hub settings are changed.

The mobile browser probe uses Chrome/Chromium at 320 pixels, checks five languages and Arabic direction, pairs by manual form and QR fragment, verifies HttpOnly storage, and asserts that pairing secrets never appear in request query parameters. Set `CHROME_BIN` if needed; missing browser coverage is an explicit skip. An active LAN interface is required for real-socket coverage.

The Settings layout and initial pairing page were continued from Nezle02's uncommitted work at takeover; its committed history through `874b78f` is preserved under `0318f8d`. The source worktree was not modified.
