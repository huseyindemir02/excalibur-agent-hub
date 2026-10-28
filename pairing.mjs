import { randomInt, timingSafeEqual } from 'node:crypto';

// Both the connection and its destination must be loopback. Host and proxy
// headers alone never establish that the browser is on this machine.
export function isLocalBrowser(req, port) {
  const ip = req.socket?.remoteAddress;
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return loopback && [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(req.headers.host);
}

export function pairingGuard(clock = Date.now) {
  const ttl = 10 * 60_000;
  let invitation = null;
  let windowStart = clock();
  let attempts = 0;
  const peers = new Map();
  return {
    // Only the authenticated loopback settings endpoint calls this. Expired
    // codes stay invalid until the operator opens Settings again.
    current() {
      if (!invitation || clock() >= invitation.expiresAt) {
        invitation = { code: String(randomInt(100000, 1000000)), expiresAt: clock() + ttl };
      }
      return { ...invitation };
    },
    verify(ip, code) {
      const now = clock();
      if (now - windowStart >= 60_000) { windowStart = now; attempts = 0; peers.clear(); }
      // A global limit also bounds memory and distributed guessing on a LAN.
      const count = peers.get(ip) || 0;
      if (attempts >= 20 || count >= 5) return 429;
      attempts++;
      peers.set(ip, count + 1);
      const given = Buffer.from(typeof code === 'string' ? code : '');
      const want = Buffer.from(invitation?.code || '');
      if (!invitation || now >= invitation.expiresAt || given.length !== 6 || given.length !== want.length || !timingSafeEqual(given, want)) return 401;
      return 200;
    },
  };
}
