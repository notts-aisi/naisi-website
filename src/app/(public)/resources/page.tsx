import type { Metadata } from "next";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import resources from "@/content/resources.json";
import styles from "./resources.module.css";

export const metadata: Metadata = {
  title: "Resources",
  description:
    "Where to start with AI safety: courses, research, governance, and careers worth your time.",
};

export default function ResourcesPage() {
  return (
    <section className={styles.page}>
      <div className="container">
        <div className={styles.intro}>
          <Badge>Learn</Badge>
          <h1 className={styles.heading}>AI safety resources</h1>
          <p className={styles.lede}>
            A short list for anyone wanting to go deeper on AI safety. We keep
            it short on purpose. These are the things we&apos;d actually
            recommend.
          </p>
        </div>

        <div className={styles.categories}>
          {resources.categories.map((cat) => (
            <div key={cat.title}>
              <h2 className={styles.categoryTitle}>{cat.title}</h2>
              <p className={styles.categoryDescription}>{cat.description}</p>
              <div className={styles.grid}>
                {cat.items.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={styles.itemLink}
                  >
                    <Card padding="md" interactive>
                      <h3 className={styles.itemTitle}>{item.title}</h3>
                      <p className={styles.itemDescription}>{item.description}</p>
                    </Card>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
