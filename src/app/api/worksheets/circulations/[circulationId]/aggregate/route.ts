import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  CIRCULATIONS_COLLECTION,
  isTerminalResponseState,
  normalizeResponse,
  RESPONSES_SUBCOLLECTION,
  type ResponseDoc,
} from "@/lib/firestore/circulations";
import { questionsOf, ratingScaleOf, answerIsEmpty } from "@/lib/firestore/worksheets";
import { answersFor, countOptions } from "@/features/worksheets/aggregate";
import { isAddressableId, isCirculationStaff, loadCirculation } from "@/lib/worksheets/access";
import { scanResponses } from "@/lib/worksheets/responseScan";

/**
 * COUNTS FOR ONE QUESTION.
 *
 * ── THIS IS THE ONLY PATH BY WHICH A RECIPIENT LEARNS ANYTHING ABOUT ────────
 * ── ANOTHER RECIPIENT, AND IT HANDS OVER COUNTS WITH NO NAMES ──────────────
 * Everywhere else in the feature a recipient is sealed off from the others by
 * construction: `circulations/{id}/responses/{uid}` admits the owner BY
 * DOCUMENT ID, which is not a thing a query can constrain, so a recipient's
 * list of the subcollection is refused outright while their get of their own
 * response is allowed. That shape is what makes "one recipient can never
 * enumerate what the others wrote" a property of the rules rather than a
 * promise made by a page.
 *
 * A poll breaks that seal ON PURPOSE and only this far. The body of this
 * response is a question id, a total and a map from option id to a NUMBER.
 * There is no uid in it, no name, no timestamp and no per-person anything, and
 * that is by construction rather than by filtering: the handler never builds a
 * per-person structure it then has to remember to strip. A recipient who
 * asked for a poll with two votes cannot tell WHO cast them, and a poll with
 * one vote tells them only what they could already work out from being the
 * only other person on it.
 *
 * The gate below therefore has two halves that must both hold for a recipient:
 * the question is a POLL (the one type whose author opted into an audience for
 * its aggregate), and the poll's `resultsVisibility` admits them at their
 * current state. Every other question type, and a poll set to `staff`, answer
 * 403 to a recipient however they spell the request. Staff pass both halves by
 * being staff: this is their own circulation's data.
 *
 * ── "BEFORE-SUBMIT" MEANS VOTE FIRST, THEN SEE ──────────────────────────────
 * The setting is named for the SUBMISSION it does not wait for, not for the
 * answer it does. A recipient reading the tally before they have picked
 * anything is reading a primed vote into existence: the thing they came to
 * give an opinion on has already told them what the room thinks. So this arm
 * asks for a stored, non-empty answer to THIS question, and the respond page's
 * poll panel keeps the same rule on screen ("Results appear once you answer"),
 * which is the sentence wave 1 put in front of members. A frozen response
 * passes without one: once somebody has submitted there is nothing left to
 * prime, and refusing a person who skipped an optional poll would be a
 * permanent refusal for no gain.
 *
 * ── A GET, BECAUSE IT WRITES NOTHING ────────────────────────────────────────
 * No audit row, no counter, no stamp. The export beside it is a POST for
 * exactly the opposite reason (it logs, and a GET is prefetched and retried),
 * and the difference between the two is worth keeping visible. Nothing here
 * calls `assertNotImpersonating()` and nothing should: reading what a member
 * sees is what view-as exists for, and `tests/impersonation-guard.test.mjs`
 * only requires the guard on mutating handlers.
 *
 * ── IN-PROGRESS ANSWERS COUNT ───────────────────────────────────────────────
 * A vote is a vote the moment it is stored, not when the worksheet around it
 * is submitted. Counting only submitted responses would make a live poll read
 * as empty for as long as anybody was still working, which is precisely the
 * window a "before-submit" poll exists to be read in. The staff view says so
 * on screen ("includes in-progress answers"); the recipient's bars say the
 * same thing by being live.
 *
 * ── WHAT THIS COSTS, AND WHAT WOULD FIX IT ──────────────────────────────────
 * Counting one question reads every response document on the circulation, so a
 * hundred recipients with three live polls is three hundred document reads per
 * person who opens the page. That is affordable at committee scale (a
 * circulation is tens of people, and the panel fetches once per stored answer
 * rather than on a timer) and it is the honest place to say it will not scale
 * to a cohort. A projection would not help: `select()` cuts the bytes on the
 * wire, not the number of documents billed. The fix, when a circulation is
 * ever large enough to need one, is a counter per option maintained by the
 * write path, and it is deliberately not built here: a counter that drifts
 * from the answers is a poll that lies, and nothing in v1 justifies that risk.
 */

/**
 * The wire shape. Deliberately narrow: see the module comment.
 *
 * Two things in here are wider than today's only caller needs, and both are
 * deliberate rather than left over. `type` is what tells a client WHICH arm it
 * was handed without re-deriving it from a question it may not hold (the poll
 * panel does hold the question and ignores the field; a staff tool asking for
 * a question id it was given would not). The `distribution` and `mean` arm has
 * no caller at all yet, because the staff aggregate view counts the response
 * documents it already holds rather than asking this route: it exists so a
 * rating asked of somebody who cannot list the subcollection has an answer,
 * and so the route's shape does not have to change the day one does.
 */
