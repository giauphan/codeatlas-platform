file = "src/presentation/mcpTools.ts"
with open(file, "r") as f:
    content = f.read()
# Let's fix line 12.
content = content.replace("  fileExists,\n} from \"../services/projectService.js\";\nimport { loadAnalysisAsync, AnalysisResultLocal   fileExists,\n} from \"../services/projectService.js\";", "  fileExists,\n} from \"../services/projectService.js\";\nimport { loadAnalysisAsync, AnalysisResultLocal } from \"../services/projectService.js\";")
with open(file, "w") as f:
    f.write(content)
