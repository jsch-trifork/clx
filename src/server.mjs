import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compatibility } from "./compatibility.mjs";
import { readCatalog } from "./catalog.mjs";
import {
  readPresets,
  publicPresets,
  mutatePresets,
  StoreError,
} from "./store.mjs";

const web = fileURLToPath(new URL("../web/", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};
export async function startServer({
  catalogFile,
  presetsFile,
  port = 0,
  onLaunch,
  onSetup,
  onProfiles,
  getCatalogFile = () => catalogFile,
}) {
  const token = randomBytes(32).toString("hex");
  let mutationBusy = false;
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const json = (code, value) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    let ownsMutation = false;
    try {
      if (
        req.headers.host !== `127.0.0.1:${server.address().port}` ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        return json(403, {
          error: "This CLX session only accepts its own local browser origin.",
        });
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith("/api/")) {
        const provided = Buffer.from(
          (req.headers.authorization || "").replace(/^Bearer /, ""),
        );
        const expected = Buffer.from(token);
        if (
          provided.length !== expected.length ||
          !timingSafeEqual(provided, expected)
        )
          return json(401, {
            error:
              "Open the authenticated URL printed by clx ui in your terminal.",
          });
        if (req.method === "GET" && url.pathname === "/api/profiles") {
          if (!onProfiles) return json(200, { profiles: [], activeId: null });
          return json(200, await onProfiles());
        }
        if (req.method === "GET" && url.pathname === "/api/setup") {
          if (!onSetup)
            throw new StoreError(
              "Folder setup is unavailable in this server.",
              503,
            );
          return json(200, await onSetup());
        }
        if (req.method === "GET" && url.pathname === "/api/state") {
          const catalog = await readCatalog(getCatalogFile()),
            snapshot = await readPresets(presetsFile);
          return json(200, {
            ...catalog,
            presets: publicPresets(snapshot.records),
            revision: snapshot.revision,
            profile: onProfiles ? await onProfiles() : null,
          });
        }
        if (
          req.method === "POST" &&
          [
            "/api/presets",
            "/api/launch",
            "/api/setup",
            "/api/profiles",
          ].includes(url.pathname)
        ) {
          if (req.headers["content-type"]?.split(";")[0] !== "application/json")
            return json(415, { error: "Expected JSON." });
          const chunks = [];
          let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > 1024 * 1024)
              throw new StoreError("Preset request is too large.", 413);
            chunks.push(chunk);
          }
          let request;
          try {
            request = JSON.parse(Buffer.concat(chunks));
          } catch {
            throw new StoreError("Invalid JSON.");
          }
          if (mutationBusy)
            throw new StoreError(
              "Another change is in progress. Try again shortly.",
              409,
            );
          mutationBusy = true;
          ownsMutation = true;
          if (url.pathname === "/api/profiles") {
            if (!onProfiles)
              throw new StoreError("Profiles are unavailable.", 503);
            return json(200, await onProfiles(request));
          }
          if (
            onProfiles &&
            ["/api/presets", "/api/launch"].includes(url.pathname) &&
            request.profileId !== (await onProfiles()).activeId
          )
            throw new StoreError(
              "The active profile changed. Reload before continuing.",
              409,
            );
          if (url.pathname === "/api/setup") {
            if (!onSetup)
              throw new StoreError(
                "Folder setup is unavailable in this server.",
                503,
              );
            if (
              typeof request?.directory !== "string" ||
              !request.directory.trim()
            )
              throw new StoreError("Enter a Claude configuration folder.");
            return json(200, await onSetup(request));
          }
          if (url.pathname === "/api/launch") {
            const { records } = await readPresets(presetsFile);
            if (
              typeof request?.name !== "string" ||
              !Object.hasOwn(records, request.name)
            )
              throw new StoreError("Choose a saved preset.", 404);
            if (
              /^(ui|init|prompts)$/i.test(request.name) ||
              request.name.startsWith("-")
            )
              throw new StoreError(
                "Rename this preset before launching: its name is reserved by the command.",
              );
            if (!onLaunch)
              throw new StoreError(
                "Launch is not available in this server.",
                503,
              );
            const missing = compatibility(
              records[request.name],
              await readCatalog(getCatalogFile()),
            );
            if (missing.length && request.allowMissing !== true)
              return json(409, {
                error:
                  "This preset has unavailable selections in the current profile.",
                missing,
              });
            await onLaunch(request.name, request);
            return json(200, { launched: true });
          }
          const snapshot = await mutatePresets(
            presetsFile,
            request,
            await readCatalog(getCatalogFile()),
          );
          return json(200, {
            presets: publicPresets(snapshot.records),
            revision: snapshot.revision,
          });
        }
        return json(404, { error: "Unknown CLX endpoint." });
      }
      if (!["GET", "HEAD"].includes(req.method))
        return json(405, { error: "Method not allowed." });
      const file = resolve(
        web,
        "." +
          (url.pathname === "/"
            ? "/index.html"
            : decodeURIComponent(url.pathname)),
      );
      if (!file.startsWith(resolve(web) + sep) || !types[extname(file)])
        return json(404, { error: "Not found." });
      let bytes;
      try {
        bytes = await readFile(file);
      } catch {
        return json(404, { error: "Not found." });
      }
      res.writeHead(200, { "Content-Type": types[extname(file)] });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      json(error.status || 500, {
        error: error.message || "CLX could not complete the operation.",
      });
    } finally {
      if (ownsMutation) mutationBusy = false;
    }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/#${token}` };
}
