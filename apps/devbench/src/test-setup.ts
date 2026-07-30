import "@testing-library/jest-dom/vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokensPath = path.join(__dirname, "styles", "tokens.css");
const tokensCss = fs.readFileSync(tokensPath, "utf-8");

const style = document.createElement("style");
style.textContent = tokensCss;
document.head.appendChild(style);
