/**
 * Rules tests for the worksheets feature (docs/worksheets.md).
 *
 * The suite is written MEMBER-FIRST and persona-by-persona, because admins
 * take a resource-independent branch of nearly every rule in this file: an
 * admin can list unfiltered, read a private worksheet and reach any response,
 * so a suite that proved the feature works for an admin would have proved
 * nothing at all about the people who actually use it.
 *
 * The properties that must hold, in rough order of blast radius:
 *
 *  - A RECIPIENT NEVER SEES A SCORE. Reviews are their own subcollection with
 *    the recipient off the read list, so this is one rule rather than two that
 *    have to agree.
 *  - A SUBMITTED RESPONSE IS FROZEN. The gate reads the STORED state, so a
 *    recipient cannot write 'started' back over 'submitted' and edit answers
 *    the reviewers have already read.
 *  - ONE RECIPIENT NEVER ENUMERATES ANOTHER'S ANSWERS. The response doc id is
 *    the recipient's uid, which makes their own get legal and their list of
 *    the subcollection refused.
 *  - THE SHAPE RULES ARE REAL. Firestore judges a list on the query's shape,
 *    not on the rows it returns, so a committee library list must carry
 *    `where("private", "==", false)` and a staff circulation list must carry
 *    `where("staffUids", "array-contains", uid)`. Both are pinned here in BOTH
 *    directions: with the clause it is allowed, without it, refused. That
 *    pairing is what #261 was missing for four months.
 *  - CIRCULATIONS AND RESPONSES ARE ROUTE-WRITTEN. No client create, no client
 *    delete, admins included, because each one carries a task, a counter and a
 *    send with it.
 *  - `private` IS ADMIN-ONLY IN BOTH DIRECTIONS AND AT BOTH CREATE AND UPDATE.
 *    Pinning it at update alone would let a committee member create the
 *    worksheet private and walk past the gate.
 *  - DELETING A WORKSHEET IS A ROUTE TOO, since the deletion work landed. The
 *    author is still the person who may do it, but a document delete strands
 *    the question images in Storage and cannot ask whether a circulation of
 *    the worksheet is still open, so the client delete closed and the
 *    permission moved into the route. The refusals for every hat, admins
 *    included, are in member-records.test.mjs.
 */
import { after, afterEach, before, describe, it } from "node:test";
import {
  asAnon,
  asUser,
  assertFails,
  assertSucceeds,
  cleanup,
  clearData,
  getTestEnv,
  seed,
  seedUser,
} from "../lib/harness.mjs";

before(async () => {
  await getTestEnv("worksheets");
});
after(cleanup);
afterEach(clearData);

// ---------------------------------------------------------------------------
// Cast
// ---------------------------------------------------------------------------

/**
 * One of every hat the worksheet rules distinguish.
 *
 * `committee1` is NON-SU on purpose: the library is deliberately open to the
 * whole committee, so if a rule ever tightens to isSuCommittee() the tests
 * that use this persona are the ones that go red.
 */
async function seedCast() {
  await seedUser("admin1", { role: "admin" });
  await seedUser("member1", { role: "member" });
  await seedUser("pending1", { role: "pending" });
  await seedUser("committee1", { role: "committee", suRecognised: false });
  await seedUser("committee2", { role: "committee", suRecognised: false });
  await seedUser("su1", { role: "committee", suRecognised: true });
  // The new permission, granted to a plain member: circulating is not a rank.
  await seedUser("circulator", {
    role: "member",
    permissions: { circulateWorksheet: true },
  });
  // Two ex-authors. `member1` doubles as the demoted one (a committee member
  // moved back to member); `rejected1` is the harder case, an account that was
  // turned away outright. Both are used to prove that authorship is not a
  // standing grant that outlives the role which earned it.
  await seedUser("rejected1", { role: "rejected" });
}

function worksheetDoc(overrides = {}) {
  return {
    title: "Reading reflection",
    description: "Three questions on this week's paper.",
    folderId: null,
    authorUid: "committee1",
    private: false,
    items: [],
    defaultReviewConfig: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastCirculatedAt: null,
    ...overrides,
  };
}

async function seedWorksheet(id, overrides = {}) {
  await seed(async (db) => {
    const ref = db.collection("worksheets").doc(id);
    await ref.set(worksheetDoc(overrides));
    await ref.get();
  });
}

/** One item past the hundred the rules allow. Page breaks: smallest item. */
function tooManyItems() {
  return Array.from({ length: 101 }, (_, i) => ({ kind: "pageBreak", id: `pb_${i}` }));
}

// ---------------------------------------------------------------------------
// worksheets
// ---------------------------------------------------------------------------

