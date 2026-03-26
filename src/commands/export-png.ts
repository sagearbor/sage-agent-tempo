import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * Attempt to export all .excalidraw files in a directory to PNG
 * using Playwright. If Playwright is not installed, prints
 * instructions and returns gracefully.
 */
export async function exportPng(dir: string, scale: number): Promise<void> {
  let chromium: { launch(opts?: { headless?: boolean }): Promise<any> };

  try {
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    console.log("Playwright not installed. To enable PNG export:");
    console.log("  npx playwright install chromium");
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".excalidraw"));

  if (files.length === 0) {
    console.log(`No .excalidraw files found in ${dir}`);
    return;
  }

  console.log(`Exporting ${files.length} .excalidraw file(s) to PNG...`);

  const browser = await chromium.launch({ headless: true });

  try {
    for (const file of files) {
      const filePath = join(dir, file);
      const pngPath = join(dir, basename(file, ".excalidraw") + ".png");
      const jsonContent = readFileSync(filePath, "utf-8");

      const page = await browser.newPage();

      try {
        await page.setViewportSize({
          width: 1920 * scale,
          height: 1080 * scale,
        });

        await page.goto("https://excalidraw.com", {
          waitUntil: "networkidle",
        });

        // Import the Excalidraw JSON via the app's API
        await page.evaluate((json: string) => {
          const parsed = JSON.parse(json);
          // Excalidraw exposes window.EXCALIDRAW_ASSET_PATH and the app API
          // We dispatch a load event with the scene data
          const event = new CustomEvent("loadScene", { detail: parsed });
          document.dispatchEvent(event);

          // Fallback: use the Excalidraw app instance if available
          const app = (window as any).excalidrawAPI;
          if (app && typeof app.updateScene === "function") {
            app.updateScene({
              elements: parsed.elements,
              appState: {
                ...parsed.appState,
                exportWithDarkMode: false,
              },
            });
          }
        }, jsonContent);

        // Wait for the canvas to render
        await page.waitForTimeout(3000);

        // Find and screenshot the canvas element
        const canvas = await page.$("canvas.excalidraw__canvas, canvas");

        if (canvas) {
          await canvas.screenshot({ path: pngPath, type: "png" });
          console.log(`  ${file} -> ${basename(pngPath)}`);
        } else {
          // Fallback: screenshot the full page
          await page.screenshot({ path: pngPath, type: "png", fullPage: true });
          console.log(`  ${file} -> ${basename(pngPath)} (full page fallback)`);
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log("PNG export complete.");
}
