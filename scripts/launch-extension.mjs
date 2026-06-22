#!/usr/bin/env node
/**
 * Launch Chrome with SuperSearch from dist/supersearch and reload any existing
 * unpacked copy on chrome://extensions (developer workflow).
 */
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const EXT_PATH = path.join(ROOT, "dist", "supersearch");
const PROFILE_DIR = path.join(ROOT, ".playwright-chrome-profile");

function assertBuild() {
  const manifest = path.join(EXT_PATH, "manifest.json");
  if (!fs.existsSync(manifest)) {
    console.error("Extension build missing. Run: ./scripts/build.sh");
    process.exit(1);
  }
}

async function enableDevMode(page) {
  const toggle = page.locator("extensions-manager").locator("#devMode");
  if (await toggle.count()) {
    const pressed = await toggle.getAttribute("aria-pressed");
    if (pressed !== "true") await toggle.click();
    return;
  }
  const fallback = page.getByRole("button", { name: /developer mode/i });
  if (await fallback.count()) {
    const pressed = await fallback.getAttribute("aria-pressed");
    if (pressed !== "true") await fallback.click();
  }
}

async function reloadExistingExtension(page) {
  await page.goto("chrome://extensions");
  await page.waitForTimeout(500);
  await enableDevMode(page);

  const items = page.locator("extensions-item");
  const count = await items.count();
  let reloaded = 0;

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const text = (await item.innerText()).toLowerCase();
    if (!text.includes("supersearch")) continue;

    const reload = item.locator("#reloadButton, cr-icon-button#reloadButton, [id='reloadButton']");
    if (await reload.count()) {
      await reload.first().click();
      reloaded++;
    }
  }

  return reloaded;
}

async function verifyExtensionLoaded(page) {
  await page.goto("chrome://extensions");
  await page.waitForTimeout(800);
  await enableDevMode(page);

  const items = page.locator("extensions-item");
  const count = await items.count();
  for (let i = 0; i < count; i++) {
    const text = await items.nth(i).innerText();
    if (text.toLowerCase().includes("supersearch")) return true;
  }
  return false;
}

async function openFindOnPage(page) {
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        code: "KeyF",
        metaKey: true,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });
}

async function verifyOnTestPage(page) {
  await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);

  await openFindOnPage(page);
  await page.waitForTimeout(600);

  const afterOpen = await page.evaluate(() => ({
    hasPanel: !!document.getElementById("super-search-panel"),
    panelOpen: document.getElementById("super-search-panel")?.classList.contains("open") ?? false,
  }));

  return afterOpen;
}

async function main() {
  assertBuild();

  console.log("Extension path:", EXT_PATH);
  console.log("Chrome profile:", PROFILE_DIR);

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });
  } catch (err) {
    if (String(err).includes("profile is already in use")) {
      console.error("\nChrome profile is already open. Close the SuperSearch Playwright Chrome window, then run again.");
      console.error("Or run: pkill -f '.playwright-chrome-profile'\n");
    }
    throw err;
  }

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    const reloaded = await reloadExistingExtension(page);
    console.log(reloaded ? `Reloaded ${reloaded} existing SuperSearch extension(s).` : "No existing SuperSearch card to reload (loaded via --load-extension).");

    const loaded = await verifyExtensionLoaded(page);
    if (!loaded) {
      throw new Error("SuperSearch not listed on chrome://extensions — check dist/supersearch and Chrome launch args.");
    }
    console.log("SuperSearch extension is loaded in Chrome.");

    const result = await verifyOnTestPage(page);
    console.log("Verification:", result);

    if (!result.panelOpen) {
      console.warn("Warning: find panel did not open on example.com. Check overrideNativeFind in options.");
    } else {
      console.log("SuperSearch is active. Use Cmd/Ctrl+F on any tab.");
    }

    console.log("Chrome left open for manual testing. Close the window or press Ctrl+C here.");
    await new Promise(() => {});
  } catch (err) {
    console.error(err);
    await context.close();
    process.exit(1);
  }
}

main();
