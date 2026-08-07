export const habitLogKey = (id: unknown) => `habit:${String(id)}`;

export function parseLogKey(key: string): { kind: "habit"; id: string } | null {
  const match = /^habit:(.+)$/.exec(key);
  return match ? { kind: "habit", id: match[1] } : null;
}
