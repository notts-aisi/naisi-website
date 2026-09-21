"use client";

import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import Switch from "@/components/ui/Switch";
import { AdminLoadingBar } from "@/features/admin/adminList";
import { LINK_INTERESTS, type LinkInterest } from "@/lib/campaign/attribution";
import {
  LINKS_PAGE_LIMITS,
  defaultLinksPage,
  linksPageErrors,
  linksPageHrefError,
  newLinksPageId,
  type LinksPageContent,
  type LinksPageGroup,
  type LinksPageRow,
} from "@/lib/firestore/linksPage";
import { loadLinksPage, saveLinksPage } from "./linksPageData";
import styles from "./links.module.css";

const APPLICATION_NAMES: Record<LinkInterest, string> = {
  fellowship: "Fellowship applications",
  facilitator: "Facilitator applications",
  incubator: "Research incubator",
};

/** Move one item of a list by one place. Out of range leaves it as it was. */
function moved<T>(list: T[], from: number, by: number): T[] {
  const to = from + by;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * The editor for what /links says: the three application buttons, and the
 * sections of rows under them.
 *
 * The whole page is one document, edited here in memory and written in one
 * save, so a half-made change never reaches the public page. Save is refused
 * while any address would not be followed, which is the same check the public
 * page runs when it reads the document back.
 *
 * Nothing here can empty the page. With every row hidden or removed, the
 * public page shows the built-in rows from `src/content/links.ts`.
 */
export function LinksPageEditor() {
  const [loaded, setLoaded] = useState<{ content: LinksPageContent; stored: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadLinksPage()
      .then((next) => {
        if (!cancelled) setLoaded(next);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not load the page.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <Card padding="md">
        <p className={styles.error}>Couldn&apos;t load: {loadError}</p>
      </Card>
    );
  }
  if (!loaded) {
    return (
      <Card padding="md">
        <AdminLoadingBar label="Loading the links page…" />
      </Card>
    );
  }
  return <LinksPageForm initial={loaded.content} initiallyStored={loaded.stored} onSave={saveLinksPage} />;
}

/**
 * The form itself, with no database in it: given a page, it edits it in memory
 * and hands the whole thing to `onSave`. Kept apart from the loading above so
 * the two can be thought about separately.
 */
export function LinksPageForm({
  initial,
  initiallyStored,
  onSave,
}: {
  initial: LinksPageContent;
  initiallyStored: boolean;
  onSave: (content: LinksPageContent) => Promise<void>;
}) {
  const [content, setContent] = useState<LinksPageContent>(initial);
  const [saved, setSaved] = useState<string>(() => JSON.stringify(initial));
  const [stored, setStored] = useState(initiallyStored);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const errors = useMemo(() => linksPageErrors(content), [content]);
  const dirty = JSON.stringify(content) !== saved;

  const edit = (next: LinksPageContent) => {
    setContent(next);
    setJustSaved(false);
    setSaveError(null);
  };
  const editGroup = (g: number, patch: Partial<LinksPageGroup>) =>
    edit({ ...content, groups: content.groups.map((group, i) => (i === g ? { ...group, ...patch } : group)) });
  const editRow = (g: number, r: number, patch: Partial<LinksPageRow>) =>
    editGroup(g, { rows: content.groups[g].rows.map((row, i) => (i === r ? { ...row, ...patch } : row)) });

  async function save() {
    setBusy(true);
    setSaveError(null);
    try {
      await onSave(content);
      setSaved(JSON.stringify(content));
      setStored(true);
      setJustSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save the page.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.editorPage}>
      <p className={styles.intro}>
        What people see at <strong>/links</strong>, which is where most printed QR codes land. A
        change shows on the page within a minute of saving. The mailing list form and the upcoming
        events are always there and are not edited here.
        {!stored && " Nothing has been saved yet, so this is the built-in page."}
      </p>

      <Card padding="lg">
        <h2 className={styles.editorHeading}>Applications</h2>
        <p className={styles.hint}>
          While one is closed its button says &quot;Opens soon&quot; and leads to the mailing list
          form, recording which one the person is waiting for. Mark it open and give it an address,
          and the button becomes a link to the application.
        </p>
        <div className={styles.applicationList}>
          {LINK_INTERESTS.map((id) => {
            const application = content.applications[id];
            const problem = application.open ? linksPageHrefError(application.href, false) : null;
            return (
              <div key={id} className={styles.application}>
                <Switch
                  checked={application.open}
                  onChange={(open) =>
                    edit({
                      ...content,
                      applications: { ...content.applications, [id]: { ...application, open } },
                    })
                  }
                  label={APPLICATION_NAMES[id]}
                  description={application.open ? "Open: the button is a link." : "Opens soon: the button leads to the mailing list form."}
                  tone="success"
                />
                {application.open && (
                  <label className={styles.field}>
                    <span className={styles.label}>Where the application is</span>
                    <Input
                      value={application.href}
                      maxLength={LINKS_PAGE_LIMITS.href}
                      onChange={(e) =>
                        edit({
                          ...content,
                          applications: {
                            ...content.applications,
                            [id]: { ...application, href: e.target.value },
                          },
                        })
                      }
                      placeholder="/courses or https://…"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      inputMode="url"
                    />
                    {problem && <span className={styles.error}>{problem}</span>}
                  </label>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {content.groups.map((group, g) => (
        <Card key={group.id} padding="lg">
          <div className={styles.sectionHead}>
            <label className={styles.field}>
              <span className={styles.label}>Section heading</span>
              <Input
                value={group.heading}
                maxLength={LINKS_PAGE_LIMITS.heading}
                onChange={(e) => editGroup(g, { heading: e.target.value })}
                placeholder="Get involved"
              />
            </label>
            <div className={styles.rowTools}>
              <Button
                size="sm"
                variant="ghost"
                disabled={g === 0}
                onClick={() => edit({ ...content, groups: moved(content.groups, g, -1) })}
              >
                Up
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={g === content.groups.length - 1}
                onClick={() => edit({ ...content, groups: moved(content.groups, g, 1) })}
              >
                Down
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={group.rows.length > 0}
                title={group.rows.length > 0 ? "Remove its rows first" : undefined}
                onClick={() => edit({ ...content, groups: content.groups.filter((_, i) => i !== g) })}
              >
                Remove section
              </Button>
            </div>
          </div>

          <ol className={styles.editRows}>
            {group.rows.map((row, r) => {
              const problem = linksPageHrefError(row.href, row.soon);
              return (
                <li key={row.id} className={styles.editRow} data-hidden={row.hidden ? "true" : undefined}>
                  <div className={styles.formGrid}>
                    <label className={styles.field}>
                      <span className={styles.label}>Label</span>
                      <Input
                        value={row.label}
                        maxLength={LINKS_PAGE_LIMITS.label}
                        onChange={(e) => editRow(g, r, { label: e.target.value })}
                        placeholder="Our courses"
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.label}>Where it goes</span>
                      <Input
                        value={row.href}
                        maxLength={LINKS_PAGE_LIMITS.href}
                        onChange={(e) => editRow(g, r, { href: e.target.value })}
                        placeholder="/courses or https://…"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        inputMode="url"
                      />
                    </label>
                  </div>
                  {problem && <p className={styles.error}>{problem}</p>}
                  <label className={styles.field}>
                    <span className={styles.label}>The line under the label</span>
                    <Input
                      value={row.sub}
                      maxLength={LINKS_PAGE_LIMITS.sub}
                      onChange={(e) => editRow(g, r, { sub: e.target.value })}
                      placeholder="Termly AI safety courses. See what is running and apply."
                    />
                  </label>
                  <div className={styles.rowSwitches}>
                    <Switch
                      checked={row.soon}
                      onChange={(soon) => editRow(g, r, { soon })}
                      label="Opens soon"
                      description="Shown with an Opens soon marker, and not a link, so nobody taps through to something that is not there yet."
                    />
                    <Switch
                      checked={row.hidden}
                      onChange={(hidden) => editRow(g, r, { hidden })}
                      label="Hidden"
                      description="Kept here, left off the page."
                    />
                  </div>
                  <div className={styles.rowTools}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={r === 0}
                      onClick={() => editGroup(g, { rows: moved(group.rows, r, -1) })}
                    >
                      Up
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={r === group.rows.length - 1}
                      onClick={() => editGroup(g, { rows: moved(group.rows, r, 1) })}
                    >
                      Down
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => editGroup(g, { rows: group.rows.filter((_, i) => i !== r) })}
                    >
                      Remove row
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>

          <Button
            size="sm"
            variant="secondary"
            disabled={group.rows.length >= LINKS_PAGE_LIMITS.rowsPerGroup}
            onClick={() =>
              editGroup(g, {
                rows: [
                  ...group.rows,
                  { id: newLinksPageId("row"), label: "", sub: "", href: "", soon: false, hidden: false },
                ],
              })
            }
          >
            Add a row
          </Button>
        </Card>
      ))}

      <div className={styles.formActions}>
        <Button
          variant="secondary"
          disabled={content.groups.length >= LINKS_PAGE_LIMITS.groups}
          onClick={() =>
            edit({
              ...content,
              groups: [...content.groups, { id: newLinksPageId("group"), heading: "", rows: [] }],
            })
          }
        >
          Add a section
        </Button>
        <Button variant="ghost" onClick={() => edit(defaultLinksPage())}>
          Start again from the built-in page
        </Button>
      </div>

      <div className={styles.saveBar}>
        {errors.length > 0 && (
          <ul className={styles.errorList}>
            {errors.slice(0, 5).map((message, i) => (
              <li key={i}>{message}</li>
            ))}
          </ul>
        )}
        {saveError && <p className={styles.error}>{saveError}</p>}
        <div className={styles.formActions}>
          <Button onClick={save} disabled={busy || !dirty || errors.length > 0}>
            {busy ? "Saving…" : "Save the page"}
          </Button>
          <span className={styles.hint}>
            {justSaved
              ? "Saved. It shows on /links within a minute."
              : dirty
                ? "Unsaved changes."
                : "No changes."}
          </span>
        </div>
      </div>
    </div>
  );
}
