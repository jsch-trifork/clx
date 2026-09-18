import { readCatalog } from "../src/catalog.mjs";
import { readPresets } from "../src/store.mjs";
import { compatibility } from "../src/compatibility.mjs";
const [catalog, presets, name] = process.argv.slice(2);
try {
  const record = (await readPresets(presets)).records[name];
  if (!record) throw new Error("Preset no longer exists.");
  const missing = compatibility(record, await readCatalog(catalog));
  if (missing.length) {
    console.log(missing.join("\n"));
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