type AggregateBody = {
  questionId: string;
  type: string;
  /** People who gave this question a non-empty answer. The denominator. */
  total: number;
  /** Choice-shaped questions: how many chose each option id. */
  counts?: Record<string, number>;
  /** Rating questions: how many gave each value, keyed by the value. */
  distribution?: Record<string, number>;
  /** Rating questions. Null over an empty set; never 0. */
  mean?: number | null;
};

export async function GET(
  req: Request,
  ctx: { params: Promise<{ circulationId: string }> },
) {
  const { circulationId } = await ctx.params;
  if (!isAddressableId(circulationId)) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const questionId = (new URL(req.url).searchParams.get("questionId") ?? "").trim();
  if (!questionId) {
    return NextResponse.json({ error: "Name the question to count." }, { status: 400 });
  }

  const circulation = await loadCirculation(db, circulationId);
  if (!circulation) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }

  // THE GATE BEFORE THE LOOKUP, for a non-staff caller. Answering "no such
  // question" to somebody who has no business here at all would let any signed
  // in member tell a real question id from an invented one by the error string,
  // which is a description of a document they were never sent. Staff get the
  // 404 they are owed (they are editing this worksheet and a wrong id is a bug
  // they need to see); everybody else gets the one "Forbidden" the refusals
  // below are all careful to be.
  const isStaff = isCirculationStaff(circulation, actor);
  const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let own: ResponseDoc | null = null;
  if (!isStaff) {
    // A recipient proves themselves the same way the Firestore rule does: with
    // the one document that exists for exactly that reason, ADDRESSED at their
    // own uid. There is no uid in the request, so this cannot be aimed at
    // somebody else's response however the URL is spelled.
    const ownSnap = await db
      .collection(CIRCULATIONS_COLLECTION)
      .doc(circulationId)
      .collection(RESPONSES_SUBCOLLECTION)
      .doc(actor.uid)
      .get();
    if (!ownSnap.exists) return forbidden();
    own = normalizeResponse(ownSnap.id, ownSnap.data() ?? {});
  }

  const question = questionsOf(circulation.items).find((q) => q.id === questionId);
  if (!question) {
    return isStaff
      ? NextResponse.json({ error: "No such question" }, { status: 404 })
      : forbidden();
  }

  if (own) {
    // ONE refusal for every way a recipient can fail this: the question is not
    // a poll, the poll is staff-only, the results are held until they submit,
    // or they have not answered it yet. Telling them apart would let a
    // recipient walk a worksheet's question ids and learn which are polls and
    // how each is configured, which is a description of a document they are
    // only meant to answer.
    const visibility = question.poll?.resultsVisibility;
    const frozen = isTerminalResponseState(own.state);
    const ownAnswer = own.answers[questionId];
    const answered = ownAnswer !== undefined && !answerIsEmpty(ownAnswer);
    const allowed =
      question.type === "poll" &&
      ((visibility === "before-submit" && (answered || frozen)) ||
        (visibility === "after-submit" && frozen));
    if (!allowed) return forbidden();
  }

  let responses;
  try {
    responses = await scanResponses(db, circulationId);
  } catch (err) {
    console.error("[worksheets aggregate] read failed", circulationId, questionId, err);
    return NextResponse.json({ error: "Couldn't count those answers." }, { status: 500 });
  }

  const answers = answersFor(question, responses);

  if (question.type === "rating") {
    const scale = ratingScaleOf(question);
    const distribution: Record<string, number> = {};
    for (let value = 1; value <= scale; value += 1) distribution[String(value)] = 0;
    let total = 0;
    let sum = 0;
    for (const { answer } of answers) {
      if (!answer || answer.type !== "rating" || answerIsEmpty(answer)) continue;
      total += 1;
      sum += answer.value;
      const key = String(answer.value);
      // A value above the scale is a rating given before the author shrank it.
      // It is counted in the mean and gets a key of its own rather than being
      // folded into the top band, which would move somebody's answer.
      distribution[key] = (distribution[key] ?? 0) + 1;
    }
    const body: AggregateBody = {
      questionId,
      type: question.type,
      total,
      distribution,
      mean: total > 0 ? sum / total : null,
    };
    return NextResponse.json(body);
  }

  if (
    question.type === "singleChoice" ||
    question.type === "multipleChoice" ||
    question.type === "poll"
  ) {
    const { counts, respondents } = countOptions(answers);
    // Every current option appears, at zero if nobody picked it, so the caller
    // draws a complete set of bars rather than a chart that grows a row as
    // votes arrive. Ids no longer on the question survive in `counts` too: the
    // caller buckets them as "(option removed)" rather than losing the answers.
    const full: Record<string, number> = {};
    for (const option of question.options ?? []) full[option.id] = 0;
    for (const [optionId, count] of Object.entries(counts)) full[optionId] = count;
    const body: AggregateBody = {
      questionId,
      type: question.type,
      total: respondents,
      counts: full,
    };
    return NextResponse.json(body);
  }

  // Text and image questions have no counts to give, and a recipient never
  // reaches here (the gate above admits them for polls only). Staff read the
  // answers themselves off the response documents they can already see, so the
  // honest answer is how many people replied and nothing else.
  const answered = answers.filter(
    ({ answer }) => answer !== undefined && !answerIsEmpty(answer),
  ).length;
  const body: AggregateBody = { questionId, type: question.type, total: answered };
  return NextResponse.json(body);
}
