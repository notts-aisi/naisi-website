"use client";

import { useState } from "react";
import Card from "@/components/ui/Card";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import {
  emptyBlock,
  videoEmbedFromUrl,
  type Block,
  type BlockType,
} from "@/lib/firestore/newsletterBlocks";
import ImageUpload from "./ImageUpload";
import RichTextEditor from "./RichTextEditor";
import styles from "./BlockEditor.module.css";

type Props = {
  draftId: string;
  /** Storage folder prefix for uploads. Defaults to newsletter-images. */
  storagePrefix?: string;
  blocks: Block[];
  onChange: (next: Block[]) => void;
  disabled?: boolean;
  /**
   * Restrict which block types the add menu and the insert divider offer.
   * Omitted means every type, so every caller that predates this prop keeps
   * exactly the menu it had.
   *
   * It filters the MENU, not the list: a block of an excluded type already in
   * `blocks` still renders its form. A body pasted from somewhere with a wider
   * menu is somebody's content, and hiding its editor would leave them a block
   * they can see, cannot change, and cannot work out how to delete.
   */
  allowedTypes?: BlockType[];
  /**
   * Tighter chrome for a block editor nested inside another editor's row
   * (a worksheet question's body, where the block list is a FIELD rather than
   * the page). Smaller headers, less padding, and the add menu as one row of
   * small buttons instead of a two-step grid, because the enclosing row
   * already carries the "what am I editing" framing that the grid's headline
   * and hints supply on a full-page editor.
   */
  compact?: boolean;
};

const ADD_MENU: Array<{ type: BlockType; label: string; hint: string }> = [
  { type: "heading", label: "Heading", hint: "Big section title" },
  { type: "richText", label: "Rich text", hint: "Paragraphs, lists, links" },
  { type: "image", label: "Image", hint: "Uploaded photo with caption" },
  { type: "video", label: "Video", hint: "Embed a YouTube or Loom URL" },
  { type: "divider", label: "Divider", hint: "Thin line between sections" },
];

export default function BlockEditor({
  draftId,
  storagePrefix,
  blocks,
  onChange,
  disabled,
  allowedTypes,
  compact,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAfterIndex, setMenuAfterIndex] = useState<number | null>(null);

  const menuItems = allowedTypes
    ? ADD_MENU.filter((item) => allowedTypes.includes(item.type))
    : ADD_MENU;

  function patchBlock(index: number, patch: Partial<Block>) {
    const next = blocks.slice();
    next[index] = { ...next[index], ...patch } as Block;
    onChange(next);
  }

  function addBlockAt(type: BlockType, insertAfter: number | null) {
    const b = emptyBlock(type);
    const next = blocks.slice();
    const at = insertAfter == null ? next.length : insertAfter + 1;
    next.splice(at, 0, b);
    onChange(next);
    setMenuOpen(false);
    setMenuAfterIndex(null);
  }

  function removeBlock(index: number) {
    const next = blocks.slice();
    next.splice(index, 1);
    onChange(next);
  }

  function moveBlock(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= blocks.length) return;
    const next = blocks.slice();
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className={`${styles.wrap} ${compact ? styles.compact : ""}`}>
      {blocks.length === 0 && !compact && (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
            No content yet. Add your first block below.
          </p>
        </Card>
      )}

      {blocks.map((block, i) => (
        <div key={block.id} className={styles.block}>
          <div className={styles.blockHeader}>
            <span className={styles.blockType}>{labelFor(block.type)}</span>
            <div className={styles.blockControls}>
              <button
                type="button"
                className={styles.moveBtn}
                onClick={() => moveBlock(i, -1)}
                disabled={disabled || i === 0}
                title="Move up"
                aria-label="Move block up"
              >
                ▲
              </button>
              <button
                type="button"
                className={styles.moveBtn}
                onClick={() => moveBlock(i, 1)}
                disabled={disabled || i === blocks.length - 1}
                title="Move down"
                aria-label="Move block down"
              >
                ▼
              </button>
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={() => removeBlock(i)}
                disabled={disabled}
                title="Delete block"
                aria-label="Delete block"
              >
                Delete
              </button>
            </div>
          </div>

          <div className={styles.blockBody}>
            <BlockForm
              block={block}
              draftId={draftId}
              storagePrefix={storagePrefix}
              disabled={disabled}
              onChange={(patch) => patchBlock(i, patch)}
            />
          </div>

          <InsertDivider
            items={menuItems}
            compact={compact}
            open={menuOpen && menuAfterIndex === i}
            onOpen={() => {
              setMenuOpen(true);
              setMenuAfterIndex(i);
            }}
            onClose={() => {
              setMenuOpen(false);
              setMenuAfterIndex(null);
            }}
            onPick={(t) => addBlockAt(t, i)}
            disabled={disabled}
          />
        </div>
      ))}

      {(blocks.length === 0 || menuAfterIndex === null) && (
        <AddBlockMenu
          items={menuItems}
          compact={compact}
          open={menuOpen && menuAfterIndex === null}
          onOpen={() => {
            setMenuOpen(true);
            setMenuAfterIndex(null);
          }}
          onClose={() => {
            setMenuOpen(false);
            setMenuAfterIndex(null);
          }}
          onPick={(t) => addBlockAt(t, blocks.length - 1)}
          disabled={disabled}
        />
      )}
    </div>
  );
}

