import {
  readFile,
  mkdir,
  open,
  rename,
  unlink,
  readdir,
} from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const own = (obj, key) => Object.hasOwn(obj, key);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const editable = ["model", "effort", "skillPlugins", "otherPlugins", "mcp"];

export async function readPresets(file) {
  let bytes;
  try {
    bytes = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    bytes = "{}";
  }
  let records;
  try {
    records = JSON.parse(bytes);
  } catch {
    throw new StoreError(
      "presets.json contains invalid JSON. Fix it before saving; the original file has not been changed.",
      422,
    );
  }
  if (!object(records) || Object.values(records).some((p) => !object(p)))
    throw new StoreError(
      "presets.json must contain named preset objects.",
      422,
    );
  return { records, revision: hash(bytes), bytes };
}
export function publicPresets(records) {
  return Object.entries(records).map(([name, p]) => ({
    name,
    record: Object.fromEntries(
      editable.filter((k) => own(p, k)).map((k) => [k, p[k]]),
    ),
    hasPrompt: Boolean(p.prompt),
  }));
}
function validateName(name) {
  if (
    typeof name !== "string" ||
    name !== name.trim() ||
    !name ||
    name.length > 120 ||
    /[\x00-\x1f\x7f]/.test(name) ||
    ["__proto__", "prototype", "constructor"].includes(name) ||
    /^(ui|init|prompts)$/i.test(name) ||
    name.startsWith("-")
  )
    throw new StoreError(
      "Use a preset name of 1–120 characters without control characters.",
    );
}
function validateRecord(record, previous, catalog) {
  if (!object(record) || Object.keys(record).some((k) => !editable.includes(k)))
    throw new StoreError("Unexpected preset fields.");
  if (
    typeof record.model !== "string" ||
    !record.model ||
    record.model.length > 200 ||
    (!catalog.models.some((m) => m.id === record.model) &&
      record.model !== previous?.model)
  )
    throw new StoreError("Choose a model from your CLX catalog.");
  if (
    record.effort !== undefined &&
    !["", "low", "medium", "high", "xhigh", "max"].includes(record.effort) &&
    record.effort !== previous?.effort
  )
    throw new StoreError("Invalid reasoning effort.");
  if (!object(record.skillPlugins))
    throw new StoreError("Skill selections must be an object.");
  for (const [id, selection] of Object.entries(record.skillPlugins)) {
    const family = catalog.families.find((f) => f.id === id);
    if (!family && same(selection, previous?.skillPlugins?.[id])) continue;
    if (
      !family ||
      !object(selection) ||
      !["off", "full", "subset"].includes(selection.mode)
    )
      throw new StoreError("Unknown family or invalid selection mode: " + id);
    if (Object.keys(selection).some((k) => !["mode", "skills"].includes(k)))
      throw new StoreError("Unexpected family selection fields.");
    if (selection.mode === "subset") {
      if (
        !Array.isArray(selection.skills) ||
        selection.skills.length > 10000 ||
        new Set(selection.skills).size !== selection.skills.length
      )
        throw new StoreError("Invalid skill list.");
      for (const key of selection.skills)
        if (
          typeof key !== "string" ||
          (!family.skills.some((s) => s.key === key) &&
            !previous?.skillPlugins?.[id]?.skills?.includes(key))
        )
          throw new StoreError("Unknown skill: " + key);
    }
  }
  for (const [field, available] of [
    ["mcp", catalog.mcpNames],
    ["otherPlugins", catalog.otherPlugins.map((p) => p.id)],
  ]) {
    if (
      !Array.isArray(record[field]) ||
      new Set(record[field]).size !== record[field].length ||
      record[field].some(
        (v) =>
          typeof v !== "string" ||
          (!available.includes(v) && !previous?.[field]?.includes(v)),
      )
    )
      throw new StoreError("Invalid " + field + " selection.");
  }
}

export async function mutatePresets(file, request, catalog) {
  if (
    !object(request) ||
    !["create", "update", "delete"].includes(request.operation)
  )
    throw new StoreError("Invalid preset operation.");
  validateName(request.name);
  await mkdir(dirname(file), { recursive: true });
  const lockPath = file + ".ui.lock";
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new StoreError(
        "Another save is in progress. Try again shortly.",
        409,
      );
    throw error;
  }
  let temp;
  try {
    const snapshot = await readPresets(file);
    if (request.revision !== snapshot.revision)
      throw new StoreError(
        "Presets changed on disk. Reload before saving so another change is not overwritten.",
        409,
      );
    const records = Object.assign(Object.create(null), snapshot.records);
    let oldName =
      request.operation === "create"
        ? null
        : request.previousName || request.name;
    if (oldName !== null && !own(records, oldName))
      throw new StoreError("This preset no longer exists.", 404);
    if (request.operation !== "delete") {
      if (request.name !== oldName && own(records, request.name))
        throw new StoreError("A preset with that name already exists.", 409);
      const previous = oldName === null ? undefined : records[oldName];
      validateRecord(request.record, previous, catalog);
      // Prompt references and future extension fields belong to CLX, not this editor.
      const next = { ...previous, ...request.record };
      if (!request.record.effort) delete next.effort;
      if (oldName !== null && oldName !== request.name) delete records[oldName];
      Object.defineProperty(records, request.name, {
        value: next,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else delete records[oldName];
    const backupDir = join(dirname(file), ".preset-backups");
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const backup = await open(
      join(
        backupDir,
        basename(file) + "." + Date.now() + "." + randomUUID() + ".json",
      ),
      "wx",
      0o600,
    );
    try {
      await backup.writeFile(snapshot.bytes);
      await backup.sync();
    } finally {
      await backup.close();
    }
    temp = join(
      dirname(file),
      "." + basename(file) + "." + randomUUID() + ".tmp",
    );
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(records, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Detect terminal/editor writes that occurred while this UI save was being prepared.
    if ((await readPresets(file)).revision !== snapshot.revision)
      throw new StoreError(
        "Presets changed during saving. Reload and try again.",
        409,
      );
    await rename(temp, file);
    temp = undefined;
    // Retention failure must not report a successful save as failed.
    try {
      const files = (await readdir(backupDir))
        .filter((n) => n.startsWith(basename(file) + "."))
        .sort();
      await Promise.all(
        files.slice(0, -20).map((n) => unlink(join(backupDir, n))),
      );
    } catch {}
    return await readPresets(file);
  } finally {
    if (temp) await unlink(temp).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
