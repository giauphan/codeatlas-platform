file = "src/presentation/mcpTools.ts"
with open(file, "r") as f:
    content = f.read()

import re
content = re.sub(r'import \{\n  discoverProjectsAsync,\n  fileExists,\n  getStats,\n  fileExists,\n\} from "../services/projectService.js";', 'import {\n  discoverProjectsAsync,\n  fileExists,\n  getStats,\n} from "../services/projectService.js";', content)

content = re.sub(r'import \{ loadAnalysisAsync, AnalysisResultLocal   fileExists,\n\} from "../services/projectService.js";', 'import { loadAnalysisAsync, AnalysisResultLocal } from "../services/projectService.js";', content)

with open(file, "w") as f:
    f.write(content)
