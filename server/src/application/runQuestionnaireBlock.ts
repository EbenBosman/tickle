/**
 * Questionnaire block — answer every form input on the page.
 *
 * Three-stage pipeline:
 *   1. Deterministic DOM scan to catalogue every input (`scanForm`).
 *   2. Vision pass that lets the LLM correct DOM-derived question text
 *      against the screenshot (DOM scrapers often capture option labels
 *      instead of the question above them).
 *   3. Per-question stateless answer + per-action verification (DOM
 *      check first, visual LLM fallback for weird widgets).
 */

import { scanForm, checkQuestionAnswered, type FormQuestion } from "../formScan.ts";
import { awaitIfPaused } from "../pause.ts";
import { toolDefs } from "../tools.ts";
import { trace } from "../log.ts";
import type { BlockOutcome } from "../blockOutcome.ts";
import type { ExecCtx } from "./execCtx.ts";
import { runStatelessStep, runVerifyBlock } from "./runStatelessStep.ts";

export async function runQuestionnaireBlock(
  ctx: ExecCtx,
  blockId: string,
  contextHint: string | undefined,
  unansweredVarName: string,
): Promise<BlockOutcome> {
  // 1. DOM pass — deterministic catalogue of every input.
  let scan;
  try {
    scan = await scanForm(ctx.session);
  } catch (err) {
    return { status: "failed", error: `Form scan failed: ${(err as Error).message}` };
  }

  if (scan.questions.length === 0) {
    return { status: "failed", error: "No form inputs detected on this page." };
  }

  trace("questionnaire.scan", {
    runId: ctx.runId,
    questions: scan.questions.length,
    inputs: scan.input_count,
  });
  // Diagnostic: log every question + its tagged inputs so we can see exactly
  // what the model was told. Critical for diagnosing wrong-element clicks.
  for (let qi = 0; qi < scan.questions.length; qi++) {
    const q = scan.questions[qi];
    trace("questionnaire.question", {
      runId: ctx.runId,
      q_index: qi + 1,
      kind: q.kind,
      question: q.question.slice(0, 200),
      inputs: q.inputs.map((inp) => ({
        id: inp.tickle_id,
        type: inp.type,
        option: inp.option?.slice(0, 100),
      })),
    });
  }

  // Anchor URL — if the agent's actions navigate us away from the form, the
  // formScan ids are dead and continuing would spiral. Bail cleanly instead.
  const anchorUrl = ctx.session.page.url();

  // 2. Vision pass — let the AI enrich question text where the DOM scan
  //    couldn't infer it (long instruction paragraphs above grouped inputs).
  if (ctx.isRescueRequested()) {
    ctx.clearRescueRequest();
    return { status: "failed", error: "User requested rescue" };
  }
  const enriched = await enrichQuestionsWithVision(ctx, blockId, scan.questions, contextHint);
  if (ctx.isRescueRequested()) {
    ctx.clearRescueRequest();
    return { status: "failed", error: "User requested rescue" };
  }

  ctx.emit({
    kind: "remember",
    note: `Questionnaire has ${enriched.length} questions, ${scan.input_count} inputs total.`,
  });
  ctx.memory.push(
    `Questionnaire has ${enriched.length} questions across ${scan.input_count} inputs.`,
  );

  // 3. Per-question loop — each question is one stateless answer + one stateless verify.
  const unanswered: { question: string; reason: string }[] = [];
  for (let i = 0; i < enriched.length; i++) {
    if (ctx.isRescueRequested()) {
      ctx.clearRescueRequest();
      return { status: "failed", error: "User requested rescue" };
    }
    if (ctx.isCancelled()) return { status: "cancelled" };
    await awaitIfPaused(ctx.runId);
    if (ctx.isCancelled()) return { status: "cancelled" };

    const q = enriched[i];
    const validIds = q.inputs.map((inp) => inp.tickle_id);
    const idsList = q.inputs
      .map(
        (inp) =>
          `[${inp.tickle_id}] ${inp.type}${inp.option ? ` "${inp.option}"` : ""}${inp.checked ? " (checked)" : ""}${inp.current_value ? ` = "${inp.current_value.slice(0, 40)}"` : ""}`,
      )
      .join("\n");
    const stateExtra = `QUESTION ${i + 1} OF ${enriched.length} (${q.kind}):\n${q.question}\n\nINPUTS FOR THIS QUESTION (you may ONLY click ids in this list — any other id is invalid and will be refused):\n${idsList}\n\nVALID IDS for act(): [${validIds.join(", ")}]`;

    const answer = await runStatelessStep(ctx, {
      blockId,
      task: `Answer the question above by calling act() with EXACTLY ONE of the valid ids listed above (${validIds.join(", ")}). ${contextHint ? "Context: " + contextHint + ". " : ""}Action should be: click for radio/checkbox, fill for text/textarea, select_option for select. If you don't know the answer or none of the listed ids fit, call done(success=false, note=<why>) — do NOT guess and do NOT click any other element on the page. Do not submit any form.`,
      includeSnapshot: false, // we already pass the question + ids in stateExtra
      includeScreenshot: true,
      stateExtra,
      allowedActIds: validIds,
      extraTools: [toolDefs.find((t) => t.function.name === "act")],
      doneOutputHint: "Call done(success=true) if you answered, success=false if you skipped.",
    });

    if (!answer.success) {
      unanswered.push({ question: q.question, reason: answer.note ?? "model declined to answer" });
      continue;
    }

    // Detect navigation away from the form — once we're off-page, the
    // remaining formScan ids are invalid, so continuing is pointless.
    const currentUrl = ctx.session.page.url();
    if (currentUrl !== anchorUrl) {
      // Mark this question as the cause and bail with the rest unanswered.
      unanswered.push({
        question: q.question,
        reason: `act on this question's input navigated to ${currentUrl} (expected to stay on ${anchorUrl}). The form scan's element ids are now invalid — halting.`,
      });
      for (let j = i + 1; j < enriched.length; j++) {
        unanswered.push({
          question: enriched[j].question,
          reason: "skipped — page navigated away after a previous question",
        });
      }
      break;
    }

    // 4. Deterministic per-action verification. Look at the actual DOM state
    //    for this question's inputs — far more reliable than asking the LLM
    //    "is this answered?" and ~30-60s faster per question.
    const ids = q.inputs.map((inp) => inp.tickle_id);
    let domCheck;
    try {
      domCheck = await checkQuestionAnswered(ctx.session, ids);
    } catch (err) {
      domCheck = {
        answered: false,
        hits: [],
        reason: `dom check threw: ${(err as Error).message}`,
      };
    }
    trace("questionnaire.verify_dom", {
      runId: ctx.runId,
      question_index: i + 1,
      answered: domCheck.answered,
      hits: domCheck.hits.length,
    });

    if (domCheck.answered) {
      // Confirmed via DOM — no LLM verify needed.
      continue;
    }

    // DOM check says "not answered" — could be a custom input the deterministic
    // check missed, or the click genuinely didn't take. Fall back to a visual-only
    // LLM verify so we don't false-negative on weird widgets.
    const ver = await runVerifyBlock(
      ctx,
      blockId,
      `Question ${i + 1} ("${q.question.slice(0, 100)}") now has a visible selected/filled answer on the page.`,
      true,
    );
    if (!ver.pass) {
      unanswered.push({
        question: q.question,
        reason: `not answered: ${domCheck.reason}; verify also said: ${ver.reason || "no answer detected"}`,
      });
    }
  }

  ctx.vars.set(unansweredVarName, unanswered);
  ctx.emit({
    kind: "var_set",
    name: unansweredVarName,
    preview: unanswered.length === 0 ? "(empty — all answered)" : `${unanswered.length} unanswered`,
  });
  ctx.persist("var_set", {
    name: unansweredVarName,
    preview: `${unanswered.length} unanswered`,
    unanswered,
  });

  if (unanswered.length === 0) {
    return {
      status: "done",
      summary: `Answered all ${enriched.length} questions.`,
      details: { unanswered: [], total: enriched.length },
    };
  }
  return {
    status: "done",
    summary: `Answered ${enriched.length - unanswered.length}/${enriched.length}; ${unanswered.length} need review (see $${unansweredVarName})`,
    details: { unanswered, total: enriched.length },
  };
}

