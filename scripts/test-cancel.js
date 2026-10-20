import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(os.tmpdir(), "handoff-e2e");
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
const BASE_URL = "http://localhost:3000";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function testCancel() {
  console.log("🚀 Testing upload cancellation with system Google Chrome...");

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto(BASE_URL, { waitUntil: "networkidle0" });

    // Start handoff
    const startBtn = await page.waitForSelector("#create-room");
    await startBtn.click();
    await page.waitForSelector("#desktop-dropzone");

    // Drop a file
    console.log("📍 Dropping test file...");
    await page.evaluate(() => {
      const content = "A".repeat(5 * 1024 * 1024); // 5 MB
      const file = new File([content], "cancel-test.bin", { type: "application/octet-stream" });
      const dt = new DataTransfer();
      dt.items.add(file);

      const dropzone = document.querySelector("#desktop-dropzone");
      dropzone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });

    // Check UI while uploading
    await sleep(200);

    const checkDuringUpload = await page.evaluate(() => {
      const summaryRow = document.querySelector(".staged-summary");
      const summaryText = summaryRow?.textContent || "";
      const clearAllBtn = summaryRow?.querySelector(".link-btn-danger, .staged-clear-all-btn, button");
      const cancelBtn = document.querySelector("#desktop-file-cancel");
      const progressContainer = document.querySelector("#desktop-file-progress-container");

      return {
        summaryText,
        hasDuplicateButtonInSummary: Boolean(clearAllBtn),
        progressVisible: Boolean(progressContainer && !progressContainer.classList.contains("hidden")),
        cancelBtnVisible: Boolean(cancelBtn)
      };
    });

    console.log("  ✓ During upload inspection:", checkDuringUpload);
    if (checkDuringUpload.hasDuplicateButtonInSummary) {
      throw new Error("Duplicate button found in summary row during upload!");
    }
    if (!checkDuringUpload.cancelBtnVisible) {
      throw new Error("Red cancel button is not visible!");
    }

    // Screenshot during upload
    const uploadingScreenshot = path.join(ARTIFACT_DIR, "chrome-cancel-1-uploading.png");
    await page.screenshot({ path: uploadingScreenshot });
    console.log("  📸 Saved during-upload screenshot:", uploadingScreenshot);

    // Click the red cancel button!
    console.log("📍 Clicking red Cancel button (#desktop-file-cancel)...");
    const cancelBtn = await page.$("#desktop-file-cancel");
    await cancelBtn.click();

    await sleep(400);

    // Verify cancelled state
    const checkAfterCancel = await page.evaluate(() => {
      const progressContainer = document.querySelector("#desktop-file-progress-container");
      const previewList = document.querySelector("#desktop-file-preview-list");
      const statusEl = document.querySelector("#desktop-file-status");
      const dropzone = document.querySelector("#desktop-dropzone");

      return {
        progressHidden: Boolean(progressContainer && progressContainer.classList.contains("hidden")),
        previewHidden: Boolean(previewList && previewList.classList.contains("hidden")),
        statusText: statusEl?.textContent || "",
        dropzoneReady: Boolean(dropzone && !dropzone.classList.contains("is-uploading"))
      };
    });

    console.log("  ✓ After cancel inspection:", checkAfterCancel);

    if (!checkAfterCancel.progressHidden) {
      throw new Error("Progress bar should be hidden after cancel!");
    }
    if (!checkAfterCancel.previewHidden) {
      throw new Error("File preview list should be hidden after cancel!");
    }
    if (!checkAfterCancel.statusText.includes("Upload cancelled")) {
      throw new Error(`Expected 'Upload cancelled.', got: '${checkAfterCancel.statusText}'`);
    }

    // Screenshot after cancel
    const cancelledScreenshot = path.join(ARTIFACT_DIR, "chrome-cancel-2-cancelled.png");
    await page.screenshot({ path: cancelledScreenshot });
    console.log("  📸 Saved after-cancel screenshot:", cancelledScreenshot);

    console.log("\n🎉 TEST PASSED! Red cancel button works and duplicate button removed.");
  } finally {
    await browser.close();
  }
}

testCancel().catch((err) => {
  console.error("❌ Test Failed:", err);
  process.exit(1);
});
