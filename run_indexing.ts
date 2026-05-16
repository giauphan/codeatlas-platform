import { CodeAnalyzer } from "./src/analyzer/parser.js";
import * as fs from "fs";
import * as path from "path";

async function run() {
  // Tự động lấy thư mục hiện tại để chạy trên bất kỳ server nào
  const projectPath = process.cwd();
  console.log(`Starting analysis for: ${projectPath}`);
  
  const analyzer = new CodeAnalyzer(projectPath, 5000);
  const result = await analyzer.analyzeProject();

  const codeatlasDir = path.join(projectPath, ".codeatlas");
  if (!fs.existsSync(codeatlasDir)) {
    fs.mkdirSync(codeatlasDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(codeatlasDir, "analysis.json"),
    JSON.stringify(result, null, 2)
  );

  console.log("Analysis complete! Data saved to .codeatlas/analysis.json");
}

run().catch(console.error);
