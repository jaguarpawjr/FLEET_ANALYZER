export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted && character === '"' && input[index + 1] === '"') {
      cell += '"';
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index++;
      row.push(cell);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

export function stringifyCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const quote = (value: unknown): string => {
    const text = value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  return [
    columns.map(quote).join(","),
    ...rows.map((row) => columns.map((column) => quote(row[column])).join(","))
  ].join("\n") + "\n";
}

export function recordsFromCsv(input: string, requiredColumns: string[], dataset: string): {
  columns: string[];
  records: Record<string, string>[];
} {
  const [header, ...rows] = parseCsv(input);
  if (!header) throw new Error(`${dataset} is empty; expected columns: ${requiredColumns.join(", ")}`);
  const columns = header.map((column) => column.trim().replace(/^\uFEFF/, ""));
  const missing = requiredColumns.filter((column) => !columns.includes(column));
  if (missing.length > 0) {
    throw new Error(`${dataset} is missing required columns: ${missing.join(", ")}`);
  }
  if (new Set(columns).size !== columns.length) {
    throw new Error(`${dataset} contains duplicate column names`);
  }

  return {
    columns,
    records: rows.map((cells, index) => {
      if (cells.length !== columns.length) {
        throw new Error(
          `${dataset} data record ${index + 1} has ${cells.length} fields; expected ${columns.length}`
        );
      }
      return Object.fromEntries(columns.map((column, cellIndex) => [column, cells[cellIndex]]));
    })
  };
}
