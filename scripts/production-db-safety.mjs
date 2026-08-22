export function assertSafeProductionDbArguments(args) {
  if (args[0] !== "d1" || !args.includes("tempo-production")) throw new Error("Refusing to run an unexpected database command.");
  const remoteExport = args[1] === "export" && args[2] === "tempo-production" && args.includes("--remote") && !args.includes("--local") && args.includes("--env") && args.includes("production");
  const localImport = args[1] === "execute" && args[2] === "tempo-production" && args.includes("--local") && !args.includes("--remote") && args.includes("--persist-to") && args.includes("--file");
  const commandIndex = args.indexOf("--command");
  const localValidation = args[1] === "execute" && args[2] === "tempo-production" && args.includes("--local") && !args.includes("--remote") && args.includes("--persist-to") && commandIndex >= 0 && args[commandIndex + 1] === "PRAGMA foreign_key_check;";
  if (!remoteExport && !localImport && !localValidation) throw new Error("Refusing to run a mutating or unexpected production command.");
}

export function normalizeD1Export(sql) {
  const withoutDeferredForeignKeys = sql.replace(/^\s*PRAGMA\s+defer_foreign_keys\s*=\s*TRUE;\s*/i, "");
  const lines = withoutDeferredForeignKeys.trim().split(/\r?\n/);
  const tableDefinitions = [];
  const remainingStatements = [];
  for (let index = 0; index < lines.length;) {
    if (/^CREATE TABLE\b/i.test(lines[index])) {
      const definition = [];
      do { definition.push(lines[index]); index += 1; }
      while (index < lines.length && !definition.at(-1).trimEnd().endsWith(");"));
      tableDefinitions.push(definition.join("\n"));
    } else {
      remainingStatements.push(lines[index]);
      index += 1;
    }
  }
  return `PRAGMA defer_foreign_keys=TRUE;\n${tableDefinitions.join("\n")}\n${remainingStatements.join("\n").trim()}\n`;
}