describe("worksheets: the library document", () => {
  it("refuses a plain member creating one (the library is a committee surface)", async () => {
    await seedCast();
    const db = await asUser("member1");
    await assertFails(
      db.collection("worksheets").doc("w-new").set(worksheetDoc({ authorUid: "member1" })),
    );
  });

  it("refuses a pending account, and a signed-out visitor, outright", async () => {
    await seedCast();
    await seedWorksheet("w1");
    const pending = await asUser("pending1");
    await assertFails(
      pending.collection("worksheets").doc("w-new").set(worksheetDoc({ authorUid: "pending1" })),
    );
    await assertFails(pending.collection("worksheets").doc("w1").get());
    const anon = await asAnon();
    await assertFails(anon.collection("worksheets").doc("w1").get());
  });

  it("lets a NON-SU committee member create their own", async () => {
    await seedCast();
    const db = await asUser("committee1");
    await assertSucceeds(
      db.collection("worksheets").doc("w-new").set(worksheetDoc({ authorUid: "committee1" })),
    );
  });

  it("refuses a committee member creating one owned by somebody else", async () => {
    // Otherwise a committee member could put words in a colleague's mouth in a
    // library everybody browses, and the "edit your own, copy everyone else's"
    // model would have nothing to stand on.
    await seedCast();
    const db = await asUser("committee1");
    await assertFails(
      db.collection("worksheets").doc("w-new").set(worksheetDoc({ authorUid: "su1" })),
    );
  });

  it("refuses a committee member creating one PRIVATE (admin-only flag)", async () => {
    await seedCast();
    const db = await asUser("committee1");
    await assertFails(
      db
        .collection("worksheets")
        .doc("w-new")
        .set(worksheetDoc({ authorUid: "committee1", private: true })),
    );
  });

  it("lets an admin create one private", async () => {
    await seedCast();
    const db = await asUser("admin1");
    await assertSucceeds(
      db
        .collection("worksheets")
        .doc("w-new")
        .set(worksheetDoc({ authorUid: "admin1", private: true })),
    );
  });

  it("refuses a create with no `private` field at all", async () => {
    // The read rule compares the bare field so the query analyser can discharge
    // it (see the block comment in firestore.rules). A document without the
    // field would make that comparison raise, which is a deny nobody can debug.
    await seedCast();
    const doc = worksheetDoc({ authorUid: "committee1" });
    delete doc.private;
    const db = await asUser("committee1");
    await assertFails(db.collection("worksheets").doc("w-new").set(doc));
  });

  it("refuses a title over the 120-character cap", async () => {
    await seedCast();
    const db = await asUser("committee1");
    await assertFails(
      db
        .collection("worksheets")
        .doc("w-new")
        .set(worksheetDoc({ authorUid: "committee1", title: "x".repeat(121) })),
    );
  });

  it("refuses more than 100 items", async () => {
    await seedCast();
    const db = await asUser("committee1");
    await assertFails(
      db
        .collection("worksheets")
        .doc("w-new")
        .set(worksheetDoc({ authorUid: "committee1", items: tooManyItems() })),
    );
  });

  it("refuses more than 100 items on UPDATE as well, not only on create", async () => {
    // The create cap on its own would be theatre: the editor autosaves the
    // whole array client-direct on every keystroke pause, so an unbounded
    // array arrives by growing an existing worksheet, never by creating one.
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("committee1");
    await assertFails(
      db.collection("worksheets").doc("w1").update({ items: tooManyItems() }),
    );
  });

  it("refuses a description over the 1000-character cap, at create and update", async () => {
    // `description` is capped through `.get()` with a default because, unlike
    // `private`, it is genuinely optional and a bare read of a missing key
    // would deny by evaluation error rather than by decision.
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("committee1");
    await assertFails(
      db
        .collection("worksheets")
        .doc("w-new")
        .set(worksheetDoc({ authorUid: "committee1", description: "x".repeat(1001) })),
    );
    await assertFails(
      db.collection("worksheets").doc("w1").update({ description: "x".repeat(1001) }),
    );
  });

  it("still accepts a worksheet with no description key at all", async () => {
    // The other half of the same cap: `.get('description', '')` must let a
    // document that never had the field through, or the first save of every
    // worksheet written before the field existed is refused.
    await seedCast();
    const doc = worksheetDoc({ authorUid: "committee1" });
    delete doc.description;
    const db = await asUser("committee1");
    await assertSucceeds(db.collection("worksheets").doc("w-new").set(doc));
  });

  it("SHAPE RULE: a committee list carrying where(private == false) is allowed", async () => {
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("committee1");
    await assertSucceeds(db.collection("worksheets").where("private", "==", false).get());
  });

  it("SHAPE RULE: the same committee list WITHOUT that clause is refused outright", async () => {
    // Not "returns fewer rows", refused. Firestore judges a list or a listen
    // on the query's shape rather than on the rows it would return, so the
    // library page has to carry the clause or every committee member sees an
    // empty grid with no error. This is the #261 failure mode, pinned in both
    // directions so neither half can be deleted quietly.
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("committee1");
    await assertFails(db.collection("worksheets").get());
  });

  it("lets an admin list unfiltered (their branch is resource-independent)", async () => {
    await seedCast();
    await seedWorksheet("w1");
    await seedWorksheet("w-private", { private: true, authorUid: "admin1" });
    const db = await asUser("admin1");
    await assertSucceeds(db.collection("worksheets").get());
  });

  it("lets the author update their own", async () => {
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("committee1");
    await assertSucceeds(
      db.collection("worksheets").doc("w1").update({ title: "Reading reflection v2" }),
    );
  });

  it("refuses another committee member updating it (they make a copy instead)", async () => {
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("committee2");
    await assertFails(db.collection("worksheets").doc("w1").update({ title: "Mine now" }));
  });

  it("refuses an SU-recognised committee member updating it either", async () => {
    // suRecognised is the PII trust boundary, not an editing rank. Being on the
    // SU's list does not make somebody else's worksheet yours.
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("su1");
    await assertFails(db.collection("worksheets").doc("w1").update({ title: "Mine now" }));
  });

  it("refuses the author flipping their own worksheet private", async () => {
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("committee1");
    await assertFails(db.collection("worksheets").doc("w1").update({ private: true }));
  });

  it("lets an admin flip private, and flip it back", async () => {
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("admin1");
    await assertSucceeds(db.collection("worksheets").doc("w1").update({ private: true }));
    await assertSucceeds(db.collection("worksheets").doc("w1").update({ private: false }));
  });

  it("refuses an update that re-homes authorUid, even by the author", async () => {
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("committee1");
    await assertFails(db.collection("worksheets").doc("w1").update({ authorUid: "su1" }));
  });

  it("refuses the author deleting their own, because deletion is a route", async () => {
    // This assertion used to read the other way, and the argument for it was
    // sound as far as it went: a circulation carries its OWN copy of the
    // items, so deleting the library document cannot take a sent worksheet
    // away from anybody. What it missed is that the document is not the whole
    // of the deletion. The question and option images live in Storage under
    // `worksheet-images/{worksheetId}` and rules cannot cascade, and a
    // worksheet with an open circulation has to be refused, which is a
    // cross-collection question rules cannot ask. Both are the route's job,
    // on the `events` precedent, so the client delete closed.
    //
    // The author is still the person who may delete it. That permission moved
    // into DELETE /api/worksheets/{worksheetId}, where it can be enforced
    // together with the two checks above rather than beside them. The full
    // refusal set, admins included, is in member-records.test.mjs.
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("committee1");
    await assertFails(db.collection("worksheets").doc("w1").delete());
  });

  it("refuses another committee member deleting it", async () => {
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("committee2");
    await assertFails(db.collection("worksheets").doc("w1").delete());
  });

  it("refuses a non-author committee member reading a PRIVATE worksheet", async () => {
    await seedCast();
    await seedWorksheet("w-private", { private: true, authorUid: "committee1" });
    const db = await asUser("committee2");
    await assertFails(db.collection("worksheets").doc("w-private").get());
  });

  it("lets the author read their own private worksheet", async () => {
    await seedCast();
    await seedWorksheet("w-private", { private: true, authorUid: "committee1" });
    const db = await asUser("committee1");
    await assertSucceeds(db.collection("worksheets").doc("w-private").get());
  });

  it("lets an admin read anybody's private worksheet", async () => {
    await seedCast();
    await seedWorksheet("w-private", { private: true, authorUid: "committee1" });
    const db = await asUser("admin1");
    await assertSucceeds(db.collection("worksheets").doc("w-private").get());
  });

  it("refuses a plain member reading a public one (the library is not a member surface)", async () => {
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("member1");
    await assertFails(db.collection("worksheets").doc("w1").get());
  });

  it("refuses a DEMOTED author, on read, update and delete of their own", async () => {
    // Authorship is not a standing grant. The author branch is the one branch
    // of these three rules that nothing else re-tests, so with the role check
    // left out of isAuthor() a committee member moved back to `member` kept
    // read, retitle, rewrite-the-items and delete on a document the whole
    // committee browses. Losing the role has to take the worksheet with it.
    await seedCast();
    await seedWorksheet("w-exauthor", { authorUid: "member1" });
    const db = await asUser("member1");
    await assertFails(db.collection("worksheets").doc("w-exauthor").get());
    await assertFails(
      db.collection("worksheets").doc("w-exauthor").update({ title: "Mine again" }),
    );
    await assertFails(db.collection("worksheets").doc("w-exauthor").delete());
  });

  it("refuses a REJECTED author the same three ways", async () => {
    // The harder case of the same rule: an account turned away outright still
    // has a uid, and every worksheet it wrote still carries that uid.
    await seedCast();
    await seedWorksheet("w-exauthor", { authorUid: "rejected1" });
    const db = await asUser("rejected1");
    await assertFails(db.collection("worksheets").doc("w-exauthor").get());
    await assertFails(db.collection("worksheets").doc("w-exauthor").update({ title: "Mine" }));
    await assertFails(db.collection("worksheets").doc("w-exauthor").delete());
  });

  it("gives the circulateWorksheet holder NOTHING here on its own", async () => {
    // The permission gates a route, not the library. A member who holds it but
    // is not on the committee still cannot browse or author worksheets, which
    // is what keeps "grant somebody the ability to send" from being "grant
    // somebody the committee's whole authoring surface".
    await seedCast();
    await seedWorksheet("w1");
    const db = await asUser("circulator");
    await assertFails(db.collection("worksheets").doc("w1").get());
    await assertFails(
      db.collection("worksheets").doc("w-new").set(worksheetDoc({ authorUid: "circulator" })),
    );
  });
});

