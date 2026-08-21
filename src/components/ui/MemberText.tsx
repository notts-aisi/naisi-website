import styles from "./MemberText.module.css";

type Props = {
  text: string;
  className?: string;
};

/**
 * THE renderer for member-authored text — public cohort comments, private
 * notes, exercise answers. Everything a member types goes through here.
 *
 * It renders `text` as a React text node and nothing else. Never
 * dangerouslySetInnerHTML. Never a markdown parser. Never linkification —
 * auto-linking re-opens the URL-in-user-content surface this component exists
 * to close, and it is not worth a clickable link. If a surface seems to need
 * formatting, it needs facilitator-authored content instead: the block editor
 * plus RichTextRender, which is a different trust boundary.
 *
 * Corollary for callers: member text is typed `string` end to end. If you find
 * yourself widening that type or reaching past this component to render it,
 * that is the bug.
 */
export default function MemberText({ text, className }: Props) {
  return <div className={className ? `${styles.text} ${className}` : styles.text}>{text}</div>;
}
