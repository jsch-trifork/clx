import { readCatalog } from "../src/catalog.mjs";
import { readPresets } from "../src/store.mjs";
import { preserveUnavailable } from "../src/compatibility.mjs";
const [catalog, presets, name, record] = process.argv.slice(2);
console.log(
  JSON.stringify(
    preserveUnavailable(
      JSON.parse(record),
      (await readPresets(presets)).records[name],
      await readCatalog(catalog),
    ),
  ),
);
