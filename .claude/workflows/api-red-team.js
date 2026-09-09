export const meta = {
  name: 'api-red-team',
  description: 'Red-team every API route changed since a git ref for missing gates, IDOR and information leakage, then adversarially verify each finding',
  whenToUse: 'Before promoting dev to main, or after a change to any route under src/app/api. Pass the ref to diff against: args = { ref: "origin/main" }.',
  phases: [
    { title: 'Scope', detail: 'one scout lists the routes and helpers changed since the ref' },
    { title: 'Find', detail: 'one reviewer per batch of changed routes, reading handlers and the helpers they call' },
    { title: 'Verify', detail: 'one skeptic per medium or high finding, trying to refute it' },
  ],
}

// The standing red team, saved. This is the pass that ran over every route on
// 8 September 2026 (22 agents, 13 confirmed findings), narrowed to the routes
// that changed since a git ref so it can run on every promotion rather than
// once. The finder checklist, the skeptic prompt and the schemas are the same;
// the only new stage is the scout that reads the diff. A route that did not
// change is not reviewed: the guards under tests/ hold the rest of the tree.

const REF = (args && args.ref) || 'origin/main'
const BATCH = 8
const PER_BATCH_CAP = 5

const SCOPE = {
  type: 'object',
  properties: {
    routes: { type: 'array', items: { type: 'string' }, description: 'route.ts files under src/app/api changed since the ref, repo-relative' },
    helpers: { type: 'array', items: { type: 'string' }, description: 'files under src/lib changed since the ref that a route imports, repo-relative' },
    routesReachingChangedHelpers: { type: 'array', items: { type: 'string' }, description: 'unchanged route.ts files that import a changed helper' },
    note: { type: 'string' },
  },
  required: ['routes', 'helpers', 'routesReachingChangedHelpers', 'note'],
}

const FINDINGS = {
  type: 'object',
  properties: {
    routesReviewed: { type: 'array', items: { type: 'string' } },
    routesSkipped: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          route: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string', enum: ['no-auth', 'wrong-authz', 'idor', 'response-leak', 'write-scope', 'secret-handling', 'oracle', 'ordering', 'other'] },
          persona: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          attack: { type: 'string' },
        },
        required: ['route', 'severity', 'category', 'persona', 'claim', 'evidence', 'attack'],
      },
    },
  },
  required: ['routesReviewed', 'routesSkipped', 'findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    decidingLine: { type: 'string' },
    reasoning: { type: 'string' },
  },
  required: ['verdict', 'decidingLine', 'reasoning'],
}

const GROUND_TRUTH = `Read these FIRST, once, for ground truth on who may see what:
- CLAUDE.md sections "Roles and access", "Task visibility model", "Data model (Firestore)" (roles pending/member/committee/admin/rejected; suRecognised splits committee; the permissions map; attendee PII in eventRsvps is SU-recognised committee + admin only; worksheet reviews and scores never reach a recipient; circulations key off staffUids; applications belong to their applicant).
- src/lib/firebase/session.ts (getCurrentUser), src/lib/firebase/pageGates.ts, src/lib/firebase/eligibility.ts (being named on a document is not a standing grant; isNamedWithStanding re-checks the live bar), src/proxy.ts (a cookie PRESENCE check plus the encoded-separator refusal, not authorisation), src/lib/firebase/impersonation.ts.
- docs/testing.md, "The wider family": the guards that already hold a class closed. A finding that one of them would catch is still a finding; say which guard should have caught it and why it did not.`

const CHECKLIST = `For EVERY route.ts in your batch, read the handler and every helper it imports (follow src/lib/** imports, they are where gates and field filtering live). Check, in this order:
1. Authentication: is the caller identified server-side (Admin SDK session cookie or a verified signed token, a verified webhook signature, the scheduler secret) BEFORE any data is read or written? A uid or email taken from the request body or query is not authentication.
2. Authorisation: does the check match the model (role, suRecognised, permissions map, ownership, staffUids, collaboratorUids, task completer/reviewer)? Admin-only actions must check role === "admin", not just a session. A uid found in a stored authority array must be re-checked against the live session through src/lib/firebase/eligibility.ts.
3. IDOR: every id in the path, query or body that names another user's object (application, response, RSVP, subscription, task, circulation) is checked against the caller's rights, not merely fetched.
4. Response leakage: list the fields the handler returns and name any the persona may not see: emails and names of other users, RSVP answers, reviewer scores or feedback before return, hidden event locations, internal flags, secrets or env values, error messages that echo stack traces or Firestore paths. A whole document (a normaliser result, snap.data()) in a response must pass through a projection that names its reader.
5. Write scope: which fields can the body set? Flag role, permissions, suRecognised, status transitions, announcement* fields, sendClaimedAt, counters, or any field the rules pin, when a non-admin can reach them through this route.
6. Secrets and tokens: compare with a constant-time compare; signed tokens verified not just decoded; webhook signature verified before the body is trusted; reCAPTCHA verified server-side on the routes CLAUDE.md says are gated; no secret echoed in a response or log.
7. Oracles and enumeration: does the response differ for an existing vs a non-existing account or email? Are unsubscribe or RSVP tokens guessable? Does an existence answer (404 vs 403 vs 400) come before the caller's right to know is checked?
8. Ordering: authentication before validation, so an unauthenticated probe gets 401 and never learns whether its input was valid.
9. Recipients: who a route contacts is the server's decision from a server-written roster, never a list the caller wrote.

Report ONLY concrete, exploitable problems: a specific persona, a specific request, and what it gets that it should not. Quote the deciding lines as file:line. Do not report style, missing tests, or theoretical hardening. Severity: high = PII or credentials exposed or an admin-only write reachable; medium = authorisation weaker than the model but limited data; low = oracle, ordering, hygiene. List every route you reviewed and any you could not.`