function labelFor(type: BlockType): string {
  const match = ADD_MENU.find((m) => m.type === type);
  return match?.label ?? type;
}

function BlockForm({
  block,
  draftId,
  storagePrefix,
  disabled,
  onChange,
}: {
  block: Block;
  draftId: string;
  storagePrefix?: string;
  disabled?: boolean;
  onChange: (patch: Partial<Block>) => void;
}) {
  switch (block.type) {
    case "heading":
      return (
        <div className={styles.fields}>
          <label className={styles.fieldLabel}>
            <span>Heading text</span>
            <input
              type="text"
              className={styles.fieldInput}
              value={block.text}
              onChange={(e) => onChange({ text: e.target.value })}
              disabled={disabled}
              placeholder="e.g. What's new this month"
            />
          </label>
          <label className={styles.fieldLabel}>
            <span>Size</span>
            <ResponsiveSelect
              value={String(block.level)}
              onChange={(next) => onChange({ level: Number(next) as 2 | 3 })}
              options={[
                { value: "2", label: "Major (H2), big" },
                { value: "3", label: "Minor (H3), smaller" },
              ]}
              disabled={disabled}
              ariaLabel="Heading size"
            />
          </label>
        </div>
      );
    case "richText":
      return (
        <RichTextEditor
          html={block.html}
          onChange={(html) => onChange({ html })}
          disabled={disabled}
        />
      );
    case "image":
      return (
        <ImageUpload
          draftId={draftId}
          storagePrefix={storagePrefix}
          currentUrl={block.url}
          currentAlt={block.alt}
          currentCaption={block.caption}
          onChange={(next) =>
            onChange({
              url: next.url,
              alt: next.alt,
              caption: next.caption,
              storagePath: next.storagePath,
            })
          }
          disabled={disabled}
        />
      );
    case "divider":
      return (
        <div className={styles.dividerPreview}>
          <hr />
        </div>
      );
    case "video": {
      // One resolver for both providers, so the preview an author sees here is
      // built from exactly the URL the public renderer will build from.
      const embed = videoEmbedFromUrl(block.url);
      return (
        <div className={styles.fields}>
          <label className={styles.fieldLabel}>
            <span>YouTube or Loom URL</span>
            <input
              type="url"
              className={styles.fieldInput}
              value={block.url}
              onChange={(e) => onChange({ url: e.target.value })}
              disabled={disabled}
              placeholder="https://www.youtube.com/watch?v=… or https://www.loom.com/share/…"
            />
          </label>
          <label className={styles.fieldLabel}>
            <span>Caption (optional)</span>
            <input
              type="text"
              className={styles.fieldInput}
              value={block.caption ?? ""}
              onChange={(e) => onChange({ caption: e.target.value })}
              disabled={disabled}
              placeholder="e.g. Last month's fellowship talk"
            />
          </label>
          {block.url &&
            (embed ? (
              <div
                style={{
                  position: "relative",
                  paddingBottom: "56.25%",
                  height: 0,
                  borderRadius: "var(--radius-md)",
                  overflow: "hidden",
                  background: "#000",
                }}
              >
                <iframe
                  src={embed.embedUrl}
                  title={block.caption || "Video preview"}
                  allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: "100%",
                    border: 0,
                  }}
                />
              </div>
            ) : (
              <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)", margin: 0 }}>
                That doesn&apos;t look like a YouTube or Loom URL. Paste a link like
                https://www.youtube.com/watch?v=… or https://www.loom.com/share/…
              </p>
            ))}
        </div>
      );
    }
  }
}