// ---------------------------------------------------------------------------
// worksheetFolders
// ---------------------------------------------------------------------------

describe("worksheetFolders: shelves in the library", () => {
  function folderDoc(overrides = {}) {
    return {
      name: "Fellowship",
      createdByUid: "committee1",
      createdAt: new Date(),
      ...overrides,
    };
  }

  async function seedFolder(id, overrides = {}) {
    await seed(async (db) => {
      const ref = db.collection("worksheetFolders").doc(id);
      await ref.set(folderDoc(overrides));
      await ref.get();
    });
  }

  it("refuses a plain member creating one", async () => {
    await seedCast();
    const db = await asUser("member1");
    await assertFails(db.collection("worksheetFolders").doc("f-new").set(folderDoc()));
  });

  it("refuses a plain member reading them", async () => {
    await seedCast();
    await seedFolder("f1");
    const db = await asUser("member1");
    await assertFails(db.collection("worksheetFolders").doc("f1").get());
  });

  it("lets a NON-SU committee member create, update and delete one", async () => {
    // No ownership gate on purpose: a folder is shared furniture, and an author
    // who leaves the committee must not strand a shelf nobody can rename.
    await seedCast();
    const db = await asUser("committee1");
    await assertSucceeds(db.collection("worksheetFolders").doc("f-new").set(folderDoc()));
    await assertSucceeds(
      db.collection("worksheetFolders").doc("f-new").update({ name: "Fellowship 2026" }),
    );
    await assertSucceeds(db.collection("worksheetFolders").doc("f-new").delete());
  });

  it("lets a committee member rename somebody else's folder", async () => {
    await seedCast();
    await seedFolder("f1", { createdByUid: "su1" });
    const db = await asUser("committee2");
    await assertSucceeds(db.collection("worksheetFolders").doc("f1").update({ name: "Renamed" }));
  });

  it("refuses a name over the 60-character cap", async () => {
    await seedCast();
    const db = await asUser("committee1");
    await assertFails(
      db.collection("worksheetFolders").doc("f-new").set(folderDoc({ name: "x".repeat(61) })),
    );
  });

  it("refuses an empty name (an unnamed shelf is unreachable in the UI)", async () => {
    await seedCast();
    const db = await asUser("committee1");
    await assertFails(
      db.collection("worksheetFolders").doc("f-new").set(folderDoc({ name: "" })),
    );
  });
});

