import re

file = "src/services/indexingService.ts"
with open(file, "r") as f:
    content = f.read()

# I had replaced `for (let i = 0; i < links.length; i++) {` with `for (const link of links) {` but left `links[i]` in the body!
content = content.replace("for (let i = 0; i < links.length; i++) {", "for (const link of links) {")
content = content.replace("links[i].", "link.")

with open(file, "w") as f:
    f.write(content)
