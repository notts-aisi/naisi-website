import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import styles from "./layout.module.css";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" aria-label="NAISI home">
          <BrandMark size={32} />
        </Link>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
