// Rooktest FoodSource / Restpartijbeurs. Adres via SMOKE_URL, bijv. https://restpartijbeurs.netlify.app
import { defineConfig } from "@playwright/test";
const url = (process.env.SMOKE_URL || "").replace(/\/+$/, "");
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,               // één tegelijk: geen last van limieten op inlogpogingen
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: url,
    browserName: "chromium",
    locale: "nl-NL",
    timezoneId: "Europe/Amsterdam",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
