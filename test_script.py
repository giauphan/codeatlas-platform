import re

with open('src/presentation/httpServer.ts', 'r') as f:
    content = f.read()

import_cors_old = 'import cors from "cors";'
import_cors_new = 'import cors, { CorsOptions } from "cors";'
if import_cors_old in content:
    content = content.replace(import_cors_old, import_cors_new)

with open('src/presentation/httpServer.ts', 'w') as f:
    f.write(content)
