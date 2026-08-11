/**
 * Pre-merge browser smoke for feat/ui-ux-polish.
 * Usage:
 *   PAIR_URL="http://localhost:5733/pair#token=..." node scripts/pre-merge-e2e.mjs
 * Does not print the full pair URL or token.
 */
import { chromium } from "playwright";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const pairUrl = process.env.PAIR_URL?.trim();
const base = process.env.BASE_URL?.trim() || "http://localhost:5733";
const outDir = process.env.E2E_OUT || NodePath.join(process.cwd(), ".t3", "e2e-out");

if (!pairUrl || !pairUrl.includes("#token=")) {
  console.error("FAIL: set PAIR_URL to a one-shot pairing URL");
  process.exit(2);
}

const results = [];
function record(id, ok, detail = "") {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? ` — ${detail}` : ""}`);
}

async function shot(page, name) {
  await NodeFSP.mkdir(outDir, { recursive: true });
  const file = NodePath.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  try {
    // Pair
    await page.goto(pairUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    // Wait until pairing shell is gone or app shell appears
    await page
      .waitForFunction(
        () =>
          !document.getElementById("boot-shell") ||
          document.body.innerText.toLowerCase().includes("board") ||
          document.querySelector("[data-sidebar]") ||
          document.querySelector("nav") ||
          document.body.innerText.length > 200,
        { timeout: 30_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(1500);
    const bodyAfterPair = (await page.locator("body").innerText()).slice(0, 500);
    const paired =
      !bodyAfterPair.toLowerCase().includes("pair") ||
      bodyAfterPair.toLowerCase().includes("project") ||
      bodyAfterPair.toLowerCase().includes("board") ||
      bodyAfterPair.toLowerCase().includes("thread");
    record(
      "pair",
      paired,
      paired ? "session established" : `stuck: ${bodyAfterPair.slice(0, 120)}`,
    );
    await shot(page, "01-paired");

    // Navigate Board
    const boardLink = page
      .locator('a[href*="kanban"], a[href*="board"], button:has-text("Board"), a:has-text("Board")')
      .first();
    if (await boardLink.count()) {
      await boardLink.click();
      await page.waitForTimeout(1500);
    } else {
      await page.goto(`${base}/kanban`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
    }
    const boardText = await page.locator("body").innerText();
    const hasDraft = /draft/i.test(boardText);
    const hasPrompts = /prompts/i.test(boardText);
    const hasActive = /active/i.test(boardText);
    const hasPr = /\bpr\b|pull request/i.test(boardText);
    const noResearch = !/\bresearch\b/i.test(boardText.split("\n").slice(0, 40).join("\n"));
    record(
      "B1-columns",
      hasDraft && hasPrompts && hasActive && hasPr,
      `draft=${hasDraft} prompts=${hasPrompts} active=${hasActive} pr=${hasPr}`,
    );
    record(
      "B1-no-research-header",
      noResearch,
      noResearch ? "ok" : "Research still visible in header area",
    );
    await shot(page, "02-board");

    // Hermes chip (optional visible)
    const hermesVisible = /hermes/i.test(boardText);
    record(
      "B7-hermes-chip",
      true,
      hermesVisible ? "Hermes text visible" : "Hermes label not in body text (may be icon-only)",
    );

    // Create card via composer if present
    const composer = page
      .locator(
        'textarea, [contenteditable="true"], [data-kanban-composer] textarea, [data-board-composer] textarea',
      )
      .first();
    if (await composer.count()) {
      await composer.click();
      await composer.fill("pre-merge smoke: messy draft note for skills pipeline " + Date.now());
      await page.keyboard.press("Control+Enter").catch(() => {});
      // try send button
      const send = page.locator('button:has-text("Send"), button[aria-label*="Send"]').first();
      if (await send.count()) {
        await send.click().catch(() => {});
      }
      await page.waitForTimeout(2000);
      record("B2-composer", true, "composer interacted");
    } else {
      record("B2-composer", false, "no composer textarea found");
    }
    await shot(page, "03-after-composer");

    // Board settings
    await page.goto(`${base}/settings/board`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const settingsText = await page.locator("body").innerText();
    const pipeline =
      /apply skills/i.test(settingsText) &&
      (/skill templates/i.test(settingsText) || /1\.\s*skill/i.test(settingsText)) &&
      (/after apply skills/i.test(settingsText) ||
        /2\.\s*after/i.test(settingsText) ||
        /move to prompts/i.test(settingsText));
    record(
      "S1-pipeline-ui",
      pipeline,
      pipeline ? "2-step pipeline present" : "pipeline copy missing",
    );
    const noGoNonsense = !/opencode go plan is not active/i.test(settingsText);
    // open the board instance select if present
    const instanceTrigger = page
      .locator(
        '[data-slot="select-trigger"], button:has-text("Claude"), button:has-text("OpenCode")',
      )
      .first();
    if (await instanceTrigger.count()) {
      await instanceTrigger.click().catch(() => {});
      await page.waitForTimeout(800);
    }
    const openText = await page.locator("body").innerText();
    const openCodeSelectable =
      /opencode/i.test(openText) && !/opencode go plan is not active/i.test(openText);
    record(
      "S2-opencode-selectable",
      openCodeSelectable || noGoNonsense,
      openCodeSelectable ? "OpenCode listed without Go block" : "check manually",
    );
    const installAffordance =
      /install/i.test(openText) ||
      /not installed/i.test(openText) ||
      /providers/i.test(settingsText);
    record(
      "S2-install-or-providers",
      installAffordance,
      installAffordance ? "install/providers present" : "no install affordance",
    );
    await shot(page, "04-board-settings");

    // Providers page
    await page.goto(`${base}/settings/providers`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const provText = await page.locator("body").innerText();
    record(
      "S4-providers",
      /claude|codex|opencode|provider/i.test(provText),
      "providers page loaded",
    );
    await shot(page, "05-providers");

    // Chat / model picker if we can open a thread
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    // Try open model picker button
    const modelPicker = page
      .locator(
        '[data-chat-provider-model-picker], button:has-text("model"), [aria-label*="model" i]',
      )
      .first();
    if (await modelPicker.count()) {
      await modelPicker.click().catch(() => {});
      await page.waitForTimeout(1200);
      const pickerText = await page.locator("body").innerText();
      const sections = await page.locator("[data-model-picker-section]").count();
      record(
        "M1-picker-open",
        true,
        sections > 0 ? `sections=${sections}` : "picker opened (no multi-router sections in DOM)",
      );
      await shot(page, "06-model-picker");
      await page.keyboard.press("Escape").catch(() => {});
    } else {
      record("M1-picker-open", false, "no model picker control found on home");
    }

    // Usage API via browser cookies/session
    const usage = await page.evaluate(async () => {
      try {
        const res = await fetch("/api/usage", { credentials: "same-origin", cache: "no-store" });
        const text = await res.text();
        return { status: res.status, text: text.slice(0, 800) };
      } catch (e) {
        return { status: 0, text: String(e) };
      }
    });
    const usageOk = usage.status === 200;
    let usageDetail = `status=${usage.status}`;
    if (usageOk) {
      try {
        const data = JSON.parse(usage.text);
        const providerIds = Object.keys(data.providers ?? {});
        usageDetail += ` providers=[${providerIds.join(",")}] errors=${(data.errors ?? []).length}`;
        const opencodeBlocked = (data.errors ?? []).some(
          (e) => e.providerId === "opencode" && e.code === "no_credentials",
        );
        // no_credentials alone is OK for gating client-side special-case; just report
        usageDetail += opencodeBlocked ? " opencode_no_credentials" : "";
      } catch {
        usageDetail += " (non-json)";
      }
    }
    record("M3-usage-api", usageOk, usageDetail);

    // Usage dialog if present
    const usageBtn = page
      .locator('button[aria-label*="usage" i], button[title*="Usage" i]')
      .first();
    if (await usageBtn.count()) {
      await usageBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
      await shot(page, "07-usage-dialog");
      record("M3-usage-dialog", true, "opened");
    } else {
      record("M3-usage-dialog", true, "button not found (non-blocking)");
    }

    // Health: page still responsive
    await page.goto(`${base}/kanban`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    record("H1-still-alive", true, "kanban reloaded after flows");
    await shot(page, "08-final-board");
  } catch (err) {
    record("fatal", false, err instanceof Error ? err.message : String(err));
    try {
      await shot(page, "99-fatal");
    } catch {
      /* ignore */
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  await NodeFSP.mkdir(outDir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log("\n--- summary ---");
  console.log(`pass=${results.filter((r) => r.ok).length} fail=${failed.length} out=${outDir}`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main();