type MenuItem = { type: BlockType; label: string; hint: string };

/**
 * The compact shape: one row of small buttons, each adding its type outright.
 * No open/close step, because the two-step menu exists to give a full-page
 * editor a headline and per-type hints, and inside a question row there is no
 * room for either and no ambiguity about what is being added.
 */
function AddChips({
  items,
  onPick,
  disabled,
}: {
  items: MenuItem[];
  onPick: (type: BlockType) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.addChips}>
      {items.map((item) => (
        <button
          key={item.type}
          type="button"
          className={styles.addChip}
          onClick={() => onPick(item.type)}
          disabled={disabled}
          title={item.hint}
        >
          + {item.label}
        </button>
      ))}
    </div>
  );
}

function AddBlockMenu({
  items,
  compact,
  open,
  onOpen,
  onClose,
  onPick,
  disabled,
}: {
  items: MenuItem[];
  compact?: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPick: (type: BlockType) => void;
  disabled?: boolean;
}) {
  if (items.length === 0) return null;
  if (compact) {
    return <AddChips items={items} onPick={onPick} disabled={disabled} />;
  }
  if (!open) {
    return (
      <button
        type="button"
        className={styles.addBigBtn}
        onClick={onOpen}
        disabled={disabled}
      >
        + Add block
      </button>
    );
  }
  return (
    <div className={styles.addMenu}>
      <div className={styles.addMenuHeader}>
        <strong>Add a block</strong>
        <button type="button" onClick={onClose} className={styles.addMenuClose}>
          Cancel
        </button>
      </div>
      <div className={styles.addMenuGrid}>
        {items.map((item) => (
          <button
            key={item.type}
            type="button"
            className={styles.addMenuItem}
            onClick={() => onPick(item.type)}
          >
            <strong>{item.label}</strong>
            <span>{item.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function InsertDivider({
  items,
  compact,
  open,
  onOpen,
  onClose,
  onPick,
  disabled,
}: {
  items: MenuItem[];
  compact?: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPick: (type: BlockType) => void;
  disabled?: boolean;
}) {
  if (items.length === 0) return null;
  if (!open) {
    return (
      <div className={styles.insertRow}>
        <button
          type="button"
          className={styles.insertBtn}
          onClick={onOpen}
          disabled={disabled}
          aria-label="Insert block here"
        >
          +
        </button>
      </div>
    );
  }
  if (compact) {
    return (
      <div className={styles.insertRow}>
        <AddChips items={items} onPick={onPick} disabled={disabled} />
        <button type="button" onClick={onClose} className={styles.addMenuClose}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className={styles.insertRow}>
      <div className={styles.addMenu}>
        <div className={styles.addMenuHeader}>
          <strong>Insert here</strong>
          <button type="button" onClick={onClose} className={styles.addMenuClose}>
            Cancel
          </button>
        </div>
        <div className={styles.addMenuGrid}>
          {items.map((item) => (
            <button
              key={item.type}
              type="button"
              className={styles.addMenuItem}
              onClick={() => onPick(item.type)}
            >
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
