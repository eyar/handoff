import { test } from "node:test";
import assert from "node:assert/strict";
import { extensionStoreUrl } from "../public/modules/extensionBridge.js";

const CHROME = "https://chromewebstore.google.com/detail/jmjapgakklfhafbgheccblmkhnmbmnkd";
const EDGE = "https://microsoftedge.microsoft.com/addons/detail/glgcblooikklbddfhfdelcimhpaieahp";

const brands = (...names) => ({ brands: names.map((brand) => ({ brand, version: "130" })) });

test("Edge links to Edge Add-ons", () => {
  assert.equal(extensionStoreUrl({ userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0" }), EDGE);
  assert.equal(extensionStoreUrl({ userAgent: "", userAgentData: brands("Chromium", "Microsoft Edge") }), EDGE);
});

test("Chrome and other Chromium browsers link to the Chrome Web Store", () => {
  assert.equal(extensionStoreUrl({ userAgent: "Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36" }), CHROME);
  assert.equal(extensionStoreUrl({ userAgent: "", userAgentData: brands("Chromium", "Brave") }), CHROME);
});

test("Firefox and Safari get no link", () => {
  assert.equal(extensionStoreUrl({ userAgent: "Mozilla/5.0 (Macintosh; rv:131.0) Gecko/20100101 Firefox/131.0" }), null);
  assert.equal(extensionStoreUrl({ userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15" }), null);
});
