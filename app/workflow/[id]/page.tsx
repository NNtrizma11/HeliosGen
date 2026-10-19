"use client";
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useWorkflowStore, type Space } from "@/lib/store";
import { createClient } from "@/lib/supabase/client";
import { useSpaceSync } from "@/lib/useSpaceSync";
import { QuickAssist } from "@/components/QuickAssist";

const WorkflowCanvas = dynamic(() => import("@/components/WorkflowCanvas"), {
  ssr: false,
});

export default function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const switchSpace = useWorkflowStore((s) => s.switchSpace);

  useSpaceSync();

  const upsertSpace = useWorkflowStore((s) => s.upsertSpace);
  const owner = useWorkflowStore((s) => s.spaces.find((sp) => sp.id === id)?.ownerEmail);

  // Open the canvas. If it isn't in this browser yet (another device, or a teammate's
  // link), load it from the server instead of sending the user home.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Wait until the locally saved canvases are restored, or they'd overwrite what we load.
      const p = useWorkflowStore.persist;
      if (p && !p.hasHydrated()) await new Promise<void>((r) => { const off = p.onFinishHydration(() => { off(); r(); }); });
      if (cancelled) return;
      const local = useWorkflowStore.getState().spaces.find((sp) => sp.id === id);
      if (local) switchSpace(id);
      if (local && !local.ownerId) return; // own canvas, already here

      const { data } = await createClient().auth.getSession();
      const token = data.session?.access_token;
      if (cancelled) return;
      if (!token) { if (!local) router.replace("/"); return; }

      const res = await fetch(`/api/team/space/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (cancelled) return;
      if (!res.ok) { if (!local) router.replace("/"); return; }
      const j = (await res.json()) as { space: Space; mine: boolean; ownerId: string; ownerEmail: string };
      if (j.mine && useWorkflowStore.getState().spaces.some((sp) => sp.id === id)) { switchSpace(id); return; }
      upsertSpace(j.mine ? j.space : { ...j.space, ownerId: j.ownerId, ownerEmail: j.ownerEmail, loadedAt: j.space.updatedAt ?? j.space.createdAt });
      switchSpace(id);
    })();
    return () => { cancelled = true; };
  }, [id, switchSpace, upsertSpace, router]);

  return (
    <div className="flex-1 flex overflow-hidden min-h-0">
      {owner && (
        <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-50 rounded-full bg-sky-500/15 border border-sky-400/30 px-3 py-1 text-[11px] text-sky-100 pointer-events-none">
          Team canvas · owned by {owner} · your changes save to it
        </div>
      )}
      <WorkflowCanvas />
      <QuickAssist />
    </div>
  );
}
