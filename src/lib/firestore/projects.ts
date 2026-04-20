export type ProjectDoc = {
  id: string;
  name: string;
  leadUid: string;
  memberUids: string[];
  archived: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

export function normalizeProject(id: string, data: Raw): ProjectDoc {
  return {
    id,
    name: (data.name as string) ?? "Untitled",
    leadUid: (data.leadUid as string) ?? "",
    memberUids: (data.memberUids as string[]) ?? [],
    archived: Boolean(data.archived),
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
}