// ---------------------------------------------------------------------------
// circulations
// ---------------------------------------------------------------------------

/**
 * The standing fixture for every circulation test: one circulation with a
 * sender, a named reviewer and one recipient who has a response document.
 *
 * `outsider` (committee2) is on nobody's list, which is the persona that
 * proves committee membership alone buys nothing here.
 */
function circulationDoc(overrides = {}) {
  return {
    worksheetId: "w1",
    title: "Reading reflection",
    description: "",
    items: [],
    senderUid: "circulator",
    authorUid: "committee1",
    reviewerUids: ["su1"],
    staffUids: ["circulator", "committee1", "su1"],
    reviewConfig: {
      perQuestionFeedback: true,
      perQuestionScoring: false,
      overallFeedback: true,
      returnToRecipient: true,
    },
    notifications: {
      assigned: { email: true, push: true },
      dueSoon: { email: true, push: false },
      submitted: { email: true, push: true },
      feedbackReturned: { email: true, push: true },
      copyEdited: { email: false, push: false },
    },
    dueDate: null,
    status: "open",
    anonymity: "named",
    source: { kind: "worksheet" },
    recipientCount: 2,
    submittedCount: 0,
    reviewedCount: 0,
    itemsEditedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    closedAt: null,
    ...overrides,
  };
}

