import re

with open('src/services/genomeService.ts', 'r') as f:
    content = f.read()

# Fix mutateGene
def replace_mutate(match):
    return """const safeUpdates = updates.filter(u => ALLOWED_MUTATE_UPDATES.has(u));
      if (safeUpdates.length === 0) return geneId; // Return since the return type is Promise<string>
"""

content = re.sub(
    r'const safeUpdates = updates\.filter\(u => ALLOWED_MUTATE_UPDATES\.has\(u\)\);',
    replace_mutate,
    content,
    count=1
)

# Fix updateGene
def replace_update(match):
    return """const safeSets = sets.filter(s => ALLOWED_UPDATE_SETS.has(s));
      if (safeSets.length === 0) return;"""

content = re.sub(
    r'const safeSets = sets\.filter\(s => ALLOWED_UPDATE_SETS\.has\(s\)\);',
    replace_update,
    content,
    count=1
)


with open('src/services/genomeService.ts', 'w') as f:
    f.write(content)
