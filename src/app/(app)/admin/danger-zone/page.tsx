"use client";

/**
 * TEMPORARY admin page — fire-once data-wipe controls. After both
 * environments (dev + prod) have been reset, remove:
 *   - this directory: `src/app/(app)/admin/danger-zone/`
 *   - the API route: `src/app/api/admin/nuke-tasks/`
 *   - the "Danger zone" entry in `src/app/(app)/admin/AdminTabs.tsx`
 *
 * Tracking PR for the cleanup is implied — no Firestore docs to clean,
 * just file deletions.
 */

import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { useTasks } from "@/features/tasks/hooks/useTasks";

const REQUIRED_CONFIRM = "DELETE ALL TASKS";

type DeletionReport = {
  tasks: number;
  comments: number;
  activity: number;
  attachments: number;
  storageDeleted: number;
  storageFailed: number;
};

export default function DangerZonePage() {
  // Admin sees every task in the project via Firestore rules; no filter
  // needed beyond `includeArchived` so the archived rows count too.
  const { tasks, loading } = useTasks({ includeArchived: true });
  const [stage, setStage] = useState<"idle" | "confirming" | "wiping" | "done">(
    "idle",
  );
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<DeletionReport | null>(null);

  async function handleNuke() {
    if (confirmText !== REQUIRED_CONFIRM) {
      setError(`Type "${REQUIRED_CONFIRM}" exactly to enable.`);
      return;
    }
    setStage("wiping");
    setError(null);
    try {
      const res = await fetch("/api/admin/nuke-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: REQUIRED_CONFIRM }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Wipe failed (${res.status})`,
        );
      }
      const body = (await res.json()) as { deleted?: DeletionReport };
      setReport(body.deleted ?? null);
      setStage("done");
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Wipe failed");
      setStage("confirming");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <div>
        <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
          Temporary admin tools — these run irreversible operations against
          this environment&apos;s Firestore. Targets whichever project this
          backend is wired to (dev wipes dev; prod wipes prod). The whole
          page + its API route will be removed in a follow-up PR once
          you&apos;ve used them.
        </p>
      </div>

      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div>
            <h2
              style={{
                fontSize: "var(--text-lg)",
                fontWeight: 600,
                margin: 0,
                color: "var(--color-danger, #dc2626)",
              }}
            >
              Wipe all tasks
            </h2>
            <p
              style={{
                color: "var(--color-text-muted)",
                fontSize: "var(--text-sm)",
                marginTop: "var(--space-2)",
              }}
            >
              Deletes every task in this project — every doc under{" "}
              <code>tasks/</code>, plus their comments, activity entries,
              attachments, and Storage blobs. Cannot be undone. Task templates,
              users, projects, and email-deliverability data are NOT touched.
            </p>
            <p
              style={{
                fontSize: "var(--text-sm)",
                marginTop: "var(--space-2)",
              }}
            >
              Currently in this project:{" "}
              <strong>
                {loading
                  ? "counting…"
                  : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`}
              </strong>
            </p>
          </div>

          {stage === "idle" && (
            <div>
              <Button
                variant="danger"
                onClick={() => {
                  setStage("confirming");
                  setConfirmText("");
                  setError(null);
                }}
                disabled={loading || tasks.length === 0}
              >
                {tasks.length === 0
                  ? "Nothing to wipe"
                  : "Wipe every task in this project"}
              </Button>
            </div>
          )}

          {stage === "confirming" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-2)",
                padding: "var(--space-3)",
                background: "var(--color-danger-soft, rgba(220, 38, 38, 0.08))",
                border: "1px solid var(--color-danger, #dc2626)",
                borderRadius: "var(--radius-md)",
              }}
            >
              <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
                Type <code>{REQUIRED_CONFIRM}</code> below to enable the wipe.
                There is no undo.
              </p>
              <input
                type="text"
                autoFocus
                value={confirmText}
                onChange={(e) => {
                  setConfirmText(e.target.value);
                  if (error) setError(null);
                }}
                placeholder={REQUIRED_CONFIRM}
                style={{
                  padding: "0.55rem 0.75rem",
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-sm, 4px)",
                  color: "var(--color-text)",
                  fontSize: "var(--text-sm)",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  outline: "none",
                }}
                spellCheck={false}
                autoComplete="off"
              />
              {error && (
                <p
                  style={{
                    margin: 0,
                    fontSize: "var(--text-xs)",
                    color: "var(--color-danger, #dc2626)",
                  }}
                >
                  {error}
                </p>
              )}
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <Button
                  variant="danger"
                  onClick={handleNuke}
                  disabled={confirmText !== REQUIRED_CONFIRM}
                >
                  Confirm wipe
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStage("idle");
                    setConfirmText("");
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {stage === "wiping" && (
            <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
              Wiping… don&apos;t close this tab. This can take a moment if
              there are many tasks with attachments.
            </p>
          )}

          {stage === "done" && report && (
            <div
              style={{
                padding: "var(--space-3)",
                background: "var(--color-success-soft, rgba(22, 163, 74, 0.08))",
                border: "1px solid var(--color-success, #16a34a)",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--text-sm)",
              }}
            >
              <strong>Done.</strong> Deleted {report.tasks} tasks, {report.comments}{" "}
              comments, {report.activity} activity entries, {report.attachments}{" "}
              attachments ({report.storageDeleted} Storage blobs cleaned, {report.storageFailed}{" "}
              failed). Refresh the task board to see the empty state.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