function responseDoc(uid, overrides = {}) {
  return {
    uid,
    circulationId: "circ1",
    taskId: `task-${uid}`,
    state: "not-opened",
    answers: {},
    progress: { answered: 0, total: 3, requiredAnswered: 0, required: 2 },
    activity: { firstOpenedAt: null, pageOpens: 0, activeMs: 0, lastActiveAt: null },
    submittedAt: null,
    reviewedAt: null,
    returned: null,
    unfrozenAt: null,
    unfrozenByUid: null,
    addedAt: new Date(),
    addedByUid: "circulator",
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Seeds circ1 with two recipients. `recipA` is the one every recipient test
 * acts as; `recipB` exists so "one recipient cannot read another's answers" is
 * a real read of a real document rather than a read of a missing one.
 */
async function seedCirculation(overrides = {}, responseOverrides = {}) {
  await seedUser("recipA", { role: "committee", suRecognised: false });
  await seedUser("recipB", { role: "committee", suRecognised: false });
  await seed(async (db) => {
    const ref = db.collection("circulations").doc("circ1");
    await ref.set(circulationDoc(overrides));
    await ref.collection("responses").doc("recipA").set(responseDoc("recipA", responseOverrides));
    await ref.collection("responses").doc("recipB").set(responseDoc("recipB"));
    await ref.get();
  });
}

describe("circulations: the sent copy", () => {
  it("refuses a get by a committee member who is neither staff nor a recipient", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("committee2");
    await assertFails(db.collection("circulations").doc("circ1").get());
  });

  it("refuses a get by a signed-out visitor", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asAnon();
    await assertFails(db.collection("circulations").doc("circ1").get());
  });

  it("lets a staff member get it", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertSucceeds(db.collection("circulations").doc("circ1").get());
  });

  it("lets a recipient get it, proved by their own response document", async () => {
    // There is no roster array on the circulation to test against: recipients
    // arrive in batches over time, and a growing array on the parent would be a
    // contended write on every add. The exists() is on a path built from the
    // caller's OWN uid, so it cannot be aimed at anybody else's.
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    await assertSucceeds(db.collection("circulations").doc("circ1").get());
  });

  it("SHAPE RULE: a staff list carrying array-contains on staffUids is allowed", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertSucceeds(
      db.collection("circulations").where("staffUids", "array-contains", "su1").get(),
    );
  });

  it("SHAPE RULE: the same staff list WITHOUT that clause is refused", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertFails(db.collection("circulations").get());
  });

  it("refuses a recipient's unfiltered list of circulations", async () => {
    // The recipient branch is an exists(), which costs one document access, and
    // a list evaluates the rule per candidate against a budget of twenty. A
    // recipient branch on the list rule would make any query over twenty
    // circulations fail wholesale. Recipients reach theirs from their task.
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    await assertFails(db.collection("circulations").get());
  });

  it("CHARACTERISATION: a recipient MAY run the staff-shaped list, and it returns nothing", async () => {
    // Not a hole, and worth writing down so nobody "fixes" it. Firestore
    // discharges `request.auth.uid in resource.data.staffUids` from the
    // array-contains clause, so the query is legal for anyone who aims it at
    // their OWN uid, and by construction it can only match circulations that
    // person is already staff on. A recipient running it gets an empty result,
    // which is the correct answer rather than a leak. Aiming it at somebody
    // else's uid does not discharge the clause and is refused, which is the
    // half that matters; it is pinned below.
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    const snap = await assertSucceeds(
      db.collection("circulations").where("staffUids", "array-contains", "recipA").get(),
    );
    if (snap.size !== 0) {
      throw new Error(`expected the recipient's staff-shaped list to be empty, got ${snap.size}`);
    }
  });

  it("refuses a list aimed at SOMEBODY ELSE's uid", async () => {
    // The clause only discharges the rule when the value is the caller's own
    // uid. Without this, "list what su1 is staff on" would be a way for any
    // signed-in account to enumerate another person's circulations.
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    await assertFails(
      db.collection("circulations").where("staffUids", "array-contains", "su1").get(),
    );
  });

  it("refuses a client create, for an ADMIN", async () => {
    await seedCast();
    const db = await asUser("admin1");
    await assertFails(db.collection("circulations").doc("circ-new").set(circulationDoc()));
  });

  it("refuses a client create, for the circulateWorksheet holder", async () => {
    // The permission is checked by POST /api/worksheets/circulations, which is
    // also the only thing that can write staffUids honestly and mint the
    // per-recipient response documents and tasks. A client create rule would be
    // a way to name other people as staff on a circulation they never saw.
    await seedCast();
    const db = await asUser("circulator");
    await assertFails(db.collection("circulations").doc("circ-new").set(circulationDoc()));
  });

  it("refuses a client create, for a staff member of an existing circulation", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertFails(db.collection("circulations").doc("circ-new").set(circulationDoc()));
  });

  it("refuses a client delete, admins included", async () => {
    await seedCast();
    await seedCirculation();
    const admin = await asUser("admin1");
    await assertFails(admin.collection("circulations").doc("circ1").delete());
    const staff = await asUser("su1");
    await assertFails(staff.collection("circulations").doc("circ1").delete());
  });

  it("lets staff edit the copy: title, description, items, dueDate, itemsEditedAt", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertSucceeds(
      db.collection("circulations").doc("circ1").update({
        title: "Reading reflection (corrected)",
        description: "Two questions now.",
        items: [{ kind: "pageBreak", id: "pb_1" }],
        dueDate: new Date("2026-10-01T12:00:00Z"),
        itemsEditedAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  });

  it("lets staff change the review config and the notification switches", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertSucceeds(
      db.collection("circulations").doc("circ1").update({
        reviewConfig: {
          perQuestionFeedback: false,
          perQuestionScoring: true,
          overallFeedback: true,
          returnToRecipient: false,
        },
        notifications: {
          assigned: { email: false, push: false },
          dueSoon: { email: false, push: false },
          submitted: { email: true, push: true },
          feedbackReturned: { email: true, push: true },
          copyEdited: { email: true, push: false },
        },
      }),
    );
  });

  it("refuses staff rewriting staffUids (self-promotion onto somebody else's send)", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertFails(
      db
        .collection("circulations")
        .doc("circ1")
        .update({ staffUids: ["circulator", "committee1", "su1", "committee2"] }),
    );
  });

  it("refuses staff rewriting reviewerUids", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertFails(
      db.collection("circulations").doc("circ1").update({ reviewerUids: ["committee2"] }),
    );
  });

  it("refuses staff rewriting the counters the sender reads", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertFails(
      db.collection("circulations").doc("circ1").update({ recipientCount: 99 }),
    );
    await assertFails(
      db.collection("circulations").doc("circ1").update({ submittedCount: 99 }),
    );
  });

  it("refuses staff closing it client-side (status is the close route's)", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertFails(db.collection("circulations").doc("circ1").update({ status: "closed" }));
  });

  it("refuses a recipient updating anything on it", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    await assertFails(db.collection("circulations").doc("circ1").update({ title: "Mine" }));
  });

  it("refuses staff storing more than 100 items on the copy", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertFails(db.collection("circulations").doc("circ1").update({ items: tooManyItems() }));
  });

  it("CHARACTERISATION: staff may still edit a CLOSED circulation's copy", async () => {
    // Nothing in this block keys off `status`, and that is a decision rather
    // than an omission: closing stops SUBMISSIONS, and submission is a route.
    // Staff fixing a typo on a closed copy changes nothing a recipient can
    // act on. Pinned so that freezing the whole document later is a visible
    // change to this test rather than a surprise to whoever relied on it.
    await seedCast();
    await seedCirculation({ status: "closed", closedAt: new Date() });
    const db = await asUser("su1");
    await assertSucceeds(
      db.collection("circulations").doc("circ1").update({ title: "Reading reflection (final)" }),
    );
  });
});

