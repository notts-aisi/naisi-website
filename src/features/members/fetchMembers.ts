import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";

export type PublicMember = {
  uid: string;
  displayName: string;
  photoURL?: string;
  role: "committee" | "admin";
  title?: string;
  bio?: string;
  bookingEnabled?: boolean;
};

export async function getPublicMembers(): Promise<PublicMember[]> {
  const db = getAdminDb();
  if (!db) return [];

  const snap = await db
    .collection("users")
    .where("showOnMembers", "==", true)
    .where("role", "in", ["committee", "admin"])
    .get();

  return snap.docs.map((d) => {
    const data = d.data();
    return {
      uid: d.id,
      displayName: data.profile?.preferredName ?? data.displayName ?? "Member",
      photoURL: data.photoURL,
      role: data.role,
      title: data.title,
      bio: data.bio,
      bookingEnabled: Boolean(data.availability),
    };
  });
}