async function enrichQuestionsWithVision(
  ctx: ExecCtx,
  blockId: string,
  questions: FormQuestion[],
  contextHint: string | undefined,
): Promise<FormQuestion[]> {
  // Build a compact text view of all questions so the AI can refine question wording in one pass.
  const scanSummary = questions
    .map(
      (q, i) =>
        `Q${i + 1} (${q.kind}, ${q.inputs.length} input${q.inputs.length === 1 ? "" : "s"}):\nDOM-guessed text: ${q.question.slice(0, 240)}\nInputs: ${q.inputs.map((inp) => `[${inp.tickle_id}] ${inp.type}${inp.option ? ` "${inp.option}"` : ""}`).join("; ")}`,
    )
    .join("\n\n");

  const out = await runStatelessStep(ctx, {
    blockId,
    task: `Below is a DOM-derived list of every form question on the current page. The DOM scan often grabs the WRONG text — typically it captures the option labels (e.g. "Yes please / Not for me", "Agree / Disagree") instead of the actual question that sits ABOVE those options. Cross-reference against the screenshot.

For EACH question whose DOM-derived text:
  • Looks like option labels (yes/no, agree/disagree, opt-in/opt-out, true/false, multiple short phrases joined by newlines)
  • Is clearly truncated or missing the actual question
  • Doesn't end with a "?" but the inputs are clearly answering a question
…find the real question wording on the screenshot above those inputs and return it.

Return a JSON array via done(output=[{"index": <Q-number>, "question": "<corrected text>"}, ...]). Omit only questions whose DOM text already looks like a complete, well-formed question. When in doubt, INCLUDE the correction. ${contextHint ? "Context: " + contextHint : ""}`,
    includeSnapshot: false,
    includeScreenshot: true,
    stateExtra: `DOM-DERIVED QUESTION LIST:\n\n${scanSummary}`,
    doneOutputHint:
      'Return JSON like [{"index": 1, "question": "..."}, ...] or [] if all DOM-guessed texts look correct.',
  });

  if (!out.success || !Array.isArray(out.output)) return questions;

  const enriched = questions.map((q) => ({ ...q }));
  for (const fix of out.output as { index?: number; question?: string }[]) {
    if (typeof fix.index === "number" && typeof fix.question === "string") {
      const idx = fix.index - 1;
      if (idx >= 0 && idx < enriched.length) {
        enriched[idx] = { ...enriched[idx], question: fix.question.slice(0, 400) };
      }
    }
  }
  return enriched;
}
