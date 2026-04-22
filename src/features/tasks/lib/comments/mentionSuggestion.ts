"use client";

import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import type {
  SuggestionOptions,
  SuggestionProps,
  SuggestionKeyDownProps,
} from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import type { UserDoc } from "@/lib/firestore/users";
import { createElement } from "react";
import MentionDropdown, {
  mentionItemsFromUsers,
  type MentionDropdownHandle,
  type MentionDropdownItem,
} from "../../components/MentionDropdown";

/**
 * TipTap suggestion config for the Mention extension. Wires the React
 * MentionDropdown into a tippy popover positioned next to the caret, and
 * forwards editor keydown events into the dropdown's imperative handle so
 * arrow keys / enter / escape work without stealing focus from the editor.
 *
 * Users are passed in at build-time rather than fetched here — the composer
 * already has a cached user list, and refetching would thrash.
 */
export function buildMentionSuggestion(
  getUsers: () => UserDoc[],
): Omit<SuggestionOptions<MentionDropdownItem>, "editor"> {
  return {
    char: "@",
    items: ({ query }: { query: string }) => mentionItemsFromUsers(getUsers(), query),
    render: () => {
      let container: HTMLDivElement | null = null;
      let root: Root | null = null;
      let popup: TippyInstance[] | null = null;
      const handleRef: { current: MentionDropdownHandle | null } = { current: null };

      function mount(props: SuggestionProps<MentionDropdownItem>) {
        container = document.createElement("div");
        root = createRoot(container);
        renderDropdown(props);
        const rect = props.clientRect?.();
        if (!rect) return;
        popup = tippy("body", {
          getReferenceClientRect: () => rect,
          appendTo: () => document.body,
          content: container,
          showOnCreate: true,
          interactive: true,
          trigger: "manual",
          placement: "bottom-start",
          theme: "naisi-mention",
          arrow: false,
          offset: [0, 4],
        });
      }

      function renderDropdown(props: SuggestionProps<MentionDropdownItem>) {
        if (!root) return;
        root.render(
          createElement(MentionDropdown, {
            items: props.items,
            command: (item) => props.command(item),
            ref: (h: MentionDropdownHandle | null) => {
              handleRef.current = h;
            },
          }),
        );
      }

      return {
        onStart: (props) => {
          mount(props);
        },
        onUpdate: (props) => {
          renderDropdown(props);
          const rect = props.clientRect?.();
          if (rect && popup?.[0]) {
            popup[0].setProps({ getReferenceClientRect: () => rect });
          }
        },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === "Escape") {
            popup?.[0]?.hide();
            return true;
          }
          return handleRef.current?.onKeyDown(props.event) ?? false;
        },
        onExit: () => {
          popup?.[0]?.destroy();
          popup = null;
          // Defer unmount a tick so React doesn't warn about unmount during render.
          queueMicrotask(() => {
            root?.unmount();
            root = null;
            container?.remove();
            container = null;
          });
        },
      };
    },
    command: ({ editor, range, props }: { editor: Editor; range: { from: number; to: number }; props: MentionDropdownItem }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: "mention", attrs: { id: props.uid, label: props.displayName } },
          { type: "text", text: " " },
        ])
        .run();
    },
  };
}
