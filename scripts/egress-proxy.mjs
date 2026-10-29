// Egress proxy for docker workspaces. The Claude container sits on an internal
// Docker network with no route out; this proxy is the only thing it can reach.
// It forwards HTTPS (CONNECT to port 443) to the allowed domains and nothing else:
// no plain HTTP, no IP addresses, no names that resolve to private or host
// addresses, and the TLS server name must match the domain asked for.
//   CLX_ALLOW="api.anthropic.com,*.npmjs.org" node egress-proxy.mjs [port]
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { pathToFileURL } from "node:url";

// `*.example.com` covers subdomains only, not example.com itself.
export function allowed(host, patterns) {
  host = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((p) =>
    p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p,
  );
}

const PRIVATE = new net.BlockList();
for (const [addr, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
])
  PRIVATE.addSubnet(addr, bits, "ipv4");
for (const [addr, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
])
  PRIVATE.addSubnet(addr, bits, "ipv6");

// Private, loopback, link-local and Docker's host addresses (192.168.65.x) are never
// reachable, so a domain pointed at them (DNS rebinding) can't reach the Mac.
export function isPrivate(address) {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (v4) return PRIVATE.check(v4, "ipv4");
  return PRIVATE.check(address, net.isIPv6(address) ? "ipv6" : "ipv4");
}

// The server name from a TLS ClientHello, or null if it isn't one / has none.
export function serverName(buf) {
  try {
    if (buf[0] !== 0x16 || buf[5] !== 0x01) return null;
    let i = 5 + 4 + 2 + 32; // handshake header, version, random
    i += 1 + buf[i]; // session id
    i += 2 + buf.readUInt16BE(i); // cipher suites
    i += 1 + buf[i]; // compression methods
    const end = i + 2 + buf.readUInt16BE(i);
    i += 2;
    while (i + 4 <= end) {
      const type = buf.readUInt16BE(i);
      const len = buf.readUInt16BE(i + 2);
      i += 4;
      if (type === 0) {
        // server_name list: total length, then type 0 (host_name), length, name
        if (buf[i + 2] !== 0) return null;
        const nameLen = buf.readUInt16BE(i + 3);
        return buf.toString("ascii", i + 5, i + 5 + nameLen).toLowerCase();
      }
      i += len;
    }
  } catch {}
  return null;
}

// Read until a whole TLS record is in, so the ClientHello can be checked.
function firstRecord(sock, head) {
  return new Promise((done) => {
    let buf = head ?? Buffer.alloc(0);
    const timer = setTimeout(() => finish(null), 10_000);
    const finish = (value) => {
      clearTimeout(timer);
      sock.off("data", onData);
      // Hold later bytes until pipe() takes over, or they'd be dropped.
      sock.pause();
      done(value);
    };
    const check = () => {
      if (buf.length >= 5 && buf.length >= 5 + buf.readUInt16BE(3))
        finish(buf);
      else if (buf.length > 65_536) finish(null);
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      check();
    };
    sock.on("data", onData);
    sock.once("close", () => finish(null));
    check();
  });
}

export function startProxy(patterns, port = 3128, log = console.error) {
  const deny = (sock, host, why) => {
    log(`clx-egress: blocked ${host} (${why})`);
    sock.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  };
  const server = http.createServer((req, res) => {
    log(`clx-egress: blocked ${req.headers.host ?? "?"} (plain HTTP)`);
    res.writeHead(403).end();
  });
  server.on("connect", async (req, sock, head) => {
    sock.on("error", () => {});
    const m = /^([^:\s/]+):(\d+)$/.exec(req.url ?? "");
    if (!m) return deny(sock, req.url, "bad target");
    const host = m[1].toLowerCase();
    if (m[2] !== "443") return deny(sock, `${host}:${m[2]}`, "only port 443");
    if (net.isIP(host)) return deny(sock, host, "IP address");
    if (!allowed(host, patterns)) return deny(sock, host, "not in the list");
    let address;
    try {
      ({ address } = await dns.lookup(host));
    } catch {
      return deny(sock, host, "no such host");
    }
    if (isPrivate(address)) return deny(sock, host, `private ${address}`);
    sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const hello = await firstRecord(sock, head);
    const sni = hello && serverName(hello);
    if (sni !== host) {
      log(`clx-egress: blocked ${host} (TLS name ${sni ?? "missing"})`);
      return sock.destroy();
    }
    const upstream = net.connect(443, address, () => {
      upstream.write(hello);
      sock.pipe(upstream).pipe(sock);
    });
    upstream.on("error", () => sock.destroy());
    sock.on("close", () => upstream.destroy());
  });
  server.listen(port, "0.0.0.0");
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const patterns = (process.env.CLX_ALLOW ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  startProxy(patterns, Number(process.argv[2] ?? 3128));
  console.error(`clx-egress: allowing ${patterns.join(", ") || "nothing"}`);
}