// ---------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------

describe("circulations/{id}/responses: one per recipient, keyed by their uid", () => {
  it("lets a recipient read their own", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    await assertSucceeds(
      db.collection("circulations").doc("circ1").collection("responses").doc("recipA").get(),
    );
  });

  it("refuses a recipient reading another recipient's", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    await assertFails(
      db.collection("circulations").doc("circ1").collection("responses").doc("recipB").get(),
    );
  });

  it("lets staff read any of them", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertSucceeds(
      db.collection("circulations").doc("circ1").collection("responses").doc("recipA").get(),
    );
  });

  it("lets staff list the whole subcollection (one parent get, whatever the row count)", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertSucceeds(
      db.collection("circulations").doc("circ1").collection("responses").get(),
    );
  });

  it("refuses a recipient listing the subcollection", async () => {
    // Their branch is per-document-id, and a query does not constrain the id,
    // so the listen cannot be proved and is refused. That is the intended
    // shape: one recipient must never enumerate what the others wrote.
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    await assertFails(db.collection("circulations").doc("circ1").collection("responses").get());
  });

  it("refuses a committee member who is neither staff nor a recipient", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("committee2");
    await assertFails(
      db.collection("circulations").doc("circ1").collection("responses").doc("recipA").get(),
    );
    await assertFails(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("responses")
        .doc("recipA")
        .update({ answers: { q1: { type: "text", text: "not mine" } } }),
    );
  });

  it("lets a recipient autosave answers, progress, activity and updatedAt", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    await assertSucceeds(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("responses")
        .doc("recipA")
        .update({
          answers: { q1: { type: "text", text: "A first pass." } },
          progress: { answered: 1, total: 3, requiredAnswered: 1, required: 2 },
          activity: {
            firstOpenedAt: new Date(),
            pageOpens: 1,
            activeMs: 30000,
            lastActiveAt: new Date(),
          },
          updatedAt: new Date(),
        }),
    );
  });

  it("refuses an autosave carrying more than 100 answers", async () => {
    // hasOnly() bounds WHICH keys may appear on the document, not how many
    // sit inside `answers`, and the answers map is the one thing on it a
    // recipient writes freely. A hundred matches the hundred items a worksheet
    // may hold, so no honest response can reach it.
    await seedCast();
    await seedCirculation();
    const answers = {};
    for (let i = 0; i < 101; i += 1) answers[`q${i}`] = { type: "text", text: "x" };
    const db = await asUser("recipA");
    await assertFails(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("responses")
        .doc("recipA")
        .update({ answers, updatedAt: new Date() }),
    );
  });

  it("keeps the autosave working on a response with no `answers` key stored", async () => {
    // The cap reads `.get('answers', {})` rather than the field bare, and this
    // is why: a response document written without the key (an Admin SDK write
    // in a route, a hand-repaired document) would otherwise make the
    // recipient's very first autosave deny by EVALUATION ERROR, on the one
    // client-direct write in the whole answering path.
    await seedCast();
    await seedCirculation();
    await seed(async (db) => {
      const ref = db
        .collection("circulations")
        .doc("circ1")
        .collection("responses")
        .doc("recipA");
      const doc = responseDoc("recipA");
      delete doc.answers;
      await ref.set(doc);
      await ref.get();
    });
    const db = await asUser("recipA");
    await assertSucceeds(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("responses")
        .doc("recipA")
        .update({ answers: { q1: { type: "text", text: "A first pass." } }, updatedAt: new Date() }),
    );
  });

  it("CHARACTERISATION: a recipient may still autosave on a CLOSED circulation", async () => {
    // The response rule keys off the response's own `state`, never the
    // parent's `status`, so an autosave the client had already queued when the
    // close landed still lands. Deliberate: refusing it would turn a race into
    // a permission error on somebody's unsaved work, and it cannot make a
    // closed circulation accept a SUBMISSION, which is a route.
    await seedCast();
    await seedCirculation({ status: "closed", closedAt: new Date() });
    const db = await asUser("recipA");
    await assertSucceeds(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("responses")
        .doc("recipA")
        .update({ answers: { q1: { type: "text", text: "Late." } }, updatedAt: new Date() }),
    );
  });

  it("lets a recipient move not-opened to started on first open", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    await assertSucceeds(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("responses")
        .doc("recipA")
        .update({ state: "started", updatedAt: new Date() }),
    );
  });

  it("refuses a recipient declaring themselves submitted", async () => {
    // Submitting re-derives progress, moves the task, bumps a counter and
    // notifies the reviewers. None of that is something a client can do
    // atomically, so it is a route and the state is refused here.
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    await assertFails(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("responses")
        .doc("recipA")
        .update({ state: "submitted" }),
    );
  });

  it("refuses a recipient writing taskId, returned, submittedAt or the unfreeze stamps", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    const ref = db.collection("circulations").doc("circ1").collection("responses").doc("recipA");
    await assertFails(ref.update({ taskId: "task-someone-else" }));
    // `returned` is the staff feedback copied onto this document. A recipient
    // able to write it could author their own feedback.
    await assertFails(
      ref.update({
        returned: {
          perQuestion: { q1: { feedback: "Excellent" } },
          overall: "Excellent",
          returnedAt: new Date(),
          returnedByUid: "su1",
        },
      }),
    );
    await assertFails(ref.update({ submittedAt: new Date() }));
    await assertFails(ref.update({ unfrozenAt: new Date(), unfrozenByUid: "recipA" }));
  });

  it("FROZEN: refuses a recipient's write once the STORED state is submitted", async () => {
    // The gate reads `resource.data.state`, not the incoming one. A recipient
    // who could satisfy it with the value they are writing would simply put
    // 'started' back over 'submitted' and edit answers the reviewers had
    // already read.
    await seedCast();
    await seedCirculation({}, { state: "submitted", submittedAt: new Date() });
    const db = await asUser("recipA");
    const ref = db.collection("circulations").doc("circ1").collection("responses").doc("recipA");
    await assertFails(ref.update({ answers: { q1: { type: "text", text: "second thoughts" } } }));
    await assertFails(ref.update({ state: "started" }));
  });

  it("FROZEN: refuses a recipient's write once the STORED state is reviewed", async () => {
    await seedCast();
    await seedCirculation({}, { state: "reviewed", reviewedAt: new Date() });
    const db = await asUser("recipA");
    await assertFails(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("responses")
        .doc("recipA")
        .update({ answers: { q1: { type: "text", text: "second thoughts" } } }),
    );
  });

  it("refuses a client create, for the recipient and for an admin", async () => {
    await seedCast();
    await seedCirculation();
    const recipient = await asUser("recipA");
    await assertFails(
      recipient
        .collection("circulations")
        .doc("circ1")
        .collection("responses")
        .doc("recipA-2")
        .set(responseDoc("recipA-2")),
    );
    const admin = await asUser("admin1");
    await assertFails(
      admin
        .collection("circulations")
        .doc("circ1")
        .collection("responses")
        .doc("gatecrasher")
        .set(responseDoc("gatecrasher")),
    );
  });

  it("refuses a client delete, for the recipient, for staff and for an admin", async () => {
    await seedCast();
    await seedCirculation();
    for (const uid of ["recipA", "su1", "admin1"]) {
      const db = await asUser(uid);
      await assertFails(
        db.collection("circulations").doc("circ1").collection("responses").doc("recipA").delete(),
      );
    }
  });

  it("lets an admin read a response even when they are not staff", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("admin1");
    await assertSucceeds(
      db.collection("circulations").doc("circ1").collection("responses").doc("recipA").get(),
    );
  });
});

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

