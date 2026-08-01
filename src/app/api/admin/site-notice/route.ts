import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  SITE_NOTICE_LEVELS,
  SITE_NOTICE_LIMITS,
  SITE_NOTICE_MAX_TTL_MS,
  SITE_NOTICE_PATH,
  SITE_NOTICE_SURFACE_FLAGS,
  SITE_NOTICE_SURFACES,
  normaliseSiteNotice,
  type SiteNoticeLevel,
} from "@/lib/siteNotice";

/**
 * Admin-only: read or update the site-wide maintenance notice at
 * `publicConfig/siteNotice` (structural clone of ../config/task-emails).
 * See `src/lib/siteNotice.ts` for the doc's semantics.
 *
 * The public doc is world-readable, so audit fields (who flipped it) are
 * written to `config/siteNoticeAudit` — default-deny in rules, surfaced only
 * through the GET here.
 *
 * This route ADMINISTERS the notice; it must never be GATED by it (nothing
 * under /api/admin/ may be, or an admin couldn't switch it off —
 * tests/no-admin-gating.test.mjs enforces this).
 */

const AUDIT_PATH = { collection: "config", doc: "siteNoticeAudit" } as const;

type AuditDoc = {
  updatedByUid: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
};

async function readState(db: FirebaseFirestore.Firestore) {
  const [noticeSnap, auditSnap] = await Promise.all([
    db.collection(SITE_NOTICE_PATH.collection).doc(SITE_NOTICE_PATH.doc).get(),
    db.collection(AUDIT_PATH.collection).doc(AUDIT_PATH.doc).get(),
  ]);
  const notice = normaliseSiteNotice(
    noticeSnap.exists ? noticeSnap.data() : null,
    new Date(),
  );
  const auditData = auditSnap.exists ? (auditSnap.data() ?? {}) : {};
  const auditUpdatedAt = auditData.updatedAt as
    | { toDate?: () => Date }
    | null
    | undefined;
  const audit: AuditDoc = {
    updatedByUid:
      typeof auditData.updatedByUid === "string" ? auditData.updatedByUid : null,
    updatedByName:
      typeof auditData.updatedByName === "string" ? auditData.updatedByName : null,
    updatedAt:
      auditUpdatedAt && typeof auditUpdatedAt.toDate === "function"
        ? auditUpdatedAt.toDate().toISOString()
        : null,
  };
  return {
    notice: {
      active: notice.active,
      level: notice.level,
      message: notice.message,
      linkUrl: notice.linkUrl,
      endsAt: notice.endsAt?.toISOString() ?? null,
      updatedAt: notice.updatedAt?.toISOString() ?? null,
      expiresAt: notice.expiresAt?.toISOString() ?? null,
      paused: notice.paused,
      bannerVisible: notice.bannerVisible,
    },
    audit,
  };
}

export async function GET() {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }
  return NextResponse.json(await readState(db));
}

export async function PATCH(req: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Every field is optional (PATCH + merge). Provided fields are validated
  // strictly — a bad value is a 400, never a silently-coerced write: the doc
  // should only ever contain values the normaliser passes through untouched.
  const update: Record<string, unknown> = {};

  if ("active" in body) {
    if (typeof body.active !== "boolean") {
      return NextResponse.json({ error: "`active` must be a boolean" }, { status: 400 });
    }
    update.active = body.active;
  }

  if ("level" in body) {
    if (!(SITE_NOTICE_LEVELS as readonly unknown[]).includes(body.level)) {
      return NextResponse.json(
        { error: `\`level\` must be one of: ${SITE_NOTICE_LEVELS.join(", ")}` },
        { status: 400 },
      );
    }
    update.level = body.level as SiteNoticeLevel;
  }

  if ("message" in body) {
    if (typeof body.message !== "string") {
      return NextResponse.json({ error: "`message` must be a string" }, { status: 400 });
    }
    const message = body.message.trim();
    if (message.length > SITE_NOTICE_LIMITS.message) {
      return NextResponse.json(
        { error: `\`message\` must be ≤ ${SITE_NOTICE_LIMITS.message} characters` },
        { status: 400 },
      );
    }
    update.message = message;
  }

  if ("linkUrl" in body) {
    if (body.linkUrl === null || body.linkUrl === "") {
      update.linkUrl = null;
    } else if (
      typeof body.linkUrl !== "string" ||
      !body.linkUrl.startsWith("https://") ||
      body.linkUrl.length > SITE_NOTICE_LIMITS.linkUrl
    ) {
      return NextResponse.json(
        {
          error: `\`linkUrl\` must be an https:// URL of ≤ ${SITE_NOTICE_LIMITS.linkUrl} characters (or null)`,
        },
        { status: 400 },
      );
    } else {
      update.linkUrl = body.linkUrl;
    }
  }

  if ("endsAt" in body) {
    if (body.endsAt === null) {
      // Explicitly no end time — the normaliser's 24h-after-updatedAt
      // backstop still applies at read time.
      update.endsAt = null;
    } else {
      const endsAt =
        typeof body.endsAt === "string" ? new Date(body.endsAt) : null;
      if (endsAt === null || Number.isNaN(endsAt.getTime())) {
        return NextResponse.json(
          { error: "`endsAt` must be an ISO date string or null" },
          { status: 400 },
        );
      }
      const now = Date.now();
      // 5-minute grace on the cap so client clock skew can't bounce a
      // legitimate "24h" selection.
      if (endsAt.getTime() <= now || endsAt.getTime() > now + SITE_NOTICE_MAX_TTL_MS + 5 * 60 * 1000) {
        return NextResponse.json(
          { error: "`endsAt` must be in the future and at most 24h away" },
          { status: 400 },
        );
      }
      update.endsAt = endsAt;
    }
  }

  for (const surface of SITE_NOTICE_SURFACES) {
    const field = SITE_NOTICE_SURFACE_FLAGS[surface];
    if (field in body) {
      if (typeof body[field] !== "boolean") {
        return NextResponse.json(
          { error: `\`${field}\` must be a boolean` },
          { status: 400 },
        );
      }
      update[field] = body[field];
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No recognised fields in body" }, { status: 400 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  await db
    .collection(SITE_NOTICE_PATH.collection)
    .doc(SITE_NOTICE_PATH.doc)
    .set({ ...update, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await db
    .collection(AUDIT_PATH.collection)
    .doc(AUDIT_PATH.doc)
    .set(
      {
        updatedByUid: actor.uid,
        updatedByName: actor.displayName ?? actor.email ?? actor.uid,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  return NextResponse.json({ ok: true, ...(await readState(db)) });
}
