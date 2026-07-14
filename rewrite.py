import re

with open("scripts/db-init.ts", "r") as f:
    content = f.read()

# Replace the check variable name and add back the fallback
old_check = """      if (col) {
        // VECTOR(4096, FLOAT32) is typically 16384 bytes long
        const isCorrectDim = col.DATA_LENGTH === 16384;

        if (!isCorrectDim) {
          console.log(`   ⚠️ Vector dim mismatch (${logName}): expected length ~16384 bytes, got ${col.DATA_LENGTH} bytes. Auto-fixing...`);"""

new_check = """      if (col) {
        // VECTOR(4096, FLOAT32) is typically 16384 bytes long
        const dataLength = col.DATA_LENGTH || 0;
        const isCorrectLength = dataLength === 16384;

        if (!isCorrectLength) {
          console.log(`   ⚠️ Vector dim mismatch (${logName}): expected length ~16384 bytes, got ${dataLength} bytes. Auto-fixing...`);"""

content = content.replace(old_check, new_check)

with open("scripts/db-init.ts", "w") as f:
    f.write(content)