const scoutPrompt = () =>
  `You are scoping a security review of naisi-website (repo root is the working directory). Run \`git diff --name-only ${REF}...HEAD -- src/app/api src/lib\` (fall back to \`git diff --name-only ${REF} -- src/app/api src/lib\` if the three-dot form fails). Return: every changed route.ts under src/app/api; every changed file under src/lib; and every UNCHANGED route.ts that imports one of the changed src/lib files (grep the api tree for the import specifier). Repo-relative paths. If nothing changed, return empty lists and say so in note.`

const finderPrompt = (files) =>
  `You are red-teaming the API routes of a Next.js 16 app (naisi-website, repo root is the working directory). Your batch, and ONLY these files: ${files.join(', ')}.\n\n${GROUND_TRUTH}\n\n${CHECKLIST}`

const refutePrompt = (f) =>
  `You are the skeptic. A reviewer claims this security finding in naisi-website (repo root is the working directory):\n\nRoute: ${f.route}\nPersona: ${f.persona}\nClaim: ${f.claim}\nEvidence: ${f.evidence}\nAttack: ${f.attack}\n\nTry to REFUTE it. Read the handler and every helper it calls (src/lib/firebase/session.ts, src/lib/firebase/pageGates.ts, src/lib/firebase/eligibility.ts, src/proxy.ts, the firestore helper for the collection, any signed-token or secret helper). Ask: is there a gate earlier in the call chain the reviewer missed? Is the field actually excluded or normalised before the response? Is the token verified, not just decoded? Could that persona actually reach this route with that request? Firestore RULES do not protect a route that uses the Admin SDK, so do not refute on rules alone.\n\nVerdict "confirmed" only if you traced the request through the code and the attack works as described; "refuted" only if you can name the line that stops it; otherwise "uncertain". Name the deciding file:line.`

phase('Scope')
const scope = await agent(scoutPrompt(), { label: 'scope', phase: 'Scope', schema: SCOPE, model: 'sonnet', effort: 'low' })
if (!scope) return { error: 'the scout returned nothing', ref: REF }
const files = [...new Set([...scope.routes, ...scope.routesReachingChangedHelpers])].sort()
log(`${files.length} route file(s) to review since ${REF}; ${scope.helpers.length} changed helper(s). ${scope.note}`)
if (files.length === 0) return { ref: REF, reviewed: [], confirmed: [], uncertain: [], refuted: [], unverified: [], low: [], note: scope.note }

const batches = []
for (let i = 0; i < files.length; i += BATCH) batches.push({ key: `batch-${batches.length + 1}`, files: files.slice(i, i + BATCH) })

const results = await pipeline(
  batches,
  (b) => agent(finderPrompt(b.files), { label: `find:${b.key}`, phase: 'Find', schema: FINDINGS, model: 'opus' }),
  async (found, b) => {
    if (!found) return { group: b.key, error: 'finder returned nothing', findings: [] }
    const serious = found.findings.filter((f) => f.severity !== 'low')
    const toVerify = serious.slice(0, PER_BATCH_CAP)
    if (serious.length > toVerify.length) log(`${b.key}: ${serious.length - toVerify.length} medium/high finding(s) beyond the cap of ${PER_BATCH_CAP} were NOT verified; they are returned as unverified`)
    const verified = await parallel(
      toVerify.map((f) => () =>
        agent(refutePrompt(f), { label: `verify:${b.key}:${f.route}`, phase: 'Verify', schema: VERDICT, model: 'opus' }).then((v) => ({ ...f, verdict: v }))),
    )
    return {
      group: b.key,
      routesReviewed: found.routesReviewed,
      routesSkipped: found.routesSkipped,
      verified: verified.filter(Boolean),
      unverified: serious.slice(PER_BATCH_CAP),
      low: found.findings.filter((f) => f.severity === 'low'),
    }
  },
)

const groups = results.filter(Boolean)
const all = groups.flatMap((r) => r.verified || [])
return {
  ref: REF,
  reviewed: files,
  changedHelpers: scope.helpers,
  confirmed: all.filter((f) => f.verdict?.verdict === 'confirmed'),
  uncertain: all.filter((f) => f.verdict?.verdict === 'uncertain'),
  refuted: all.filter((f) => f.verdict?.verdict === 'refuted').map((f) => ({ route: f.route, claim: f.claim, why: f.verdict.reasoning, line: f.verdict.decidingLine })),
  unverified: groups.flatMap((r) => r.unverified || []),
  low: groups.flatMap((r) => r.low || []),
  coverage: groups.map((r) => ({ group: r.group, reviewed: (r.routesReviewed || []).length, skipped: r.routesSkipped || [], error: r.error })),
}