describe("circulations/{id}/reviews: staff only, because scores live here", () => {
  function reviewDoc(overrides = {}) {
    return {
      perQuestion: { q1: { feedback: "Good, but say why.", score: 7 } },
      overall: "Solid first attempt.",
      updatedAt: new Date(),
      updatedByUid: "su1",
      ...overrides,
    };
  }

  async function seedReview(uid = "recipA", overrides = {}) {
    await seed(async (db) => {
      const ref = db
        .collection("circulations")
        .doc("circ1")
        .collection("reviews")
        .doc(uid);
      await ref.set(reviewDoc(overrides));
      await ref.get();
    });
  }

  it("lets staff create a review", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertSucceeds(
      db.collection("circulations").doc("circ1").collection("reviews").doc("recipA").set(reviewDoc()),
    );
  });

  it("lets staff update one and read it back", async () => {
    await seedCast();
    await seedCirculation();
    await seedReview();
    const db = await asUser("su1");
    await assertSucceeds(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("reviews")
        .doc("recipA")
        .update({ overall: "Revised.", updatedAt: new Date() }),
    );
    await assertSucceeds(
      db.collection("circulations").doc("circ1").collection("reviews").doc("recipA").get(),
    );
  });

  it("REFUSES THE RECIPIENT READING THEIR OWN REVIEW", async () => {
    // The single most important line in this file. Scores are staff-only, and
    // the reason they live in a separate subcollection rather than on the
    // response is that this is then ONE rule instead of two that have to agree
    // forever. Returning feedback is a route, which copies only the parts the
    // toggles allow and never a score.
    await seedCast();
    await seedCirculation();
    await seedReview();
    const db = await asUser("recipA");
    await assertFails(
      db.collection("circulations").doc("circ1").collection("reviews").doc("recipA").get(),
    );
  });

  it("refuses the recipient writing their own review", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("recipA");
    await assertFails(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("reviews")
        .doc("recipA")
        .set(reviewDoc({ perQuestion: { q1: { score: 100 } }, updatedByUid: "recipA" })),
    );
  });

  it("refuses a committee member who is not staff on this circulation", async () => {
    await seedCast();
    await seedCirculation();
    await seedReview();
    const db = await asUser("committee2");
    await assertFails(
      db.collection("circulations").doc("circ1").collection("reviews").doc("recipA").get(),
    );
  });

  it("refuses overall feedback over the 4000-character cap", async () => {
    // hasOnly() fixes WHICH keys may appear, not how big they are. Without the
    // cap a reviewer could store megabyte documents, one per recipient.
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertFails(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("reviews")
        .doc("recipA")
        .set(reviewDoc({ overall: "x".repeat(4001) })),
    );
  });

  it("refuses more than 100 perQuestion entries", async () => {
    // `overall` is one text box and its cap is exact; `perQuestion` is a map
    // and the cap is on the number of entries, matching the hundred items a
    // worksheet may hold. Rules cannot walk a map's values, so the per-entry
    // budgets (CIRCULATION_LIMITS.feedback, the 0..100 score band) are the
    // editor's and the return route's job, not this rule's.
    await seedCast();
    await seedCirculation();
    const perQuestion = {};
    for (let i = 0; i < 101; i += 1) perQuestion[`q${i}`] = { feedback: "ok" };
    const db = await asUser("su1");
    await assertFails(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("reviews")
        .doc("recipA")
        .set(reviewDoc({ perQuestion })),
    );
  });

  it("refuses a staff member filing a review under a COLLEAGUE's uid", async () => {
    // A review is the record of a judgement about a person, which is why the
    // delete below is admin-only. An unpinned stamp would let one reviewer
    // sign another's name to that judgement, and the name is quoted back to
    // the recipient when the feedback is returned.
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertFails(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("reviews")
        .doc("recipA")
        .set(reviewDoc({ updatedByUid: "committee1" })),
    );
  });

  it("refuses a review with no updatedByUid at all", async () => {
    // The pin is written `.get('updatedByUid', '') == request.auth.uid`, so a
    // missing stamp is refused by decision rather than by evaluation error.
    // Unsigned notes would be the same problem as mis-signed ones.
    await seedCast();
    await seedCirculation();
    const doc = reviewDoc();
    delete doc.updatedByUid;
    const db = await asUser("su1");
    await assertFails(
      db.collection("circulations").doc("circ1").collection("reviews").doc("recipA").set(doc),
    );
  });

  it("refuses a key outside the declared shape", async () => {
    await seedCast();
    await seedCirculation();
    const db = await asUser("su1");
    await assertFails(
      db
        .collection("circulations")
        .doc("circ1")
        .collection("reviews")
        .doc("recipA")
        .set(reviewDoc({ visibleToRecipient: true })),
    );
  });

  it("refuses a non-admin staff member deleting a review", async () => {
    // A review is the record of a judgement about a person. One reviewer
    // deleting another's notes mid-circulation is not a correction, it is a
    // disagreement resolved by whoever clicks first.
    await seedCast();
    await seedCirculation();
    await seedReview();
    const db = await asUser("su1");
    await assertFails(
      db.collection("circulations").doc("circ1").collection("reviews").doc("recipA").delete(),
    );
  });

  it("lets an admin delete one", async () => {
    await seedCast();
    await seedCirculation();
    await seedReview();
    const db = await asUser("admin1");
    await assertSucceeds(
      db.collection("circulations").doc("circ1").collection("reviews").doc("recipA").delete(),
    );
  });
});
