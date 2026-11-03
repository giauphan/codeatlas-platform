import re
def repl(f, o, n):
    with open(f, "r") as x: c = x.read()
    c = c.replace(o, n)
    with open(f, "w") as x: x.write(c)

repl("src/services/memoryIngestionService.ts", "updated.memory_ids", "updated!.memory_ids")
repl("src/services/memoryIngestionService.ts", "result.success", "result!.success")
repl("src/services/memoryIngestionService.ts", "result.content", "result!.content")
