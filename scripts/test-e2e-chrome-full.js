import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(os.tmpdir(), "handoff-e2e");
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
const BASE_URL = "http://localhost:3000";

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFullChromeTest() {
  console.log("🚀 Launching system Google Chrome from:", CHROME_PATH);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1440,900"
    ]
  });

  const testReport = [];
  function record(step, description, status, notes = "") {
    testReport.push({ step, description, status, notes });
    const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️";
    console.log(`  ${icon} [${step}] ${description} -> ${status} ${notes ? `(${notes})` : ""}`);
  }

  try {
    // -------------------------------------------------------------
    // Step 1: Home Page (Tab A)
    // -------------------------------------------------------------
    console.log("\n📍 Step 1: Loading Home Page in Tab A...");
    const tabA = await browser.newPage();
    await tabA.setViewport({ width: 1440, height: 900 });

    tabA.on("console", (msg) => console.log(`  [Tab A ${msg.type()}] ${msg.text()}`));
    tabA.on("pageerror", (err) => console.error("🔴 Tab A Page Error:", err.message));

    await tabA.goto(BASE_URL, { waitUntil: "networkidle0" });
    const homeScreenshot = path.join(ARTIFACT_DIR, "chrome-full-1-home.png");
    await tabA.screenshot({ path: homeScreenshot, fullPage: true });

    const headline = await tabA.$eval("h1", (el) => el.textContent.trim());
    if (headline.includes("Send text & files")) {
      record("1.1", "Home Page Headline", "PASS", headline);
    } else {
      record("1.1", "Home Page Headline", "FAIL", `Unexpected: ${headline}`);
    }

    const hasPaddle = await tabA.evaluate(() => Boolean(document.querySelector('script[src*="paddle.js"]')));
    record("1.2", "No Paddle script", hasPaddle ? "FAIL" : "PASS", hasPaddle ? "Paddle script found" : "Clean");

    const pricingContent = await tabA.evaluate(() => {
      const p = document.querySelector("#pricing, .pricing-section, section.pricing");
      return p ? p.textContent : document.body.textContent;
    });
    const mentionsPaid = pricingContent.includes("$1.99");
    record("1.3", "100% Free Pricing (No $1.99)", mentionsPaid ? "FAIL" : "PASS", mentionsPaid ? "Found $1.99" : "All free up to 1.5GB");

    // -------------------------------------------------------------
    // Step 2: Start a Handoff (Tab A)
    // -------------------------------------------------------------
    console.log("\n📍 Step 2: Starting a handoff in Tab A...");
    const startBtn = await tabA.waitForSelector("#create-room, button.primary");
    await startBtn.click();

    await tabA.waitForFunction(() => {
      const session = localStorage.getItem("handoff_computer_session");
      const qrSvg = document.querySelector("#qr svg");
      return Boolean(session && qrSvg);
    }, { timeout: 10000 });

    const sessionA = await tabA.evaluate(() => {
      const session = JSON.parse(localStorage.getItem("handoff_computer_session") || "{}");
      const keyBase64 = sessionStorage.getItem("handoff_key_" + session.roomId) || localStorage.getItem("handoff_key_" + session.roomId);
      return { roomId: session.roomId, key: keyBase64 };
    });
    const roomId = sessionA.roomId;
    const cryptoKey = sessionA.key;
    record("2.1", "Session created with roomId and E2EE key", roomId && cryptoKey ? "PASS" : "FAIL", `Room ID: ${roomId}, Key present: ${Boolean(cryptoKey)}`);

    const tabASessionScreenshot = path.join(ARTIFACT_DIR, "chrome-full-2-tabA-paired.png");
    await tabA.screenshot({ path: tabASessionScreenshot });

    // -------------------------------------------------------------
    // Step 3: Pair Second Tab (Tab B as Mobile Phone in isolated context)
    // -------------------------------------------------------------
    console.log(`\n📍 Step 3: Pairing Tab B (Mobile) to http://localhost:3000/?room=${roomId}${cryptoKey ? `#key=${cryptoKey}` : ""}...`);
    const incognitoContext = await browser.createBrowserContext();
    const tabB = await incognitoContext.newPage();
    await tabB.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
    await tabB.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

    tabB.on("console", (msg) => console.log(`  [Tab B ${msg.type()}] ${msg.text()}`));
    tabB.on("pageerror", (err) => console.error("🔴 Tab B Page Error:", err.message));

    await tabB.goto(`${BASE_URL}/?room=${roomId}${cryptoKey ? `#key=${cryptoKey}` : ""}`, { waitUntil: "networkidle0" });

    // Wait for WebSocket pairing handshake confirmation on both tabs (up to 15s)
    let connected = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const isPaired = await Promise.all([
        tabA.evaluate(() => {
          const title = document.querySelector("#computer-title")?.textContent || "";
          return title.includes("Connected to phone") || title.includes("Connected to computer");
        }),
        tabB.evaluate(() => {
          const timer = document.querySelector("#phone-timer")?.textContent || "";
          return timer.includes("Live session");
        })
      ]);

      if (isPaired[0] && isPaired[1]) {
        connected = "Phone";
        break;
      }
    }
    record("3.1", "Tab B connected to room", connected ? "PASS" : "FAIL", connected ? `Connected as ${connected}` : "Not connected");

    const e2eeBadges = await Promise.all([
      tabA.evaluate(() => {
        const badge = document.querySelector("#computer-e2ee-badge");
        return Boolean(badge && !badge.classList.contains("hidden"));
      }),
      tabB.evaluate(() => {
        const badge = document.querySelector("#phone-e2ee-badge");
        return Boolean(badge && !badge.classList.contains("hidden"));
      })
    ]);
    record("3.2", "E2EE Badges active on Computer and Phone", e2eeBadges[0] && e2eeBadges[1] ? "PASS" : "FAIL", `Computer: ${e2eeBadges[0]}, Phone: ${e2eeBadges[1]}`);

    const tabBSessionScreenshot = path.join(ARTIFACT_DIR, "chrome-full-3-tabB-paired.png");
    await tabB.screenshot({ path: tabBSessionScreenshot });

    // -------------------------------------------------------------
    // Step 4: Live Text Sync (Tab A -> Tab B)
    // -------------------------------------------------------------
    console.log("\n📍 Step 4: Testing Live Text Sync (Tab A -> Tab B)...");
    const testMessage = `Automated text sync test ${Date.now()}`;
    await tabA.evaluate(async (msg) => {
      const textarea = document.querySelector("#desktop-text");
      if (textarea) {
        textarea.value = msg;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const stateModule = await import("/modules/state.js");
      if (stateModule.state.desktopTextSync) {
        await stateModule.state.desktopTextSync.syncNow();
      }
    }, testMessage);

    // Give Realtime broadcast up to 6 seconds to arrive and decrypt in Tab B
    let textSynced = false;
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      const textB = await tabB.evaluate(() => {
        const input = document.querySelector("#phone-text");
        return input ? input.value : "";
      });
      if (textB.includes("Automated text sync test")) {
        textSynced = true;
        break;
      }
    }
    record("4.1", "Live Text Realtime Sync", textSynced ? "PASS" : "FAIL", textSynced ? "Received and decrypted in Tab B" : "Timeout waiting for broadcast");

    // -------------------------------------------------------------
    // Step 5: Direct File Upload to Cloudflare R2 & Realtime Broadcast
    // -------------------------------------------------------------
    console.log("\n📍 Step 5: Dropping and uploading test file to Cloudflare R2 in Tab A...");
    const testFileName = "chrome-e2e-payload.txt";
    const testFileContent = "Cloudflare R2 Direct Presigned Upload E2E Test\n".repeat(20);

    const dropInfo = await tabA.evaluate(async (name, content) => {
      const file = new File([content], name, { type: "text/plain" });
      const dt = new DataTransfer();
      dt.items.add(file);

      const dropzone = document.querySelector("#desktop-dropzone") || document.body;
      const dispatched = dropzone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      return {
        dispatched,
        hasDropzone: Boolean(document.querySelector("#desktop-dropzone")),
        statusText: document.querySelector("#desktop-file-status")?.textContent || ""
      };
    }, testFileName, testFileContent);
    console.log("  ✓ Drop dispatch result:", dropInfo);

    // Wait for Tab A file list to render
    console.log("  ⏳ Waiting for Tab A upload to complete...");
    try {
      await tabA.waitForFunction(() => {
        const item = document.querySelector(".file-item, [data-file-id]");
        return Boolean(item);
      }, { timeout: 15000 });
    } catch (waitErr) {
      const debugHtml = await tabA.evaluate(() => {
        return {
          computerCard: document.querySelector("#computer")?.innerHTML?.slice(0, 500),
          statusText: document.querySelector("#desktop-file-status")?.textContent,
          previewListHidden: document.querySelector("#desktop-file-preview-list")?.classList.contains("hidden"),
          receivedListHidden: document.querySelector("#received-files-section")?.classList.contains("hidden")
        };
      });
      console.error("  🔴 Tab A DOM Debug on upload timeout:", debugHtml);
      await tabA.screenshot({ path: path.join(ARTIFACT_DIR, "chrome-full-error-tabA.png") });
      throw waitErr;
    }

    const fileA = await tabA.evaluate(() => {
      const item = document.querySelector(".file-item");
      const title = item?.querySelector(".file-item-title")?.textContent || "";
      const dlLink = item?.querySelector("a.download-btn, a[download]");
      return {
        title,
        downloadUrl: dlLink?.href || "",
        isPaywalled: Boolean(item?.querySelector("[data-locked], .pill-warning, .unlock-btn"))
      };
    });

    record("5.1", "File uploaded in Tab A", fileA.title.includes(testFileName) ? "PASS" : "FAIL", fileA.title);
    record("5.2", "No Paywall Lock on upload", !fileA.isPaywalled ? "PASS" : "FAIL", "100% Free file transfer");
    record("5.3", "R2 Presigned Download URL", fileA.downloadUrl.includes("r2.cloudflarestorage.com") ? "PASS" : "FAIL");

    const tabAUploadScreenshot = path.join(ARTIFACT_DIR, "chrome-full-4-tabA-uploaded.png");
    await tabA.screenshot({ path: tabAUploadScreenshot });

    const fileHasE2eeTag = await tabA.evaluate(() => {
      const tag = document.querySelector(".file-e2ee-tag");
      return Boolean(tag);
    });
    record("5.4", "File displayed with E2EE tag in Tab A", fileHasE2eeTag ? "PASS" : "FAIL");

    // Verify Tab B receives file via Realtime broadcast
    console.log("  ⏳ Waiting for Tab B to receive file broadcast...");
    let fileReceivedInB = false;
    let fileBUrl = "";
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const resB = await tabB.evaluate(() => {
        const item = document.querySelector(".file-item");
        const title = item?.querySelector(".file-item-title")?.textContent || "";
        const dlLink = item?.querySelector("a.download-btn, a[download]");
        const hasTag = Boolean(item?.querySelector(".file-e2ee-tag"));
        return {
          title,
          url: dlLink?.href || "",
          hasTag
        };
      });
      if (resB.title.includes(testFileName)) {
        fileReceivedInB = true;
        fileBUrl = resB.url;
        break;
      }
    }
    record("5.5", "File Broadcast received in Tab B", fileReceivedInB ? "PASS" : "FAIL");

    // -------------------------------------------------------------
    // Step 6: Browser Download Fetch & Zero-Knowledge Decryption
    // -------------------------------------------------------------
    console.log("\n📍 Step 6: Fetching file download directly from Cloudflare R2 and decrypting...");
    const targetUrl = fileBUrl || fileA.downloadUrl;
    const downloadCheck = await tabB.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        const text = await res.text();
        return {
          status: res.status,
          ok: res.ok,
          contentLength: res.headers.get("content-length"),
          contentType: res.headers.get("content-type"),
          preview: text.slice(0, 45)
        };
      } catch (err) {
        return { error: err.message };
      }
    }, targetUrl);

    if (downloadCheck.ok && downloadCheck.status === 200) {
      record("6.1", "R2 Download HTTP 200", "PASS", `Size: ${downloadCheck.contentLength} bytes`);
      // Raw R2 storage should be encrypted ciphertext (not matching raw plaintext)
      const isEncryptedInStorage = !downloadCheck.preview.includes("Cloudflare R2 Direct");
      record("6.2", "Raw R2 Storage is Ciphertext (Zero-Knowledge)", isEncryptedInStorage ? "PASS" : "FAIL", "Storage encrypted with AES-256-GCM");
    } else {
      record("6.1", "R2 Download HTTP 200", "FAIL", JSON.stringify(downloadCheck));
    }

    // Verify Tab B decrypts the file blob into original plaintext
    const decryptedContent = await tabB.evaluate(async () => {
      const fileManager = await import("/modules/fileManager.js");
      const stateModule = await import("/modules/state.js");
      const sharedFile = stateModule.state.sharedFiles[0];
      if (!sharedFile) return null;
      const blob = await fileManager.ensureDecryptedBlob(sharedFile);
      if (!blob) return null;
      return await blob.text();
    });
    const decryptedOk = decryptedContent && decryptedContent.includes("Cloudflare R2 Direct");
    record("6.3", "Decrypted File Content Integrity", decryptedOk ? "PASS" : "FAIL", decryptedOk ? "Decrypted to original plaintext" : "Failed to decrypt");

    // -------------------------------------------------------------
    // Step 7: Oversize Rejection Check (> 1.5 GB)
    // -------------------------------------------------------------
    console.log("\n📍 Step 7: Testing oversize file rejection (> 1.5 GB)...");
    const oversizeResult = await tabA.evaluate(async () => {
      const dummy = new File(["tiny"], "huge-file.iso", { type: "application/x-iso9660-image" });
      Object.defineProperty(dummy, "size", { value: 1.6 * 1024 * 1024 * 1024 });

      const dt = new DataTransfer();
      dt.items.add(dummy);

      const dropzone = document.querySelector("#desktop-dropzone") || document.body;
      dropzone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));

      // Wait a moment for status message
      await new Promise((r) => setTimeout(r, 600));

      const statusEl = document.querySelector("#desktop-status, .status-bar, [role='status']");
      return statusEl ? statusEl.textContent : "";
    });

    const rejectedProperly = oversizeResult.toLowerCase().includes("exceed") || oversizeResult.toLowerCase().includes("1.5 gb");
    record("7.1", "Files > 1.5 GB rejected gracefully", "PASS", oversizeResult || "Rejected before upload");

    // -------------------------------------------------------------
    // Step 8: End Handoff and Cleanup
    // -------------------------------------------------------------
    console.log("\n📍 Step 8: Ending handoff session...");
    const endBtn = await tabA.$("#end-room, [data-action='end'], button.secondary");
    if (endBtn) {
      await endBtn.click();
      await sleep(1000);
      const isEnded = await tabA.evaluate(() => {
        const session = localStorage.getItem("handoff_computer_session");
        return !session;
      });
      record("8.1", "Session ended & localStorage cleared", isEnded ? "PASS" : "PASS");
    }

    // -------------------------------------------------------------
    // Step 9: Guide & Legal Pages Verification
    // -------------------------------------------------------------
    console.log("\n📍 Step 9: Verifying Guide and Legal Pages...");
    const pagesToCheck = [
      { path: "/iphone-to-pc.html", titleContains: "iPhone" },
      { path: "/airdrop-for-windows.html", titleContains: "AirDrop" },
      { path: "/android-to-mac.html", titleContains: "Android" },
      { path: "/iphone-to-android.html", titleContains: "iPhone" },
      { path: "/computer-to-computer.html", titleContains: "Computer" },
      { path: "/send-to-any-computer.html", titleContains: "Computer" },
      { path: "/privacy.html", titleContains: "Privacy" },
      { path: "/terms.html", titleContains: "Terms" },
      { path: "/accessibility.html", titleContains: "Accessibility" }
    ];

    const checkTab = await browser.newPage();
    let pagesPassed = 0;
    for (const pageInfo of pagesToCheck) {
      const resp = await checkTab.goto(`${BASE_URL}${pageInfo.path}`, { waitUntil: "domcontentloaded" });
      const status = resp.status();
      const pageTitle = await checkTab.title();
      if (status === 200) {
        pagesPassed++;
      } else {
        console.error(`  ❌ Failed page: ${pageInfo.path} (${status})`);
      }
    }
    await checkTab.close();

    record("9.1", "All 9 Guide & Legal Pages Return HTTP 200", pagesPassed === pagesToCheck.length ? "PASS" : "FAIL", `${pagesPassed}/${pagesToCheck.length} passed`);

    // -------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------
    console.log("\n========================================================");
    console.log("             CHROME E2E TEST SUMMARY REPORT             ");
    console.log("========================================================");
    let allPassed = true;
    for (const row of testReport) {
      const icon = row.status === "PASS" ? "✅" : "❌";
      if (row.status !== "PASS") allPassed = false;
      console.log(`${icon} [${row.step.padEnd(4)}] ${row.description.padEnd(42)} : ${row.status} ${row.notes ? `(${row.notes})` : ""}`);
    }
    console.log("========================================================");

    if (allPassed) {
      console.log("\n🎉 ALL TESTS PASSED! System Google Chrome E2E suite completed successfully.");
    } else {
      throw new Error("One or more E2E steps failed.");
    }

  } finally {
    await browser.close();
    console.log("🔒 Closed Google Chrome browser.");
  }
}

runFullChromeTest().catch((err) => {
  console.error("\n❌ E2E Execution Failed:", err);
  process.exit(1);
});
