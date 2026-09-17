import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";

export async function readCatalog(file) {
  let catalog;
  try {
    catalog = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "No CLX catalog found. Run clx init to discover your installed plugins.",
      );
    throw new Error("Cannot read the CLX catalog: " + error.message);
  }
  if (!Array.isArray(catalog.skillPlugins) || !Array.isArray(catalog.models))
    throw new Error(
      "Invalid CLX catalog. Regenerate it with clx init --force.",
    );
  const warnings = [];
  const families = await Promise.all(
    catalog.skillPlugins.map(async (plugin) => ({
      id: plugin.id,
      name: plugin.name,
      skills: await Promise.all(
        (plugin.skills || []).map(async (entry) => {
          const key = basename(entry.dir);
          let description =
              entry.label?.split(" — ").slice(1).join(" — ") || "",
            available = false;
          try {
            const file = join(entry.dir, "SKILL.md");
            if ((await stat(file)).size > 1024 * 1024)
              throw new Error("Skill metadata exceeds 1 MB");
            const text = await readFile(file, "utf8");
            const frontmatter = text.match(
              /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
            );
            if (frontmatter) {
              const metadata = parse(frontmatter[1], { maxAliasCount: 10 });
              if (typeof metadata?.description === "string")
                description = metadata.description;
            }
            available = true;
          } catch {
            warnings.push(
              `Cannot read ${plugin.name}/${key}. Refresh the catalog if this plugin was updated.`,
            );
          }
          return {
            id: `${plugin.id}/${key}`,
            key,
            name: key,
            description,
            available,
            familyId: plugin.id,
          };
        }),
      ),
    })),
  );
  return {
    families,
    models: catalog.models.map(({ id, label }) => ({ id, label })),
    otherPlugins: (catalog.otherPlugins || []).map(({ id, name }) => ({
      id,
      name,
    })),
    mcpNames: Object.keys(catalog.mcpServers || {}),
    warnings,
  };
}
