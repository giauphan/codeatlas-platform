import re

files = [
    "dashboard/src/components/KnowledgeGraphView.tsx",
    "dashboard/src/components/OrchestrationTasksView.tsx",
    "dashboard/src/components/SecondBrainView.tsx"
]

for file in files:
    with open(file, "r") as f:
        content = f.read()

    # Find the filter div and replace it with fieldset correctly
    content = re.sub(r'<div role="group" (aria-label="[^"]+") style={{([^}]+)}}>', r'<fieldset \1 style={{ border: "none", padding: 0, margin: 0, \2 }}>', content)

    # We replace `))} \n </div>` with `))} \n </fieldset>`
    content = re.sub(r'</button>\s*\)\)}\s*</div>', '</button>\n          ))}\n        </fieldset>', content)

    with open(file, "w") as f:
        f.write(content)
