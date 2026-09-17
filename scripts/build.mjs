import { cp, mkdir } from "node:fs/promises";
await mkdir("web/vendor", { recursive: true });
await cp("node_modules/lucide/dist/umd/lucide.min.js", "web/vendor/lucide.js");
for (const font of ["inter", "cormorant-garamond"]) {
  await cp(
    `node_modules/@fontsource/${font}/files/${font}-latin-400-normal.woff2`,
    `web/vendor/${font}.woff2`,
  );
  await cp(
    `node_modules/@fontsource/${font}/LICENSE`,
    `web/vendor/${font}-LICENSE.txt`,
  );
}
await cp("node_modules/lucide/LICENSE", "web/vendor/lucide-LICENSE.txt");
console.log("CLX browser assets ready.");
