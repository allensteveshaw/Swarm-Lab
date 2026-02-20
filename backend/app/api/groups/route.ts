export const runtime = "nodejs";

import { store } from "@/lib/storage";

function isUuid(value: string | null | undefined): value is string {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim()
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
  const agentId = url.searchParams.get("agentId") ?? undefined;

  const groups = await store.listGroups({ workspaceId, agentId });
  return Response.json({ groups });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    workspaceId: string;
    memberIds: string[];
    name?: string;
  };
  const memberIds = [...new Set((body.memberIds ?? []).map((id) => id?.trim()).filter((id) => isUuid(id)))];
  if (memberIds.length < 2) {
    return Response.json({ error: "memberIds must contain at least 2 valid UUIDs" }, { status: 400 });
  }

  if (memberIds.length === 2) {
    const groupId =
      (await store.mergeDuplicateExactP2PGroups({
        workspaceId: body.workspaceId,
        memberA: memberIds[0]!,
        memberB: memberIds[1]!,
        preferredName: body.name ?? null,
      })) ??
      (
        await store.createGroup({
          workspaceId: body.workspaceId,
          memberIds,
          name: body.name ?? undefined,
        })
      ).id;

    return Response.json({ id: groupId, name: body.name ?? null }, { status: 201 });
  }

  const group = await store.createGroup({ workspaceId: body.workspaceId, memberIds, name: body.name });
  return Response.json(group, { status: 201 });
}
