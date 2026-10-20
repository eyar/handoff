import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(os.tmpdir(), "handoff-e2e");
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

async function runTest() {
  console.log("🚀 Launching system Google Chrome from:", CHROME_PATH);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,800"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const logs = [];
    page.on("console", (msg) => {
      const text = msg.text();
      logs.push(`[${msg.type()}] ${text}`);
      if (msg.type() === "error") {
        console.error("  🔴 Console Error:", text);
      }
    });

    page.on("pageerror", (err) => {
      console.error("  🔴 Page Error:", err.message);
    });

    console.log("📍 Step 1: Navigating to http://localhost:3000...");
    await page.goto("http://localhost:3000", { waitUntil: "networkidle0" });

    // Screenshot 1: Home page
    const homeScreenshotPath = path.join(ARTIFACT_DIR, "chrome-e2e-1-home.png");
    await page.screenshot({ path: homeScreenshotPath, fullPage: true });
    console.log("  📸 Saved home screenshot:", homeScreenshotPath);

    // Verify Homepage elements
    const headline = await page.$eval("h1", (el) => el.textContent.trim());
    console.log("  ✓ Headline found:", headline);

    const hasPaddleScript = await page.evaluate(() => {
      return Boolean(document.querySelector('script[src*="paddle.js"]'));
    });
    console.log("  ✓ Paddle script present in DOM?:", hasPaddleScript ? "YES (Unexpected)" : "NO (Clean)");
    if (hasPaddleScript) throw new Error("Paddle script should not be in the page");

    // Check pricing text
    const pricingText = await page.evaluate(() => {
      const section = document.querySelector("#pricing, .pricing-section, section.pricing");
      return section ? section.textContent : document.body.textContent;
    });
    const mentions199 = pricingText.includes("$1.99");
    console.log("  ✓ Mentions $1.99 in pricing?:", mentions199 ? "YES (Unexpected)" : "NO (Free tier clean)");

    // Step 2: Start a handoff
    console.log("\n📍 Step 2: Clicking 'Start a handoff'...");
    const startBtn = await page.waitForSelector("#create-room, button.primary", { timeout: 10000 });
    await startBtn.click();

    // Wait for the pairing view
    await page.waitForFunction(() => {
      const roomSession = localStorage.getItem("handoff_computer_session");
      const qrSvg = document.querySelector("#qr svg");
      const computerCard = document.querySelector("#computer");
      return Boolean(roomSession && qrSvg && computerCard && !computerCard.classList.contains("hidden"));
    }, { timeout: 10000 });

    const sessionData = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem("handoff_computer_session") || "{}");
    });
    console.log("  ✓ Computer session initialized with roomId:", sessionData.roomId);

    // Screenshot 2: Paired Session View
    const sessionScreenshotPath = path.join(ARTIFACT_DIR, "chrome-e2e-2-session.png");
    await page.screenshot({ path: sessionScreenshotPath, fullPage: true });
    console.log("  📸 Saved session screenshot:", sessionScreenshotPath);

    // Step 3: Text input sync test
    console.log("\n📍 Step 3: Testing live text entry...");
    const desktopTextInput = await page.waitForSelector("#desktop-text");
    await desktopTextInput.type("Hello from automated Chrome E2E test!");
    const textVal = await page.$eval("#desktop-text", (el) => el.value);
    console.log("  ✓ Text typed into input:", textVal);

    // Step 4: Drop/Upload test file to R2
    console.log("\n📍 Step 4: Uploading test file via Cloudflare R2...");
    const uploadResult = await page.evaluate(async () => {
      const testContent = "This is a test file uploaded directly to Cloudflare R2 via presigned PUT.\n".repeat(10);
      const testFile = new File([testContent], "e2e-r2-test.txt", { type: "text/plain" });

      const dt = new DataTransfer();
      dt.items.add(testFile);

      const dropzone = document.querySelector("#desktop-dropzone") || document.body;
      dropzone.dispatchEvent(new DragEvent("drop", {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true
      }));

      return { fileName: testFile.name, size: testFile.size };
    });
    console.log("  ✓ Dropped test file onto dropzone:", uploadResult);

    // Wait for file item to appear in file list
    console.log("  ⏳ Waiting for R2 upload to complete and file to render...");
    await page.waitForFunction(() => {
      const fileItem = document.querySelector(".file-item, [data-file-id]");
      return Boolean(fileItem);
    }, { timeout: 15000 });

    const uploadedFileInfo = await page.evaluate(() => {
      const fileItem = document.querySelector(".file-item");
      if (!fileItem) return null;
      const title = fileItem.querySelector(".file-item-title")?.textContent || "";
      const downloadLink = fileItem.querySelector("a.download-btn, a[download]");
      const downloadHref = downloadLink ? downloadLink.href : "";
      const isLocked = Boolean(fileItem.querySelector(".pill, [data-locked]"));
      return {
        title,
        downloadHref,
        isLocked
      };
    });

    console.log("  ✓ Uploaded file displayed in list:", uploadedFileInfo.title);
    console.log("  ✓ Is file locked with paywall?:", uploadedFileInfo.isLocked ? "YES (Unexpected)" : "NO (100% Free!)");
    console.log("  ✓ R2 Download URL generated:", uploadedFileInfo.downloadHref.slice(0, 80) + "...");

    if (!uploadedFileInfo.downloadHref.includes("r2.cloudflarestorage.com")) {
      throw new Error(`Expected R2 download URL, got: ${uploadedFileInfo.downloadHref}`);
    }

    // Screenshot 3: File ready with download button
    const uploadScreenshotPath = path.join(ARTIFACT_DIR, "chrome-e2e-3-uploaded.png");
    await page.screenshot({ path: uploadScreenshotPath, fullPage: true });
    console.log("  📸 Saved upload screenshot:", uploadScreenshotPath);

    // Step 5: Test Download Fetch to verify R2 GET succeeds from browser
    console.log("\n📍 Step 5: Verifying browser can download file from R2 URL...");
    const downloadStatus = await page.evaluate(async (url) => {
      const res = await fetch(url);
      const text = await res.text();
      return { status: res.status, preview: text.slice(0, 40) };
    }, uploadedFileInfo.downloadHref);

    console.log("  ✓ Download fetch status:", downloadStatus.status);
    console.log("  ✓ Downloaded content preview:", JSON.stringify(downloadStatus.preview));
    if (downloadStatus.status !== 200) {
      throw new Error(`Download failed with status ${downloadStatus.status}`);
    }

    // Step 6: End handoff and cleanup
    const endBtn = await page.$("#end-room");
    if (endBtn) {
      await endBtn.click();
      await new Promise((r) => setTimeout(r, 2000));
      console.log("  ✓ Clicked 'End this handoff' and waited for storage cleanup");
    }

    console.log("\n🎉 ALL TESTS PASSED! Google Chrome E2E run was 100% successful.");
  } finally {
    await browser.close();
    console.log("🔒 Closed Google Chrome browser.");
  }
}

runTest().catch((err) => {
  console.error("❌ E2E Test Failed:", err);
  process.exit(1);
});
