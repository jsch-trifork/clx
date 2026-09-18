export function compatibility(record, catalog) {
  const missing = [];
  for (const [id, selection] of Object.entries(record.skillPlugins || {})) {
    if (selection.mode === "off") continue;
    const family = catalog.families.find((f) => f.id === id);
    if (!family) {
      missing.push(`Plugin: ${id}`);
      continue;
    }
    for (const key of selection.mode === "full"
      ? family.skills.map((s) => s.key)
      : selection.skills || []) {
      if (!family.skills.some((s) => s.key === key && s.available))
        missing.push(`Skill: ${id}/${key}`);
    }
  }
  for (const id of record.otherPlugins || [])
    if (!catalog.otherPlugins.some((p) => p.id === id))
      missing.push(`Plugin: ${id}`);
  for (const id of record.mcp || [])
    if (!catalog.mcpNames.includes(id)) missing.push(`Integration: ${id}`);
  return missing;
}

export function preserveUnavailable(record, previous, catalog) {
  for (const [id, selection] of Object.entries(previous.skillPlugins || {})) {
    const family = catalog.families.find((f) => f.id === id);
    if (!family) {
      record.skillPlugins[id] = selection;
      continue;
    }
    if (selection.mode === "subset") {
      const absent = (selection.skills || []).filter(
        (key) => !family.skills.some((s) => s.key === key && s.available),
      );
      if (absent.length && record.skillPlugins[id]?.mode !== "full")
        record.skillPlugins[id] = {
          mode: "subset",
          skills: [
            ...new Set([...(record.skillPlugins[id]?.skills || []), ...absent]),
          ],
        };
    }
  }
  record.mcp = [
    ...new Set([
      ...(record.mcp || []),
      ...(previous.mcp || []).filter((id) => !catalog.mcpNames.includes(id)),
    ]),
  ];
  record.otherPlugins = [
    ...new Set([
      ...(record.otherPlugins || []),
      ...(previous.otherPlugins || []).filter(
        (id) => !catalog.otherPlugins.some((p) => p.id === id),
      ),
    ]),
  ];
  return record;
}
