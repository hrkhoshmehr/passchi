import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";
const file = process.argv[2], out = process.argv[3] ?? "data/out/shot.png";
const b = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const p = await b.newPage();
await p.emulateMediaType("print");
await p.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1.3 });
await p.goto(pathToFileURL(file).href, { waitUntil: "networkidle0" });
await p.evaluateHandle("document.fonts.ready");
const h = await p.evaluate(() => document.body.scrollHeight);
const pages = Math.ceil(h / 1123);
for (const i of (process.argv[4] ?? "1,3").split(",").map(Number)) {
  if (i > pages) continue;
  await p.evaluate((y) => window.scrollTo(0, y), (i - 1) * 1123);
  await p.screenshot({ path: out.replace(".png", `-${i}.png`) });
}
await b.close();
console.log("صفحات:", pages);
