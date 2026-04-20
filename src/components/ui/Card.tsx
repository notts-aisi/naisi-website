import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Card.module.css";

type Props = HTMLAttributes<HTMLDivElement> & {
  as?: "div" | "article" | "section";
  padding?: "sm" | "md" | "lg" | "none";
  interactive?: boolean;
  children: ReactNode;
};

export default function Card({
  as: Tag = "div",
  padding = "md",
  interactive,
  className,
  children,
  ...rest
}: Props) {
  const cls = [
    styles.card,
    styles[`pad-${padding}`],
    interactive ? styles.interactive : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag className={cls} {...rest}>
      {children}
    </Tag>
  );
}
